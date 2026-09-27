import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';
const scripts=['scrape.js','fill.js','index.js'];
async function inject(page){for(const name of scripts)await page.addScriptTag({path:join(ROOT,'extension/src/content',name)})}
test('close hides the panel even when an earlier extension left a remounting panel behind',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent('<button>Apply</button>');
 await page.evaluate(()=>{
  window.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async()=>({})}};
  window.__formwork={_initialized:true};
  const old=document.createElement('div');const shadow=old.attachShadow({mode:'open'});
  shadow.innerHTML='<div class="panel" style="position:fixed;right:16px;bottom:16px;background:white"><textarea>Unsaved older draft</textarea><footer>formwork never submits. Review the highlights, then submit yourself.</footer></div>';
  document.documentElement.append(old);window.oldHost=old;
  new MutationObserver(()=>{if(!old.isConnected)document.documentElement.append(old)}).observe(document.documentElement,{childList:true});
 });
 await inject(page);
 assert.equal(await page.locator('.panel:visible').count(),1);
 await page.getByRole('button',{name:'Hide Formwork',exact:true}).click();
 await page.waitForTimeout(1700);
 assert.equal(await page.locator('.panel:visible').count(),0,'no stale large panel may remain under the closed current panel');
 assert.equal(await page.getByRole('button',{name:'Reopen Formwork',exact:true}).isVisible(),true);
 assert.equal(await page.evaluate(()=>window.oldHost.shadowRoot.querySelector('textarea').value),'Unsaved older draft','retirement must not erase old draft text');
 await page.getByRole('button',{name:'Reopen Formwork',exact:true}).click();assert.equal(await page.locator('.panel:visible').count(),1);
});
test('a replaced content-script instance cannot bring its panel or launcher back',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent('<p>Application page</p>');
 await page.evaluate(()=>{window.listeners=[];window.chrome={runtime:{onMessage:{addListener:fn=>window.listeners.push(fn)},sendMessage:async()=>({})}}});
 await inject(page);
 await page.evaluate(()=>{window.previousPanel=window.__formwork._panel;window.__formwork._uiVersion="older-version"});
 await inject(page);await page.waitForTimeout(50);
 assert.equal(await page.locator('.panel:visible').count(),1);
 await page.getByRole('button',{name:'Hide Formwork',exact:true}).click();
 await page.evaluate(()=>{window.previousPanel.toggle();document.documentElement.append(document.createElement('div'))});
 await page.waitForTimeout(1700);assert.equal(await page.locator('.panel:visible').count(),0);
 assert.equal(await page.getByRole('button',{name:'Reopen Formwork',exact:true}).count(),1);
 await page.getByRole('button',{name:'Reopen Formwork',exact:true}).click();assert.equal(await page.locator('.panel:visible').count(),1);
 await page.evaluate(()=>window.listeners.forEach(fn=>fn({type:'formwork/toggle-current'})));
 assert.equal(await page.locator('.panel:visible').count(),0,'only the owning listener may toggle');
});
