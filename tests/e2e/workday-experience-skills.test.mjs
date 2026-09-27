import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT,lib,schemaOf} from '../helpers/load.mjs';

test('Workday employment descriptions transcribe the matching resume record and skills commit exact tokens',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<section><label>Company<input data-automation-id="company" value="Example Lab"></label><label>Job Title<input data-automation-id="jobTitle" value="Intern"></label><label>Role Description<textarea data-automation-id="roleDescription"></textarea></label></section>
 <div data-automation-id="formField-skills"><label for="skills">Skills</label><input id="skills" data-automation-id="searchBox" aria-controls="options"><ul data-automation-id="selectedItemList"></ul><div id="options" role="listbox"></div></div>
 <label for="choice">Phone Device Type</label><button id="choice" data-automation-id="selectInput" aria-controls="phones">Select One</button><div id="phones" role="listbox" hidden><div role="option">Mobile</div></div>
 <script>skills.oninput=()=>{options.innerHTML=['C','C++','C#','Python'].map(s=>'<div role="option">'+s+'</div>').join('')};options.onclick=e=>{if(e.target.role==='option'){const li=document.createElement('li');li.textContent=e.target.textContent;document.querySelector('ul').append(li);skills.value='';options.innerHTML='';}};choice.onclick=()=>phones.hidden=false;phones.onclick=e=>{choice.textContent=e.target.textContent;phones.hidden=true;};</script>`);
 for(const name of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',name)});
 const schema=await page.evaluate(()=>window.__formwork.scrape().schema);
 const desc=schema.fields.find(f=>f.history?.key==='summary');assert.ok(desc);
 const skills=schema.fields.find(f=>f.skillPicker);assert.ok(skills);
 const profile={experience:[{employer:'Other',title:'Engineer',bullets:['Wrong record']},{employer:'Example Lab',title:'Intern',bullets:['Built TLS tests.','Reviewed C code.']}],skills:{languages:['C++','Python']}};
 const result=lib('validate').validate({},schema,profile);
 assert.equal(result.fills[desc.id],'Built TLS tests.\nReviewed C code.');assert.deepEqual(result.fills[skills.id],['C++','Python']);
 const choice=schema.fields.find(f=>f.label==='Phone Device Type');assert.equal(choice.type,'combobox');
 const fills={[desc.id]:result.fills[desc.id],[skills.id]:result.fills[skills.id],[choice.id]:'Mobile'};
 const report=await page.evaluate(async fills=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill(fills,schema,registry)},fills);
 assert.deepEqual(report.failed,[]);assert.equal(report.filled.length,3);
 assert.deepEqual(await page.locator('ul li').allTextContents(),['C++','Python']);
 assert.equal(await page.locator('textarea').inputValue(),'Built TLS tests.\nReviewed C code.');
 // A missing C# must not count the existing C++ as success or add a duplicate.
 await page.evaluate(()=>{skills.oninput=()=>options.innerHTML='<div role="option">C++</div>'});
 const failed=await page.evaluate(async id=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[id]:['C#']},schema,registry)},skills.id);
 assert.equal(failed.failed.length,1);assert.equal(await page.locator('#skills').inputValue(),'');assert.deepEqual(await page.locator('ul li').allTextContents(),['C++','Python']);
});

test('Workday opens missing education and language entries once and maps saved answers',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<section data-automation-id="educationSection"><h3>Education</h3><button type="button">Add</button></section><section data-automation-id="languagesSection"><h3>Languages</h3><button type="button">Add</button></section><script>
 document.querySelectorAll('section').forEach(section=>section.querySelector('button').onclick=()=>{
 const edu=section.dataset.automationId==='educationSection';
 section.insertAdjacentHTML('afterbegin',edu?'<div><label>School or University<input data-automation-id="school"></label><label>Degree<input data-automation-id="degree"></label></div>':'<div><label>Language<input data-automation-id="language"></label><label>Speaking<input data-automation-id="speaking"></label></div>');});</script>`);
 for(const name of ['scrape.js','fill.js','history-rows.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',name)});
 const profile={education:[{school:'Example University',degree:'BS'}],languages:[{language:'English',speaking:'Fluent'}]};
 const schema=await page.evaluate(async profile=>{const ns=window.__formwork;await ns.fillHistory(async()=>profile);await ns.fillHistory(async()=>profile);return ns.scrape().schema},profile);
 assert.equal(schema.fields.length,4);
 const plan=lib('validate').validate({},schema,profile);
 assert.deepEqual(Object.values(plan.fills).sort(),['BS','English','Example University','Fluent'].sort());
 const report=await page.evaluate(async fills=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill(fills,schema,registry)},plan.fills);
 assert.deepEqual(report.failed,[]);assert.equal(report.filled.length,4);
});

