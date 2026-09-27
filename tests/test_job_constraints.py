import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from dashboard import discovery,job_constraints as constraints


class ConstraintTests(unittest.TestCase):
    def assess(self,job,**preferences):
        return constraints.assess(job,discovery.Priorities(**preferences),{})

    def country(self,job,**preferences):
        return next(check for check in self.assess(job,workCountries=['US'],**preferences)['checks'] if check['kind']=='country')

    def test_remote_is_not_worldwide_and_mismatches_need_stated_countries(self):
        self.assertEqual(self.country({'locations':['Remote']})['status'],'unknown')
        self.assertEqual(self.country({'locations':['Remote - United Kingdom']})['status'],'mismatch')
        self.assertEqual(self.country({'locations':['Remote - USA']})['status'],'match')
        self.assertEqual(self.country({'locations':['Remote worldwide']})['status'],'match')
        self.assertEqual(self.country({'locations':['London']})['status'],'unknown')
        self.assertEqual(self.country({'locations':['US and Europe']})['status'],'match')
        result=self.assess({'locations':['US and Europe']},workCountries=['Germany'])
        self.assertEqual(result['checks'][0]['status'],'unknown')

    def test_residency_clause_does_not_use_unrelated_office_mentions(self):
        job={'locations':['Remote worldwide'],'description':'We have offices in Germany. Candidates must be based in the United States. Our customers are in Canada.'}
        self.assertEqual(self.country(job)['status'],'match')
        self.assertEqual(self.assess(job,workCountries=['CA'])['checks'][0]['status'],'mismatch')
        self.assertEqual(self.assess(job,workCountries=['CA'])['countries'],['US'])
        self.assertEqual(self.country({'locations':['Remote'],'description':'Our headquarters is in Canada.'})['status'],'unknown')
        self.assertEqual(self.country({'locations':['Remote worldwide'],'description':'Candidates must be based in Europe.'})['status'],'unknown')

    def test_country_aliases_are_global_but_ordinary_words_and_state_names_are_not_codes(self):
        prefs=discovery.Priorities(workCountries=['USA','United States','uk','de','India'])
        self.assertEqual(prefs.workCountries,['US','GB','DE','IN'])
        self.assertEqual(constraints.mentioned_countries('Join us IN IT and live in Georgia'),set())
        self.assertEqual(self.country({'countries':['IN'],'locations':['Remote']})['status'],'mismatch')
        with self.assertRaises(ValueError): discovery.Priorities(workCountries=['Atlantis'])

    def test_stage_is_title_evidence_and_unknown_professional_history_disables_inference(self):
        self.assertEqual(constraints.seniority('Staff Accountant'),None)
        self.assertEqual(constraints.seniority('Staff Software Engineer'),'staff')
        self.assertEqual(constraints.seniority('Principal Engineering Manager'),'management')
        self.assertEqual(constraints.seniority('Software Engineer'),None)
        self.assertEqual(constraints.profile_levels({'experience':[{'title':'Engineering Intern'}]}),['intern','entry'])
        self.assertEqual(constraints.profile_levels({'experience':[{'title':'Intern'},{'title':'Software Engineer'}]}),[])

    def test_hiding_excludes_only_stated_explicit_mismatches_and_retains_unknowns(self):
        jobs=[{'url':'a','title':'Senior Software Engineer','locations':['Remote - Germany']},
              {'url':'b','title':'Software Engineer','locations':['Remote']}]
        profile={'experience':[{'title':'Engineering Intern'}]}
        # Profile-derived career-stage signals alone never hide jobs.
        self.assertEqual(len(discovery.rank(jobs,profile,'',{'hideMismatches':True})),2)
        ranked=discovery.rank(jobs,profile,'',{'seniority':['entry'],'workCountries':['US'],'hideMismatches':True})
        self.assertEqual([job['url'] for job in ranked],['b'])
        self.assertEqual(discovery.rank(jobs,profile,'')[0]['url'],'b')

    def test_work_mode_uses_advertised_metadata_and_preserves_hybrid(self):
        job={'raw':{'workplaceType':'Hybrid'},'locations':['Remote available']}
        result=self.assess(job,workModes=['remote'])
        self.assertEqual(result['checks'][0]['status'],'mismatch')
        self.assertEqual(self.assess({'locations':['Berlin']},workModes=['remote'])['checks'][0]['status'],'unknown')
        self.assertEqual(self.assess({'title':'Software Engineer','employmentType':'Intern'},seniority=['intern'])['checks'][0]['status'],'match')


if __name__=='__main__': unittest.main()
