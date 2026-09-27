import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';
for(const shadow of [false,true])test(`panel remains usable through native modal lifecycle (shadow=${shadow})`,async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();
 await p.setContent('<button id="launch">Open application</button><section id="application"></section>');
 await p.evaluate(shadow=>{
  const scope=shadow?document.querySelector('#application').attachShadow({mode:'open'}):document.querySelector('#application');
  scope.innerHTML='<dialog><label>Candidate note<input></label><button type="button" id="close-dialog">Close application</button></dialog>';
  const d=scope.querySelector('dialog');document.querySelector('#launch').onclick=()=>d.showModal();scope.querySelector('#close-dialog').onclick=()=>d.close();
  window.chrome={runtime:{onMessage:{addListener(){},removeListener(){}},getManifest:()=>({version:'modal-test'}),sendMessage:async m=>m.type==='fanout'?[]:{}},storage:{local:{get:async()=>({}),set:async()=>{}}}};
 },shadow);
 for(const file of ['scrape.js','fill.js','index.js'])await p.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const hide=p.getByRole('button',{name:'Hide Formwork',exact:true});
 await p.getByRole('button',{name:'Open application',exact:true}).click();
 await hide.click({timeout:2000});
 await p.getByRole('button',{name:'Reopen Formwork',exact:true}).click({timeout:2000});
 await p.getByRole('textbox',{name:'Candidate note',exact:true}).fill('Retain my page state');
 await p.getByRole('button',{name:'Close application',exact:true}).click();
 await hide.click({timeout:2000});
 await p.getByRole('button',{name:'Reopen Formwork',exact:true}).click({timeout:2000});
 assert.equal(await p.locator('[data-formwork-ui="panel"]').count(),1);
 assert.equal(await p.locator('[data-formwork-ui="panel"]').evaluate(e=>e.parentElement===document.documentElement),true);
 assert.equal(await p.locator('#application input').inputValue(),'Retain my page state');
});
