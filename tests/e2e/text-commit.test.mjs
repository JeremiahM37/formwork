import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';
for(const accepts of [true,false])test(`text blur observes asynchronous application state (accepts=${accepts})`,async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();
 await p.setContent('<div class="field"><label for="first">First name</label><input id="first" aria-required="true" aria-invalid="false"><div role="alert" id="error"></div></div>');
 await p.evaluate(accepts=>{
  const input=document.querySelector('#first'),error=document.querySelector('#error');let state='';
  input.oninput=()=>{const value=input.value;setTimeout(()=>{if(accepts)state=value},0)};
  input.onblur=()=>{input.setAttribute('aria-invalid',String(!state));error.textContent=state?'':'First name cannot be left blank';window.committedAtBlur=state};
 },accepts);
 for(const name of ['scrape.js','fill.js'])await p.addScriptTag({path:join(ROOT,'extension/src/content',name)});
 const report=await p.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:'Dana'},schema,registry)});
 assert.equal(report.filled.length,accepts?1:0);
 assert.equal(report.failed.length,accepts?0:1);
 assert.equal(await p.evaluate(()=>window.committedAtBlur),accepts?'Dana':'');
});
