import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
import _state
from fastapi.testclient import TestClient
from dashboard import app as dashboard, discovery, jobs, matching, store


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.client=TestClient(dashboard.app)
        with store.db() as db:
            db.execute('DELETE FROM queue');db.execute('DELETE FROM settings')
        self.profile={'skills':{'general':['Python','Customer service']}}

    def test_preferences_and_evidence_outrank_date_without_inventing_missing_facts(self):
        postings=[
            {'url':'https://example.test/new','title':'Sales manager','posted':'2026-09-07','locations':['Paris'],'description':'Excel'},
            {'url':'https://example.test/fit','title':'Backend software engineer','posted':'2026-08-25','locations':['Denver'],'description':'Python and Rust'},
            {'url':'https://example.test/unknown','title':'Backend engineer','posted':'2026-09-07','locations':[]}]
        ranked=discovery.rank(postings,self.profile,'',{'targetRoles':['Backend engineer'],'preferredLocations':['Denver']})
        self.assertTrue(ranked[0]['url'].endswith('/fit'))
        self.assertEqual(ranked[0]['fit']['coverage'],50)
        self.assertEqual(ranked[1]['fit']['coverage'],None)
        self.assertIn('Location not supplied',ranked[1]['recommendation']['unknown'])
        self.assertIn('Rust',[m['skill'] for m in ranked[0]['fit']['missing']])
        self.assertNotIn('fit',postings[0])
        newest=discovery.rank(postings,self.profile,'',{'order':'newest'})
        self.assertFalse(newest[0]['url'].endswith('/fit'))

    def test_non_catalog_candidate_skills_and_ambiguous_preferred_terms(self):
        self.assertEqual(matching.fit('Customer service required',self.profile)['coverage'],100)
        item=discovery.rank([{'url':'x','title':'Role','description':'You can go home after work.'}],{},'',{'preferredSkills':['go']})[0]
        self.assertEqual(item['recommendation']['points'],0)
        self.assertFalse(discovery.rank([{'company':'Example','title':'Staff engineer'}],{},'',{'excludedTitles':['Staff']}))
        self.assertEqual(len(discovery.rank([{'company':'Example Tools','title':'Engineer'}],{},'',{'excludedCompanies':['Example']})),1)

    def test_saved_career_titles_guide_default_order_and_explicit_career_change_overrides_them(self):
        pool=[{'url':'a','title':'Staff Product Manager','description':'Python'},
              {'url':'b','title':'Software Engineer','description':'Python and Rust'}]
        candidate={**self.profile,'experience':[{'title':'Software Engineering Intern'}]}
        self.assertEqual(discovery.rank(pool,candidate,'')[0]['url'],'b')
        self.assertTrue(discovery.role_matches('Software Developer','Software Engineering'))
        self.assertFalse(discovery.role_matches('Software Engineering Manager','Software Engineering'))
        self.assertEqual(discovery.rank(pool,candidate,'',{'targetRoles':['Product Manager']})[0]['url'],'a')

    def test_refresh_ranks_full_candidate_pool_before_limit_and_hidden_jobs_do_not_consume_slots(self):
        # This exercises ranking, not the wall-clock-dependent freshness filter.
        store.set_settings({'limit':1,'sinceDays':0,'discoveryPriorities':{'targetRoles':['Backend engineer']}})
        store.replace_queue([{'url':'https://example.test/hidden'}]);store.hide_queue_entry('https://example.test/hidden')
        pool=[{'url':'https://example.test/hidden','title':'Backend engineer','description':'Python'},
              {'url':'https://example.test/new','title':'Sales manager','posted':'2026-09-07'},
              {'url':'https://example.test/older','title':'Backend engineer','posted':'2026-08-20','description':'Python'}]
        with patch.object(dashboard.jobs,'find',return_value=pool),patch.object(dashboard,'_profile',return_value=self.profile):
            response=self.client.post('/api/queue/refresh');self.assertEqual(response.status_code,200,response.text)
            data=response.json();self.assertEqual(data['count'],1)
            self.assertTrue(data['jobs'][0]['url'].endswith('/older'))
            self.assertEqual(data['discovery']['fetchedMatches'],3)
            self.assertEqual(data['discovery']['eligible'],2)
        self.assertNotIn('fit',store.list_queue()[0]['raw'])

    def test_workday_board_urls_roundtrip_without_allowing_arbitrary_hosts(self):
        url='https://example.wd5.myworkdayjobs.com/ExampleCareerSite'
        body={'priorities':{},'sources':{'workday':[url],'github':False,'feeds':[]}}
        self.assertEqual(self.client.post('/api/discovery',json=body).status_code,200)
        self.assertEqual(self.client.get('/api/discovery').json()['sources']['workday'],
                         ['https://example.wd5.myworkdayjobs.com/en-US/ExampleCareerSite'])
        for invalid in [url+'/job/1',url+'?x=1','http://localhost/External','https://example.wd5.myworkdayjobs.com.evil.test/External']:
            body['sources']['workday']=[invalid]
            self.assertEqual(self.client.post('/api/discovery',json=body).status_code,422)

    def test_source_preferences_roundtrip_and_invalid_sources_are_rejected(self):
        body={'priorities':{'targetRoles':['Nurse']},'sources':{'greenhouse':['fixture-board'],'github':False,'feeds':[]}}
        self.assertEqual(self.client.post('/api/discovery',json=body).status_code,200)
        self.assertEqual(self.client.get('/api/discovery').json()['sources']['greenhouse'],['fixture-board'])
        body['sources']['greenhouse']=['../../secrets']
        self.assertEqual(self.client.post('/api/discovery',json=body).status_code,422)
        body['sources']['greenhouse']=[]
        self.assertEqual(self.client.post('/api/discovery',json=body).status_code,400)
        self.assertEqual(self.client.post('/api/settings',json={'values':{'limit':401}}).status_code,400)
        self.assertEqual(jobs.default_sources()['feeds'],['Remotive','Arbeitnow'])


    def test_match_score_is_normalized_and_missing_evidence_stays_unknown(self):
        pool=[{'url':'a','title':'Backend engineer','description':'Python, Docker, Linux'},
              {'url':'b','title':'Backend engineer','description':'Python, Docker, Linux and Rust'},
              {'url':'c','title':'Backend engineer','description':''}]
        result={j['url']:j for j in discovery.rank(pool,{'skills':{'general':['Python','Docker','Linux']}},'',{'targetRoles':['Backend engineer']})}
        self.assertEqual(result['a']['match']['score'],100)
        self.assertLess(result['b']['match']['score'],100)
        self.assertIsNone(result['c']['match']['score'])
        self.assertEqual(result['a']['match']['maximumPoints'],85)
        self.assertIn('Not a hiring probability',result['a']['match']['basis'])

    def test_strict_country_excludes_unknown_and_foreign_jobs(self):
        pool=[{'url':'us','title':'Engineer','locations':['US - Remote']},
              {'url':'gb','title':'Engineer','locations':['United Kingdom']},
              {'url':'unknown','title':'Engineer','locations':['Remote']},
              {'url':'world','title':'Engineer','locations':['Worldwide']}]
        ranked=discovery.rank(pool,{},'',{'workCountries':['US'],'requireListedCountry':True})
        self.assertEqual([j['url'] for j in ranked],['us'])

    def test_recent_filters_unknown_and_older_dates_and_all_time_restores(self):
        from datetime import datetime,timedelta,timezone
        now=datetime.now(timezone.utc)
        pool=[{'posted':(now-timedelta(hours=2)).isoformat()}, {'posted':(now-timedelta(days=8)).isoformat()}, {'posted':None}]
        self.assertEqual(discovery.recent(pool,7),pool[:1])
        self.assertEqual(discovery.recent(pool,30),pool[:2])
        self.assertEqual(discovery.recent(pool,0),pool)
        self.assertEqual(self.client.post('/api/settings',json={'values':{'sinceDays':-1}}).status_code,400)

if __name__=='__main__': unittest.main()
