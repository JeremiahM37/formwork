import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';
import {markTrustedField,trustedInput,verifyTrustedField,dateParts} from '../../tools/workday-input.mjs';

async function setup(page,html,field,ids) {
 await page.setContent(html);
 for(const name of ['scrape.js','fill.js']) await page.addScriptTag({content:readFileSync(join(ROOT,'extension/src/content',name),'utf8')});
 await page.evaluate(({field,ids})=>{window.__formwork._last={scraped:{schema:{fields:[field]},registry:[ids.map(id=>document.getElementById(id))]},
   result:{fills:{[field.id]:'value'}},report:{filled:[],failed:[{id:field.id,reason:'Synthetic input rejected'}]}};},{field,ids});
 return page.evaluate(markTrustedField,{id:field.id,token:'fixture'});
}

test('trusted Workday input targets exact fields/options and verifies committed values',async t=>{
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
 await t.test('a trusted-only dropdown selects its exact option, not a substring or neighboring question',async()=>{
  const target=await setup(page,`<label for="phone">Phone Device Type</label><button id="phone" role="combobox" aria-haspopup="listbox" aria-controls="menu" aria-invalid="true">Choose</button>
    <button id="other">Choose</button><div role="listbox" id="menu" hidden><div role="option">Home Mobile</div><div role="option">Mobile</div></div>
    <script>phone.onclick=e=>{if(e.isTrusted)menu.hidden=false};for(const o of menu.children)o.onclick=e=>{if(e.isTrusted){phone.textContent=o.textContent;phone.setAttribute('aria-invalid','false');menu.hidden=true}};</script>`,
    {id:'phone',label:'Phone Device Type',type:'combobox'},['phone']);
  await page.evaluate(()=>phone.click());assert.equal(await page.locator('#menu').isVisible(),false);
  assert.equal((await trustedInput(page,target,'Mobile')).ok,true);
  assert.equal(await page.evaluate(verifyTrustedField,{id:'phone',value:'Mobile'}),true);
  assert.equal(await page.locator('#phone').innerText(),'Mobile');assert.equal(await page.locator('#other').innerText(),'Choose');
  assert.deepEqual(await page.evaluate(()=>__formwork._last.report.failed),[]);
 });
 await t.test('a category never authorizes selecting an arbitrary child',async()=>{
  const target=await setup(page,`<label for="source">Source</label><button id="source" role="combobox" aria-haspopup="listbox" aria-controls="menu" aria-invalid="true">Choose</button>
    <div role="listbox" id="menu" hidden><div role="option" onclick="menu.innerHTML='<div role=option onclick=window.leafClicks++>Unrelated site</div>'">Website</div></div>
    <script>window.leafClicks=0;source.onclick=()=>menu.hidden=false;</script>`,{id:'source',type:'combobox',label:'Source'},['source']);
  await trustedInput(page,target,'Website');assert.equal(await page.evaluate(verifyTrustedField,{id:'source',value:'Website'}),false);
  assert.equal(await page.evaluate(()=>leafClicks),0);assert.equal(await page.locator('#source').innerText(),'Choose');
 });
 await t.test('identically named choices on another question are untouched',async()=>{
  const target=await setup(page,`<fieldset><input id="other" type="radio" name="other"><label for="other">Yes</label></fieldset>
    <fieldset><input id="yes" type="radio" name="answer"><label for="yes">Yes</label><input id="no" type="radio" name="answer"><label for="no">No</label></fieldset>`,
    {id:'question',label:'Question',type:'radio'},['yes','no']);
  assert.equal((await trustedInput(page,target,'Yes')).ok,true);
  assert.equal(await page.evaluate(verifyTrustedField,{id:'question',value:'Yes'}),true);assert.equal(await page.locator('#other').isChecked(),false);
 });
 await t.test('date segments receive real keystrokes without changing the supplied calendar day',async()=>{
  const target=await setup(page,`<div data-automation-id="formFieldDate"><input id="month" role="spinbutton" aria-label="Month"><input id="day" role="spinbutton" aria-label="Day"><input id="year" role="spinbutton" aria-label="Year"></div>
    <script>window.committed={};for(const input of document.querySelectorAll('input'))input.oninput=e=>{if(e.isTrusted)committed[input.id]=input.value};</script>`,
    {id:'date',label:'Signature date',type:'date',parts:['Month','Day','Year']},['month','day','year']);
  assert.equal((await trustedInput(page,target,'2026-09-07')).ok,true);
  assert.deepEqual(await page.evaluate(()=>committed),{month:'09',day:'07',year:'2026'});
  assert.equal(await page.evaluate(verifyTrustedField,{id:'date',value:'2026-09-07',parts:dateParts('2026-09-07')}),true);
  assert.equal((await trustedInput(page,target,'2026')).ok,false);
  assert.deepEqual(await page.evaluate(()=>committed),{month:'09',day:'07',year:'2026'});
  assert.equal(dateParts('2026-02-30'),null);assert.equal(dateParts('tomorrow'),null);
 });
});
