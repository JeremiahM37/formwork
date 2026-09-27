import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';
for(const width of [360,1280])test(`panel can be dismissed while busy and reopened without losing drafts (${width}px)`,async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:640}});
 await page.setContent('<label>Why this role?<textarea></textarea></label>');
 await page.evaluate(()=>{window.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async m=>{
  if(m.type==='plan')return new Promise(resolve=>window.finishPlan=()=>resolve({fills:{},review:[],dropped:[],missingRequired:[],staged:[{id:'f0',question:'Why this role?',text:'Keep this draft'}]}));
  return m.type==='fanout'?[]:{};
 }}}});
 for(const file of ['scrape.js','fill.js','index.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const close=page.getByRole('button',{name:'Hide Formwork',exact:true});
 await page.getByRole('button',{name:'Fill this form',exact:true}).click();
 await page.waitForFunction(()=>!!window.finishPlan);
 await page.evaluate(()=>document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 assert.equal(await close.isVisible(),true,'Scraper dropdown Escape must not dismiss the panel');
 // A real pointer click checks reachability; programmatic DOM click does not.
 await close.click();assert.equal(await close.count(),0);
 await page.evaluate(()=>{window.finishPlan();document.body.append(document.createElement('div'))});
 await page.waitForTimeout(1600);assert.equal(await close.count(),0);
 await page.getByRole('button',{name:'Reopen Formwork',exact:true}).click();
 const draft=page.getByRole('textbox',{name:'Draft answer',exact:true});
 await draft.fill('My edited answer');
 await page.keyboard.press('Escape');assert.equal(await close.count(),0);
 await page.getByRole('button',{name:'Reopen Formwork',exact:true}).click();assert.equal(await draft.inputValue(),'My edited answer');
 const rect=await close.boundingBox();assert.ok(rect.x>=0 && rect.x+rect.width<=width && rect.height>=44);
 await close.click();assert.equal(await close.count(),0);
});
