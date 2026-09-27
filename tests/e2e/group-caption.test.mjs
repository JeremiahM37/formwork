import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';
test('unwired single-field captions preserve required markers and exclude phone help text',async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();
 await p.setContent(`<div class="form-group"><label>Mobile Number <em>(required)</em></label><input id="mobile"><p>For international numbers, start with a + and then the country code.</p></div>
 <div class="form-group"><label>Middle Name</label><input id="middle"></div>
 <div class="form-group"><label>Unrelated (required)</label><input id="one" aria-label="One"><input id="two" aria-label="Two"></div>
 <div class="form-group"><label hidden>Hidden (required)</label><input id="hiddenCaption" aria-label="Other"></div>`);
 await p.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
 const fields=await p.evaluate(()=>__formwork.scrape().schema.fields);
 assert.equal(fields[0].label,'Mobile Number (required)');assert.equal(fields[0].required,true);
 for(const f of fields.slice(1))assert.equal(f.required,false,f.label);
});
