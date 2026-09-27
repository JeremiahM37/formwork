import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';

for (const mode of ['accept','ignore','neighbor','ambiguous','wrong','duplicate-options','disabled']) test(`Ant single selection verifies its own committed answer (${mode})`,async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent(`<form><label for="country">Country</label><div class="ant-select ant-select-single"><div class="ant-select-selector"><span class="ant-select-selection-search"><input id="country" type="search" role="combobox" aria-controls="countries" aria-expanded="false"></span><span class="ant-select-selection-placeholder"></span></div></div><div class="ant-select ant-select-single"><div class="ant-select-selector"><span class="ant-select-selection-item">United States of America</span></div></div><button type="submit">Submit application</button></form><div role="listbox" id="countries" hidden><div role="option">United States Minor Outlying Islands</div><div role="option">United States of America</div></div>`);
  await page.evaluate(mode=>{
    window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++};
    const input=document.querySelector('#country'),list=document.querySelector('#countries');
    if(mode==='duplicate-options')list.append(list.lastElementChild.cloneNode(true));
    if(mode==='disabled')list.lastElementChild.setAttribute('aria-disabled','true');
    const open=()=>{list.hidden=false;input.setAttribute('aria-expanded','true')};
    input.onmousedown=open;input.onclick=open;
    input.onkeydown=e=>{if(e.key==='Escape'){list.hidden=true;input.setAttribute('aria-expanded','false')}};
    for(const option of list.children) option.onclick=()=>{
      if(mode==='ignore'||mode==='neighbor')return;
      input.value='';
      const holder=input.closest('.ant-select-selector');
      holder.querySelectorAll('.ant-select-selection-item').forEach(n=>n.remove());
      const selected=document.createElement('span');selected.className='ant-select-selection-item';
      selected.textContent=mode==='wrong'?'United States Minor Outlying Islands':option.textContent;
      holder.append(selected);if(mode==='ambiguous')holder.append(selected.cloneNode(true));
      list.hidden=true;input.setAttribute('aria-expanded','false');
    };
  },mode);
  for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
  const result=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();const field=schema.fields.find(f=>f.label==='Country');return ns.fill({[field.id]:'United States of America'},schema,registry)});
  assert.equal(result.filled.length,mode==='accept'?1:0);
  assert.equal(result.failed.length,mode==='accept'?0:1);
  assert.equal(await page.evaluate(()=>window.submits),0);
});

for(const mode of ['accept','country-search','wrong-country','unselected','neighbor','duplicate-selected'])test(`Ant abbreviated dialing choice requires its own full selected option (${mode})`,async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();
 await p.setContent(`<label for="phonecountry">Country dialing code</label><div class="ant-select-single"><div class="ant-select-selector"><input id="phonecountry" role="combobox" aria-controls="dialing"><span class="ant-select-selection-item"></span></div></div><div role="listbox" id="dialing" hidden><div role="option" aria-selected="false">🇺🇸 +1 United States of America</div></div><div role="listbox" id="neighbor"><div role="option" aria-selected="true">🇺🇸 +1 United States of America</div></div>`);
 await p.evaluate(mode=>{const input=document.querySelector('#phonecountry'),list=document.querySelector('#dialing');input.onclick=input.onmousedown=()=>{list.hidden=false};if(mode==='country-search'){const option=list.firstElementChild;input.oninput=()=>{if(input.value==='United States of America')list.append(option);else option.remove()}};input.onkeydown=e=>{if(e.key==='Escape')list.hidden=true};list.firstElementChild.onclick=()=>{input.value='';input.parentElement.querySelector('.ant-select-selection-item').textContent=mode==='wrong-country'?'🇨🇦 +1':'🇺🇸 +1';list.firstElementChild.setAttribute('aria-selected',['unselected','neighbor'].includes(mode)?'false':'true');if(mode==='duplicate-selected')list.append(list.firstElementChild.cloneNode(true));list.hidden=true}},mode);
 for(const file of ['scrape.js','fill.js'])await p.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const r=await p.evaluate(async()=>{const n=__formwork,s=n.scrape();return n.fill({f0:'🇺🇸 +1 United States of America'},s.schema,s.registry)});
 assert.equal(r.filled.length,['accept','country-search'].includes(mode)?1:0);assert.equal(r.failed.length,['accept','country-search'].includes(mode)?0:1);
});
