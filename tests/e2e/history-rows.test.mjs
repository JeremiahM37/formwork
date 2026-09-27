import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT,lib,profile} from '../helpers/load.mjs';
const {validate}=lib('validate');

const fixture=`<main><div data-ui="education"><button type="button" data-ui="add-section" aria-label="Add Education">Add</button><ul></ul></div><div data-ui="experience"><button type="button" data-ui="add-section" aria-label="Add Experience">Add</button><ul></ul></div><button type="submit" id="submit">Submit application</button></main><script>
window.submits=0;submit.onclick=()=>submits++;
for(const root of document.querySelectorAll('[data-ui=education],[data-ui=experience]'))root.querySelector('button').onclick=()=>{
 const education=root.dataset.ui==='education';const li=document.createElement('li');const editor=document.createElement('div');editor.dataset.ui='editor';li.append(editor);root.querySelector('ul').append(li);
 const names=education?['school','degree','field_of_study','start_date','end_date']:['company','title','summary','start_date','end_date','current'];
 for(const name of names){const label=document.createElement('label');label.textContent=name;const input=document.createElement(name==='summary'?'textarea':'input');input.name=name;if(['school','company','title'].includes(name))input.required=true;if(name.endsWith('_date'))input.placeholder='MM/YYYY';if(name==='current')input.type='checkbox';label.append(input);editor.append(label);}
 const update=document.createElement('button');update.type='button';update.dataset.ui='save-section';update.textContent='Update';editor.append(update);
 update.onclick=()=>{const group=document.createElement('div');group.dataset.ui='group';for(const input of editor.querySelectorAll('input,textarea')){const span=document.createElement('span');span.dataset.ui=input.name;span.textContent=input.type==='checkbox'?String(input.checked):input.value;group.append(span);}li.replaceChildren(group);};
};</script>`;

async function setup(t,p=profile()){
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.setContent(fixture);
 for(const file of ['scrape.js','fill.js','history-rows.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 await page.exposeFunction('historyMessage',async(type,payload)=>type==='historyRecords'?Object.fromEntries(['education','experience'].map(kind=>[kind,(p[kind]||[]).map((r,index)=>({...r,index}))])):validate({},payload.schema,p));
 return page;
}

test('every distinct history entry is added with its own facts and reruns do not duplicate',{timeout:20000},async t=>{
 const p=profile();p.education.push({school:'Second University',degree:'M.S.',field_of_study:'Robotics',start:'September 2023',end:'May 2025'});p.experience.push({employer:'Earlier Lab',title:'Intern',start:'May 2021',end:'August 2021',current:false,bullets:['Built 45 tests.','Documented four services.']});
 const page=await setup(t,p);
 const first=await page.evaluate(()=>window.__formwork.fillHistory(window.historyMessage));assert.equal(first.saved,4);assert.deepEqual(first.issues,[]);
 const internships=page.locator('[data-ui=experience] [data-ui=group]').last();assert.equal(await internships.locator('[data-ui=company]').textContent(),'Earlier Lab');assert.equal(await internships.locator('[data-ui=summary]').textContent(),'Built 45 tests.\nDocumented four services.');assert.equal(await internships.locator('[data-ui=start_date]').textContent(),'05/2021');
 const again=await page.evaluate(()=>window.__formwork.fillHistory(window.historyMessage));assert.equal(again.saved,0);assert.equal(again.existing,4);assert.equal(await page.locator('[data-ui=group]').count(),4);assert.equal(await page.evaluate(()=>submits),0);
});

test('an unfinished user edit is preserved and protected from the ordinary fill',async t=>{
 const page=await setup(t);await page.getByRole('button',{name:'Add Experience'}).click();await page.locator('input[name=company]').fill('User-entered company');
 const report=await page.evaluate(()=>window.__formwork.fillHistory(window.historyMessage));assert.match(report.issues.join(' '),/finish or cancel/);assert.equal(await page.locator('input[name=company]').inputValue(),'User-entered company');assert.equal(await page.evaluate(()=>window.__formwork.historyEditorProtected(document.querySelector('input[name=company]'))),true);
});

test('a failed required history field leaves the entry open and unsaved',async t=>{
 const page=await setup(t);await page.getByRole('button',{name:'Add Experience'}).click();await page.locator('input[name=title]').evaluate(e=>e.addEventListener('input',()=>{e.value=''}));
 const report=await page.evaluate(()=>window.__formwork.fillHistory(window.historyMessage));assert.match(report.issues.join(' '),/not saved/);assert.equal(await page.locator('[data-ui=experience] [data-ui=group]').count(),0);assert.equal(await page.locator('[data-ui=experience] [data-ui=editor]').count(),1);assert.equal(await page.evaluate(()=>submits),0);
});

test('year-only history dates are flagged instead of inventing months',async t=>{
 const p=profile();p.education[0].start='2018';
 const page=await setup(t,p);
 const report=await page.evaluate(()=>window.__formwork.fillHistory(window.historyMessage));
 assert.match(report.issues.join(' '),/saved date cannot be transcribed/);
 assert.equal(await page.locator('[data-ui=education] [data-ui=group] [data-ui=start_date]').textContent(),'');
 assert.equal(await page.evaluate(()=>submits),0);
});
