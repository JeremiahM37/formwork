import test from 'node:test';
import assert from 'node:assert/strict';
import {workdayBoard,normalizeWorkday,fetchWorkday} from '../../tools/workday-source.mjs';
const url='https://fixture.wd5.myworkdayjobs.com/en-US/External';
const row=n=>({title:`Engineer ${n}`,externalPath:`/job/Denver/Engineer_R${n}`,locationsText:'Denver',postedOn:'Posted 30+ Days Ago'});
const response=(rows,total,status=200)=>({ok:status===200,status,json:async()=>({jobPostings:rows,total})});

test('Workday board URLs are constrained and localized dates remain unknown',()=>{
  assert.equal(workdayBoard(url).api,'https://fixture.wd5.myworkdayjobs.com/wday/cxs/fixture/External/jobs');
  for(const value of ['http://fixture.wd5.myworkdayjobs.com/External',url+'/job/1',url+'?x=1','https://evil.test/External','https://user@fixture.wd5.myworkdayjobs.com/External'])
    assert.throws(()=>workdayBoard(value));
  const job=normalizeWorkday(row(1),workdayBoard(url));assert.equal(job.posted,null);assert.equal(job.postedLabel,'Posted 30+ Days Ago');assert.equal(job.url,url+'/job/Denver/Engineer_R1');
  assert.throws(()=>normalizeWorkday({...row(1),externalPath:'//evil.test/'},workdayBoard(url)));
});
test('Workday paginates the full pool in batches of 20',async()=>{
 const health=[],offsets=[];
 const rows=await fetchWorkday(url,{health,request:async(endpoint,options)=>{
   assert.equal(endpoint,workdayBoard(url).api);assert.equal(options.method,'POST');
   const body=JSON.parse(options.body);assert.equal(body.limit,20);offsets.push(body.offset);
   return response(Array.from({length:body.offset===0?20:3},(_,i)=>row(i+body.offset)),body.offset===0?23:0);
 }});
 assert.equal(rows.length,23);assert.deepEqual(offsets,[0,20]);assert.equal(health[0].ok,true);assert.equal(health[0].count,23);
});
test('Workday marks midstream failures, repeated pages and page caps as partial',async()=>{
 for(const variant of ['http','repeat','cap','empty']) {
  const health=[];let calls=0;
  const rows=await fetchWorkday(url,{health,maxPages:variant==='cap'?1:3,request:async()=>{
   calls++;if(calls===1)return response(Array.from({length:20},(_,i)=>row(i)),40);
   if(variant==='http')return response([],40,429);
   return response(variant==='empty'?[]:Array.from({length:20},(_,i)=>row(i)),40);
  }});
  assert.equal(rows.length,20,variant);assert.equal(health[0].ok,false,variant);assert.equal(health[0].partial,true,variant);assert.ok(health[0].error);
 }
});
test('Workday distinguishes an empty board from a malformed response or elapsed budget',async()=>{
 const health=[];assert.deepEqual(await fetchWorkday(url,{health,request:async()=>response([],0)}),[]);assert.equal(health[0].ok,true);
 await fetchWorkday(url,{health,request:async()=>({ok:true,status:200,json:async()=>({})})});assert.equal(health[1].ok,false);
 await fetchWorkday(url,{health,budgetMs:0,request:async()=>{throw new Error('must not fetch');}});assert.match(health[2].error,/budget/);
});

test('Workday caches public results and retries expired partial or corrupt collections',async t=>{
 const {fetchWorkdayCached}=await import('../../tools/workday-source.mjs');
 const {mkdtempSync,rmSync,readdirSync,writeFileSync,readFileSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const cacheDir=mkdtempSync(join(tmpdir(),'formwork-workday-cache-'));t.after(()=>rmSync(cacheDir,{recursive:true,force:true}));
 let calls=0;const request=async()=>{calls++;return response([row(1)],1);};const health=[];
 await fetchWorkdayCached(url,{cacheDir,health,request});await fetchWorkdayCached(url,{cacheDir,health,request});
 assert.equal(calls,1);assert.equal(health[1].cached,true);
 const path=join(cacheDir,readdirSync(cacheDir)[0]);const saved=JSON.parse(readFileSync(path));
 saved.report.ok=false;saved.at=Date.now()-301000;writeFileSync(path,JSON.stringify(saved));
 await fetchWorkdayCached(url,{cacheDir,health,request});assert.equal(calls,2);
 writeFileSync(path,'bad cache');await fetchWorkdayCached(url,{cacheDir,health,request});assert.equal(calls,3);
});

test('Workday enrichment supplies requirements and locations before ranking, caches and exposes failures',async t=>{
 const {enrichWorkday}=await import('../../tools/workday-source.mjs');
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const cacheDir=mkdtempSync(join(tmpdir(),'workday-details-'));t.after(()=>rmSync(cacheDir,{recursive:true,force:true}));
 const jobs=[normalizeWorkday(row(1),workdayBoard(url)),normalizeWorkday(row(2),workdayBoard(url))];
 const health=[];let calls=0;
 const request=async(endpoint,options)=>{
   calls++;assert.equal(options.redirect,'error');
   assert.match(endpoint,/\/wday\/cxs\/fixture\/External\/job\/Denver\/Engineer_R[12]$/);
   if(endpoint.endsWith('R2')) return {ok:false,status:503};
   return {ok:true,json:async()=>({jobPostingInfo:{jobDescription:'<p>Python and PostgreSQL</p>',location:'Denver',additionalLocations:['Boston'],startDate:'2026-09-01',canApply:true}})};
 };
 await enrichWorkday(jobs,{request,cacheDir,health});
 assert.equal(jobs[0].description,'<p>Python and PostgreSQL</p>');assert.deepEqual(jobs[0].locations,['Denver','Boston']);
 assert.equal(jobs[0].posted,'2026-09-01');assert.equal(jobs[1].descriptionStatus,'unavailable');assert.equal(health[0].partial,true);
 await enrichWorkday(jobs,{request,cacheDir,health});assert.equal(calls,3);assert.equal(health[1].cached,1);
});
test('Workday enrichment deadline keeps listings and reports incomplete requirements',async()=>{
 const {enrichWorkday}=await import('../../tools/workday-source.mjs');const jobs=[normalizeWorkday(row(1),workdayBoard(url))],health=[];
 await enrichWorkday(jobs,{health,budgetMs:0,request:()=>{throw new Error('must not fetch');}});
 assert.equal(jobs.length,1);assert.equal(health[0].ok,false);assert.equal(health[0].failed,1);assert.equal(jobs[0].descriptionStatus,'unavailable');
});
test('Workday rate limiting stops further detail requests for that board',async()=>{
 const {enrichWorkday}=await import('../../tools/workday-source.mjs');let calls=0;const health=[];
 const jobs=Array.from({length:10},(_,n)=>normalizeWorkday(row(n),workdayBoard(url)));
 await enrichWorkday(jobs,{health,concurrency:1,request:async()=>{calls++;return {ok:false,status:429,headers:new Headers({'retry-after':'900'})};}});
 assert.equal(calls,1);assert.equal(health[0].rateLimited,true);assert.equal(health[0].failed,10);
});
