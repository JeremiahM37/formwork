import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';
for(const touch of [false,true])test(`launcher ${touch?'touch':'mouse'} drag moves without opening, persists, and stays on screen`,async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:touch?390:1100,height:700},hasTouch:touch});
 async function setup(saved={}){
  const page=await context.newPage();await page.setContent('<button style="position:fixed;right:12px;bottom:12px;width:100px;height:44px" onclick="window.applied=true">Apply</button>');
  await page.evaluate(initial=>{window.saved=initial;window.chrome={storage:{local:{get:async()=>window.saved,set:async value=>Object.assign(window.saved,value)}},runtime:{onMessage:{addListener(){}}}}},saved);
  for(const file of ['scrape.js','fill.js','index.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
  await page.getByRole('button',{name:'Hide Formwork',exact:true}).click();return page;
 }
 const page=await setup();const button=page.getByRole('button',{name:'Reopen Formwork',exact:true});const start=await button.boundingBox();
 const x=start.x+start.width/2,y=start.y+start.height/2;
 if(touch){
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:75,y:100}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 }else{
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(75,100,{steps:8});await page.mouse.up();
 }
 assert.equal(await button.isVisible(),true,'drag must not reopen the panel');
 assert.equal(await page.getByRole('button',{name:'Hide Formwork',exact:true}).count(),0);
 assert.notEqual(await page.evaluate(()=>window.applied),true,'drag must not activate the underlying Apply button');
 const moved=await button.boundingBox();assert.ok(moved.y<150 && moved.x<100);
 const saved=await page.evaluate(()=>window.saved);assert.ok(saved.launcherPosition);
 const fresh=await setup(saved);const restored=fresh.getByRole('button',{name:'Reopen Formwork',exact:true});const rect=await restored.boundingBox();assert.ok(Math.abs(rect.x-moved.x)<2 && Math.abs(rect.y-moved.y)<2);
 await fresh.setViewportSize({width:280,height:300});const small=await restored.boundingBox();assert.ok(small.x>=8 && small.y>=8 && small.x+small.width<=272 && small.y+small.height<=292);
 await restored.focus();await fresh.keyboard.press('ArrowRight');const keyboard=await restored.boundingBox();assert.ok(keyboard.x>small.x);
 await restored.click();await fresh.getByRole('button',{name:'Hide Formwork',exact:true}).waitFor();
});
