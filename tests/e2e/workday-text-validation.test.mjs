import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';
test('Workday plain text activates the field and commits state before blur validation',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<form><div data-automation-id="formField-company"><label for="company">Company</label><input id="company" required aria-invalid="true"></div><div data-automation-id="formField-roleDescription"><label for="description">Role Description</label><textarea id="description" required aria-invalid="true"></textarea></div><button>Submit</button></form><script>
 window.submitted=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();submitted++};
 for(const field of document.querySelectorAll('input,textarea')){
  let touched=false,committed='';field.onclick=()=>touched=true;
  field.oninput=()=>{const value=field.value;setTimeout(()=>committed=value,0)};
  field.onblur=()=>field.setAttribute('aria-invalid',String(!(touched&&committed===field.value&&committed.length)));
 }
 </script>`);
 for(const name of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',name)});
 const result=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill(Object.fromEntries(schema.fields.map(f=>[f.id,f.label==='Company'?'Example Corp':'Saved resume bullets'])),schema,registry)});
 assert.deepEqual(result.failed,[]);assert.equal(result.filled.length,2);
 assert.equal(await page.locator('[aria-invalid=true]').count(),0);assert.equal(await page.evaluate(()=>submitted),0);
});
