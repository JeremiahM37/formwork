import test from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright';import {join} from 'node:path';import {ROOT} from '../helpers/load.mjs';
test('Paycom visible modal contact controls survive incorrect aria-hidden without exposing background fields',async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();
 await p.route('https://www.paycomonline.net/**',r=>r.fulfill({body:`<div aria-hidden="true"><label>Background<input required></label></div><div class="uiLibModalBody" role="dialog" aria-modal="true"><div aria-hidden="true"><div class="uiLibInput"><label for="first">Legal First Name *</label><input id="first" type="text" tabindex="0" required></div><div hidden class="uiLibInput"><input type="text" tabindex="0" required></div><input type="hidden" value="trap"></div></div>`}));
 await p.goto('https://www.paycomonline.net/test');for(const f of ['scrape.js','fill.js'])await p.addScriptTag({path:join(ROOT,'extension/src/content',f)});
 const r=await p.evaluate(async()=>{const s=__formwork.scrape();return {fields:s.schema.fields,report:await __formwork.fill({f0:'Dana'},s.schema,s.registry)}});assert.equal(r.fields.length,1);assert.equal(r.fields[0].label,'Legal First Name');assert.deepEqual(r.report.filled,['f0']);
 await p.evaluate(()=>document.querySelector('[role=dialog]').setAttribute('aria-hidden','true'));assert.equal(await p.evaluate(()=>__formwork.scrape().schema.fields.length),0);
});
