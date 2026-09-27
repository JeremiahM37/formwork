import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {lib} from '../helpers/load.mjs';
const {workdaySelect}=lib('workday-select');
for(const value of ['C','Computer Science'])test(`Workday ${value}: component search returns options and component selection commits`,async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<div data-automation-id="formField-skills"><input id="search" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="own"><ul data-automation-id="selectedItemList"></ul></div><div id="menu" role="listbox"><div data-automation-id="promptLeafNode" data-uxi-multiselect-id="own"><div data-automation-id="promptOption">No Items.</div></div></div><script>
 window.searches=0;window.commits=0;window.domEnters=0;document.addEventListener("keydown",e=>{if(e.key==="Enter")domEnters++});
 search.__reactProps$test={onChange:e=>window.query=e.target.value,onKeyDown:e=>{if(e.key==='Enter'){e.preventDefault();window.enterHeld=true}},onKeyUp:e=>{if(e.key!=='Enter'||!window.enterHeld)return;window.enterHeld=false;searches++;setTimeout(()=>{
 menu.innerHTML='<div data-automation-id="promptLeafNode" data-uxi-multiselect-id="own" data-uxi-multiselectlistitem-instanceid="NO_METADATA_ID"><div data-automation-id="promptOption"></div></div>';
 const leaf=menu.firstChild;leaf.firstChild.textContent=window.query;
 leaf.__reactProps$test={onClick:()=>{commits++;const li=document.createElement('li');li.textContent=window.query;document.querySelector('ul').append(li);menu.innerHTML='';search.value=''}};
 },150)}};
 </script>`);
 // Playwright accepts one argument; execute the serialized page-world function
 // exactly as scripting does, with the two arguments bound by a tiny wrapper.
 const actual=await page.evaluate(({source,value})=>new Function('return ('+source+')("search",'+JSON.stringify(value)+')')(),{source:workdaySelect.toString(),value});
 assert.equal(actual.ok,true,JSON.stringify(actual));assert.deepEqual(await page.locator('li').allTextContents(),[value]);assert.equal(await page.evaluate(()=>commits),1);
 const repeated=await page.evaluate(({source,value})=>new Function('return ('+source+')("search",'+JSON.stringify(value)+')')(),{source:workdaySelect.toString(),value});
 assert.equal(await page.evaluate(()=>domEnters),0);assert.equal(repeated.alreadySelected,true);assert.equal(await page.evaluate(()=>searches),1);
});

test('Workday commits a unique Field of Study without rendering suggestions',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<div data-automation-id="formField-fieldOfStudy"><input id="search" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="own"><ul data-automation-id="selectedItemList"></ul></div><script>
 search.__reactProps$test={onChange(){},onKeyDown:e=>{if(e.key==='Enter')window.enterHeld=true},onKeyUp:e=>{if(e.key==='Enter'&&window.enterHeld)setTimeout(()=>{const li=document.createElement('li');li.textContent=e.target.value;document.querySelector('ul').append(li);search.value=''},150)}};
 </script>`);
 const result=await page.evaluate(source=>new Function('return ('+source+')("search","Computer Science")')(),workdaySelect.toString());
 assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(await page.locator('li').allTextContents(),['Computer Science']);
 assert.equal(await page.locator('[data-automation-id="promptOption"]').count(),0);
});

test('Workday skill batches re-find replaced inputs and verify the current chips',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent('<div data-automation-id="formField-skills"><label for="skills">Type to Add Skills</label><input id="skills" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="own"><ul data-automation-id="selectedItemList"></ul></div>');
 await page.evaluate(()=>{window.requests=[];window.chrome={runtime:{sendMessage:async({payload})=>{
  requests.push(payload.value);
  const old=document.querySelector('[data-automation-id="formField-skills"]'),fresh=old.cloneNode(true);
  old.replaceWith(fresh);const item=document.createElement('li');item.textContent=payload.value;fresh.querySelector('ul').append(item);
  return {ok:true};
 }}}});
 const {join}=await import('node:path');const {ROOT}=await import('../helpers/load.mjs');
 for(const name of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',name)});
 const report=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:['C','C++','Python']},schema,registry)});
 assert.deepEqual(report.failed,[]);assert.equal(report.filled.length,1);
 assert.deepEqual(await page.locator('li').allTextContents(),['C','C++','Python']);
 assert.deepEqual(await page.evaluate(()=>requests),['C','C++','Python']);
});
