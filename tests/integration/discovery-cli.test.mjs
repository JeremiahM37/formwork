import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT} from '../helpers/load.mjs';

test('discovery CLI honors selected boards and exports the full pool before dashboard ranking',async t=>{
  const work=mkdtempSync(join(tmpdir(),'formwork-discovery-cli-'));t.after(()=>rmSync(work,{recursive:true,force:true}));
  const source=join(work,'sources.json'),out=join(work,'jobs.json');
  writeFileSync(source,JSON.stringify({greenhouse:['fixture'],lever:[],ashby:[],github:false,feeds:[]}));
  const finder=join(ROOT,'tools/find-jobs.mjs');
  const code=`globalThis.fetch=async url=>{
    if(String(url)!=='https://boards-api.greenhouse.io/v1/boards/fixture/jobs?content=true') throw new Error('Unexpected source '+url);
    return {ok:true,status:200,json:async()=>({jobs:[
      {title:'Sales manager',absolute_url:'https://example.test/new',updated_at:'2026-09-07'},
      {title:'Backend engineer',absolute_url:'https://example.test/older',updated_at:'2026-08-20',content:'Python'}]})};
  };process.argv=[process.execPath,...process.argv.slice(1)];await import(${JSON.stringify(pathToFileURL(finder).href)});`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',code,finder,'--sources',source,'--all','--limit','1','--out',out],
    {cwd:ROOT,env:{...process.env,FORMWORK_FEED_CACHE:join(work,'cache')}});
  const rows=JSON.parse(readFileSync(out));assert.equal(rows.length,2);assert.equal(rows[1].description,'Python');
});

test('discovery CLI collects a selected Workday board through pagination and exposes source health',async t=>{
  const work=mkdtempSync(join(tmpdir(),'formwork-workday-cli-'));t.after(()=>rmSync(work,{recursive:true,force:true}));
  const source=join(work,'sources.json'),out=join(work,'jobs.json'),health=join(work,'health.json');
  writeFileSync(source,JSON.stringify({workday:['https://fixture.wd5.myworkdayjobs.com/External'],github:false,feeds:[]}));
  const finder=join(ROOT,'tools/find-jobs.mjs');
  const code=`globalThis.fetch=async (url,options)=>{
    if(!String(url).endsWith('/wday/cxs/fixture/External/jobs')) throw new Error('Unexpected source '+url);
    const {offset}=JSON.parse(options.body);
    return {ok:true,status:200,json:async()=>({total:offset===0?21:0,jobPostings:Array.from({length:offset===0?20:1},(_,i)=>({
      title:'Engineer '+(i+offset),externalPath:'/job/Denver/Engineer_R'+(i+offset),locationsText:'Denver'}))})};
  };process.argv=[process.execPath,...process.argv.slice(1)];await import(${JSON.stringify(pathToFileURL(finder).href)});`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',code,finder,'--sources',source,'--all','--limit','1','--out',out,'--health-out',health],
    {cwd:ROOT,env:{...process.env,FORMWORK_FEED_CACHE:join(work,'cache')}});
  const rows=JSON.parse(readFileSync(out));assert.equal(rows.length,21);assert.equal(rows[0].source,'workday:fixture');
  assert.equal(JSON.parse(readFileSync(health))[0].count,21);assert.equal(JSON.parse(readFileSync(health))[0].ok,true);
});
