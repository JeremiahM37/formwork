import test from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright';import {join} from 'node:path';import {ROOT} from '../helpers/load.mjs';
test('ApplicantPro application excludes job alerts and FAQ while preserving required contact fields',async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();
 await p.route('https://example.applicantpro.com/**',r=>r.fulfill({contentType:'text/html',body:'<form id="refer-widget-form"><label>Name<input id="alert"></label></form><form id="faq_bar_form"><label>Email<input id="faq"></label></form><form id="apply"><label>First Name<input class="required" id="first"></label></form>'}));
 await p.goto('https://example.applicantpro.com/jobs/1');for(const f of ['scrape.js','fill.js'])await p.addScriptTag({path:join(ROOT,'extension/src/content',f)});
 const r=await p.evaluate(async()=>{const s=__formwork.scrape();return {fields:s.schema.fields,report:await __formwork.fill({f0:'Dana'},s.schema,s.registry)}});assert.equal(r.fields.length,1);assert.equal(r.fields[0].required,true);assert.deepEqual(r.report.filled,['f0']);assert.equal(await p.locator('#first').inputValue(),'Dana');for(const id of ['alert','faq'])assert.equal(await p.locator('#'+id).inputValue(),'');
});
