import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';
for(const reject of [false,true])test(`legacy React Select discovers options and verifies commitment (${reject?'ignored':'accepted'})`,async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();
 await p.setContent('<section id="clipped" style="height:1px;overflow:visible"><label for="country">Country</label><div class="react-select__control"><div class="react-select__value-container"><span class="react-select__single-value"></span><input id="country" role="combobox" aria-controls="react-select-2-listbox"></div></div><div class="react-select__option">Unrelated text</div></section>');
 await p.evaluate(reject=>{
  const input=document.querySelector('input');
  const close=()=>document.querySelector('.react-select__menu')?.remove();
  input.addEventListener('mousedown',()=>{
   if(document.querySelector('.react-select__menu'))return;
   const list=document.createElement('div');list.id='react-select-2-listbox';list.className='react-select__menu';
   for(const text of ['Canada','United States']){const option=document.createElement('div');option.className='react-select__option';option.textContent=text;option.onclick=()=>{if(!reject)document.querySelector('.react-select__single-value').textContent=text;input.value='';close()};list.append(option)}document.querySelector('#clipped').append(list);
  });
  input.addEventListener('keydown',e=>{if(e.key==='Escape')close();if(e.key==='Enter'){const option=[...document.querySelectorAll('.react-select__menu .react-select__option')].find(el=>el.textContent===input.value);option?.click()}});
 },reject);
 for(const file of ['scrape.js','fill.js'])await p.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const result=await p.evaluate(async()=>{const s=await __formwork.scrapeFull();return {fields:s.schema.fields,report:await __formwork.fill({f0:'Canada'},s.schema,s.registry)}});
 assert.deepEqual(result.fields[0].options,['Canada','United States']);
 assert.equal(result.fields[0].optionsPartial,undefined);
 assert.deepEqual(result.report.filled,reject?[]:['f0']);assert.equal(result.report.failed.length,reject?1:0);
});

test('a tall loading menu does not trigger repeated full scroll scans',{timeout:6000},async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();
 await p.setContent('<label for="location">Location</label><input id="location" role="combobox" aria-controls="loading-list"><div id="loading-list" role="listbox" style="height:100px;overflow:auto"><div style="height:10000px">Loading…</div></div>');
 await p.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
 const result=await p.evaluate(()=>__formwork.scrapeFull().then(s=>s.schema.fields[0]));
 assert.equal(result.asyncSearch,true);assert.equal(result.options,undefined);
});
