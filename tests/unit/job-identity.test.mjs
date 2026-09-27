import test from 'node:test';
import assert from 'node:assert/strict';
import {sameJob} from '../../server/dashboard/drive.mjs';
import {postingKey,dedupe,fetchBoards,SOURCE_HEALTH,normalizeBoard,normalizeFeed} from '../../tools/find-jobs.mjs';
test('public job metadata retains secondary countries and advertised work mode',()=>{
  const job=normalizeBoard({title:'Engineer',location:'Remote',address:{postalAddress:{addressCountry:'USA'}},
    secondaryLocations:[{location:'Toronto',address:{addressCountry:'CAN'}}],workplaceType:'Hybrid',isRemote:true,
    isListed:false,employmentType:'FullTime'},'ashby','fixture');
  assert.deepEqual(job.countries,['USA','CAN']);assert.ok(job.locations.includes('Toronto'));
  assert.equal(job.workplaceType,'Hybrid');assert.equal(job.active,false);
  assert.equal(normalizeFeed({remote:false,location:'Berlin'},'Arbeitnow').workplaceType,null);
  assert.equal(normalizeFeed({},'Remotive').workplaceType,'remote');
});
test('browser operations cannot target another job on the same host or path',()=>{
  assert.equal(sameJob('https://jobs.lever.co/acme/123','https://jobs.lever.co/acme/456'),false);
  assert.equal(sameJob('https://one.test/apply','https://two.test/apply'),false);
  assert.equal(sameJob('https://jobs.test/?jobId=1','https://jobs.test/?jobId=2'),false);
  assert.equal(sameJob('about:blank','about:blank'),false);
  assert.equal(sameJob('https://boards.greenhouse.io/acme/jobs/123?gh_src=abc','https://job-boards.greenhouse.io/acme/jobs/123'),true);
  assert.equal(sameJob('https://jobs.lever.co/acme/123?utm_source=x','https://jobs.lever.co/acme/123/apply'),true);
});
test('queue deduplication preserves query job IDs and available descriptions',()=>{
  assert.notEqual(postingKey('https://jobs.test/?gh_jid=1'),postingKey('https://jobs.test/?gh_jid=2'));
  const jobs=dedupe([{url:'https://jobs.test/a',title:'Engineer'},{url:'https://jobs.test/a/apply',description:'Python required'}]);
  assert.equal(jobs.length,1);assert.equal(jobs[0].description,'Python required');
});
test('HTTP 200 with a malformed board response is reported as failed',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({message:'temporarily unavailable'})});
  try {
    SOURCE_HEALTH.length=0;
    assert.deepEqual(await fetchBoards({greenhouse:['fixture']}),[]);
    assert.equal(SOURCE_HEALTH[0].ok,false);
    assert.match(SOURCE_HEALTH[0].error,/shape/);
  } finally {globalThis.fetch=original;}
});


test('Workday posting and application steps retain identity across location slug redirects',()=>{
 const base='https://fixture.wd5.myworkdayjobs.com/en-US/External/job/Israel-Yokneam/Engineer_JR123';
 assert.equal(sameJob(base,base.replace('Israel-Yokneam','Israel%2C-Yokneam')+'/apply/applyManually'),true);
 assert.equal(sameJob(base,base.replace('JR123','JR124')+'/apply/applyManually'),false);
 assert.equal(sameJob(base,base.replace('/External/','/Internal/')),false);
});

test('LinkedIn and Indeed tracking links preserve posting identity without merging distinct jobs',()=>{
 assert.equal(sameJob('https://www.linkedin.com/jobs/view/123?trackingId=a','https://linkedin.com/jobs/view/123?trackingId=b'),true);
 assert.equal(sameJob('https://www.indeed.com/viewjob?jk=abc&from=search','https://indeed.com/viewjob?jk=abc&from=email'),true);
 assert.equal(sameJob('https://www.indeed.com/viewjob?jk=abc','https://indeed.com/viewjob?jk=def'),false);
 assert.equal(sameJob('https://smartapply.indeed.com/application','https://indeed.com/viewjob?jk=abc'),false);
});