test('Fill button recovers from a thrown scan and can retry',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent('<label>Name<input></label>');
 await page.evaluate(()=>window.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async m=>m.type==='fanout'?[]:{}}});
 for(const name of ['scrape.js','fill.js','index.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',name)});
 await page.evaluate(()=>{window.scanCount=0;window.__formwork.scrapeFull=async()=>{window.scanCount++;throw new Error('Page changed during scan')}});
 const button=page.getByRole('button',{name:'Fill this form',exact:true});await button.click();
 await page.getByText('Page changed during scan',{exact:true}).waitFor();assert.equal(await button.isEnabled(),true);
 await button.click();await page.waitForFunction(()=>window.scanCount===2);await page.locator('.panel button.primary:not([disabled])').waitFor();assert.equal(await button.isEnabled(),true);
});

test('type-to-add skills without a suggestion fail without pressing Enter or submitting',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<form><div data-automation-id="formField-skills"><label>Skills<input placeholder="Type to add skills"></label><ul data-automation-id="selectedItemList"></ul></div><button>Submit application</button></form><script>
 window.enterCount=0;window.submitted=0;
 document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();submitted++});
 document.querySelector('input').onkeydown=e=>{if(e.keyCode===13){e.preventDefault();enterCount++;const li=document.createElement('li');li.textContent=e.target.value;document.querySelector('ul').append(li);e.target.value=''}};</script>`);
 for(const name of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',name)});
 const result=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:['C++','Python']},schema,registry)});
 assert.equal(result.failed.length,1);assert.deepEqual(await page.locator('li').allTextContents(),[]);assert.equal(await page.evaluate(()=>enterCount),0);assert.equal(await page.evaluate(()=>submitted),0);
});

test('working indicator is visible during planning and cleared after failure',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent('<label>Name<input></label>');
 await page.evaluate(()=>window.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async m=>m.type==='plan'?new Promise((_,reject)=>window.failPlan=()=>reject(new Error('Connection lost'))):m.type==='fanout'?[]:{}}});
 for(const name of ['scrape.js','fill.js','index.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',name)});
 await page.getByRole('button',{name:'Fill this form',exact:true}).click();await page.waitForFunction(()=>!!window.failPlan);
 await page.getByText('Preparing answers from your profile…',{exact:true}).waitFor();assert.equal(await page.locator('.activity').isVisible(),true);assert.match(await page.locator('.activity').innerText(),/Preparing answers/);
 assert.equal(await page.locator('.spinner').evaluate(e=>getComputedStyle(e).animationName),'fw-spin');
 await page.evaluate(()=>failPlan());await page.getByText('Connection lost',{exact:true}).waitFor();
 assert.equal(await page.locator('.activity').isVisible(),false);assert.equal(await page.getByRole('button',{name:'Fill this form',exact:true}).isEnabled(),true);
});

test('skills keyboard fallback selects the exact option when clicks are ignored',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<div data-automation-id="formField-skills"><label>Skills<input aria-controls="menu"></label><ul data-automation-id="selectedItemList"></ul><div id="menu" role="listbox"></div></div><script>
 const input=document.querySelector('input');let index=-1;
 input.oninput=()=>{index=-1;menu.innerHTML=['C','C++','C#'].map((s,i)=>'<div id="o'+i+'" role="option">'+s+'</div>').join('')};
 input.onkeydown=e=>{if(e.key==='ArrowDown'){index++;input.setAttribute('aria-activedescendant','o'+index)}if(e.key==='Enter'&&index>=0){const li=document.createElement('li');li.textContent=menu.children[index].textContent;document.querySelector('ul').append(li);menu.innerHTML='';input.value=''}};</script>`);
 for(const name of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',name)});
 const report=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:['C++']},schema,registry)});
 assert.deepEqual(report.failed,[]);assert.deepEqual(await page.locator('li').allTextContents(),['C++']);
});

test('Workday skills clicks its nested checkbox once and waits for the selected chip',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<div data-automation-id="formField-skills"><label>Type to Add Skills<input data-uxi-widget-type="selectinput" placeholder="Search" aria-controls="menu"></label><ul data-automation-id="selectedItemList"></ul><div id="menu" role="listbox"></div></div><script>
 window.clicks=0;document.querySelector('input').oninput=()=>{setTimeout(()=>{menu.innerHTML='<div role="option"><input type="checkbox"><span data-automation-id="promptLeafNode">C++</span></div>';menu.querySelector('input').onclick=e=>{clicks++;setTimeout(()=>{document.querySelector('ul').innerHTML=e.target.checked?'<li>C++</li>':''},300)}},300)};</script>`);
 for(const name of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',name)});
 const report=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:['C++']},schema,registry)});
 assert.deepEqual(report.failed,[]);assert.equal(await page.evaluate(()=>clicks),1);assert.deepEqual(await page.locator('li').allTextContents(),['C++']);
});

test('Workday search fields keep their existing selection and skip enumeration',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<div data-automation-id="formField-fieldOfStudy"><label>Field of Study<input data-uxi-widget-type="selectinput" placeholder="Search"></label><ul data-automation-id="selectedItemList"><li>Computer Science</li></ul></div><script>window.opened=0;document.querySelector('input').onclick=()=>opened++;</script>`);
 for(const name of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',name)});
 const report=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=await ns.scrapeFull();return ns.fill({[schema.fields[0].id]:'Computer Science'},schema,registry)});
 assert.deepEqual(report.failed,[]);assert.equal(await page.evaluate(()=>opened),0);
});
