import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';
for(const mode of ['accept','ignore','disabled-option'])test(`readonly Ant dropdown is selectable without typing (${mode})`,async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();
 const widget=(id,extra='')=>`<div class="ant-select ant-select-single ${extra}"><div class="ant-select-selector"><input id="${id}" type="search" role="combobox" aria-haspopup="listbox" aria-controls="${id}-list" readonly style="opacity:0"><span class="ant-select-selection-item"></span></div></div>`;
 await p.setContent(`<header><label for="language">Language</label>${widget('language')}</header><form><label for="contact">Preferred Contact Method</label>${widget('contact')}<label>Read-only fact<input readonly value="Existing"></label>${widget('disabled','ant-select-disabled')}${widget('ambiguous')}<button type="submit">Submit application</button></form><div role="listbox" id="contact-list" hidden><div role="option">Email</div><div role="option">Mobile</div></div>`);
 await p.evaluate(mode=>{
  const input=document.querySelector('#contact'),list=document.querySelector('#contact-list');input.setAttribute('aria-required','true');window.inputs=0;window.submits=0;
  input.oninput=()=>inputs++;input.onchange=()=>inputs++;
  input.onmousedown=input.onclick=()=>{list.hidden=false};input.onkeydown=e=>{if(e.key==='Escape')list.hidden=true};
  for(const option of list.children)option.onclick=()=>{if(mode==='ignore')return;input.parentElement.querySelector('.ant-select-selection-item').textContent=option.textContent;list.hidden=true};
  if(mode==='disabled-option')list.firstElementChild.setAttribute('aria-disabled','true');
  const duplicate=document.querySelector('#ambiguous').cloneNode();duplicate.id='ambiguous2';document.querySelector('#ambiguous').parentElement.append(duplicate);
  document.querySelector('form').onsubmit=e=>{e.preventDefault();submits++};
 },mode);
 for(const file of ['scrape.js','fill.js'])await p.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const result=await p.evaluate(async()=>{const n=__formwork,s=await n.scrapeFull();return {fields:s.schema.fields,report:await n.fill({f0:'Email'},s.schema,s.registry),inputs,submits}});
 assert.equal(result.fields.length,1);assert.equal(result.fields[0].label,'Preferred Contact Method');assert.equal(result.fields[0].required,true);assert.deepEqual(result.fields[0].options,['Email','Mobile']);
 assert.equal(result.report.filled.length,mode==='accept'?1:0);assert.equal(result.inputs,0);assert.equal(result.submits,0);
});
