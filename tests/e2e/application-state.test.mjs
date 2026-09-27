import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';
for(const [text,kind,status] of [['This job has expired','application_expired','posting expired'],['Verifying the device...','verification_required','verification required']])test(`application state explains ${kind} and rechecks after page changes`,async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();await p.setContent(`<main><h1>${text}</h1></main>`);
 await p.evaluate(()=>{window.plans=0;window.reveals=0;window.chrome={runtime:{getManifest:()=>({version:'state-test'}),onMessage:{addListener(){},removeListener(){}},sendMessage:async m=>{if(m.type==='plan'){plans++;return {fills:{f0:'Dana'},review:[],dropped:[],missingRequired:[],staged:[]}}if(m.type==='reveal')reveals++;return m.type==='fanout'?[]:{};}},storage:{local:{get:async()=>({}),set:async()=>{}}}}});
 for(const file of ['scrape.js','fill.js','index.js'])await p.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 await p.getByRole('button',{name:'Fill this form',exact:true}).click();await p.getByText(status,{exact:true}).waitFor({timeout:1500});
 assert.deepEqual(await p.evaluate(async()=>({result:await __formwork.runFrame(),plans,reveals})),{result:{blocked:kind},plans:0,reveals:0});
 await p.evaluate(()=>{document.querySelector('main').innerHTML='<label for="name">First name</label><input id="name">'});
 await p.getByRole('button',{name:'Fill this form',exact:true}).click();await p.getByText('1 filled',{exact:true}).first().waitFor();assert.equal(await p.locator('#name').inputValue(),'Dana');
 await p.evaluate(text=>{document.querySelector('main').innerHTML='<h1></h1>';document.querySelector('h1').textContent=text},text);
 await p.getByRole('button',{name:'Fill this form',exact:true}).click();await p.getByText(status,{exact:true}).waitFor();assert.equal(await p.evaluate(()=>__formwork._last),undefined);
});

test('hidden or quoted blocker text does not stop an available form',async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();await p.setContent('<div hidden>This job has expired</div><p>Help article: Verifying the device...</p><label>First name<input></label>');
 await p.evaluate(()=>{window.chrome={runtime:{getManifest:()=>({version:'state-test'}),onMessage:{addListener(){},removeListener(){}},sendMessage:async()=>({})},storage:{local:{get:async()=>({}),set:async()=>{}}}}});
 for(const file of ['scrape.js','fill.js','index.js'])await p.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 assert.equal(await p.evaluate(()=>__formwork.applicationBlocker()),null);
 await p.getByRole('textbox',{name:'First name',exact:true}).evaluate(e=>e.remove());assert.equal(await p.evaluate(()=>__formwork.applicationBlocker()),null);
});

test('iCIMS email identification pauses filling only on its visible login surface',async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();
 await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<main><label>Email<input type="email"></label></main>'}));
 await p.goto('https://careers-example.icims.com/jobs/7810/software-engineer/login');
 await p.evaluate(()=>{window.plans=0;window.chrome={runtime:{getManifest:()=>({version:'state-test'}),onMessage:{addListener(){},removeListener(){}},sendMessage:async m=>{if(m.type==='plan')plans++;return m.type==='fanout'?[]:{};}},storage:{local:{get:async()=>({}),set:async()=>{}}}}});
 for(const file of ['scrape.js','fill.js','index.js'])await p.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 await p.getByRole('button',{name:'Fill this form',exact:true}).click();
 await p.getByText('sign-in required',{exact:true}).waitFor({timeout:1500});
 assert.equal(await p.evaluate(()=>plans),0);
 assert.equal(await p.locator('main input').inputValue(),'');
 await p.locator('main').evaluate(el=>el.hidden=true);
 assert.equal(await p.evaluate(()=>__formwork.applicationBlocker()),null);
 await p.locator('main').evaluate(el=>el.hidden=false);
 await p.evaluate(()=>history.replaceState({},'', '/jobs/7810/software-engineer/job'));
 assert.equal(await p.evaluate(()=>__formwork.applicationBlocker()),null);
});
