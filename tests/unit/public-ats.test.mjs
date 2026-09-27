import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fetchPublicATS} from '../../tools/public-ats.mjs';
const response=data=>({ok:true,json:async()=>data});
test('Rippling keeps all locations and distinct same-title requisitions; caches successful boards',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'formwork-ats-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let calls=0;const fetcher=async()=>{calls++;return response([
 {uuid:'a',name:'Engineer',url:'https://ats.rippling.com/acme/jobs/a',workLocation:{label:'Boston'}},
 {uuid:'a',name:'Engineer',url:'https://ats.rippling.com/acme/jobs/a',workLocation:{label:'Remote, Canada'}},
 {uuid:'b',name:'Engineer',url:'https://ats.rippling.com/acme/jobs/b',workLocation:{label:'London'}}]);};
 const health=[];const jobs=await fetchPublicATS('rippling','acme',{cacheDir:dir,fetcher,health});
 assert.equal(jobs.length,2);assert.deepEqual(jobs[0].locations,['Boston','Remote, Canada','Remote']);assert.equal(health[0].ok,true);
 await fetchPublicATS('rippling','acme',{cacheDir:dir,fetcher,health});assert.equal(calls,1);assert.equal(health[1].cached,true);
});
test('SmartRecruiters paginates with real IDs, reports partial failure and rejects invalid destinations',async()=>{
 const health=[];let n=0;
 const rows=Array.from({length:100},(_,i)=>({id:String(i),uuid:'uuid-'+i,name:'Engineer',location:{country:'US'}}));
 const jobs=await fetchPublicATS('smartrecruiters','Acme',{health,fetcher:async url=>{
  if(n++===0){assert.ok(url.endsWith('offset=0'));return response({content:rows,totalFound:200});}
  assert.ok(url.endsWith('offset=100'));return {ok:false,status:429};
 }});
 assert.equal(jobs.length,100);assert.equal(health[0].ok,false);assert.equal(health[0].partial,true);assert.match(health[0].error,/429/);
 assert.equal(jobs[0].countries[0],'US');assert.match(jobs[0].url,/\/0$/);
 await assert.rejects(()=>fetchPublicATS('rippling','../private'),/Invalid/);
});
