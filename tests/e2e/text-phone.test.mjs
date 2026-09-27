import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';
for(const mode of ['accept','wrong-digit','invalid','lost-country','extension','ordinary-text'])test(`text-backed phone readback preserves number identity (${mode})`,async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();
 await p.setContent(`<label for="phone">${mode==='ordinary-text'?'Phone interview reference':'Home Phone Number'}</label><input id="phone" type="text">`);
 await p.evaluate(mode=>{document.querySelector('input').oninput=e=>{const el=e.target;el.value=el.value.replace(/\D/g,'');if(mode==='wrong-digit')el.value='9195559999';if(mode==='lost-country')el.value=el.value.slice(1);if(mode==='invalid')el.setAttribute('aria-invalid','true')}},mode);
 for(const file of ['scrape.js','fill.js'])await p.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const r=await p.evaluate(async mode=>{const n=__formwork,s=n.scrape();return n.fill({f0:mode==='lost-country'?'+19195550142':mode==='extension'?'919-555-0142 ext 99':'919-555-0142'},s.schema,s.registry)},mode);
 assert.equal(r.filled.length,mode==='accept'?1:0);
 assert.equal(r.failed.length,mode==='accept'?0:1);
});
