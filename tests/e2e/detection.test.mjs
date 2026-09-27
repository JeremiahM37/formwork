import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {ROOT} from '../helpers/load.mjs';

const panel=()=>[...document.documentElement.children].some(e=>e.shadowRoot?.querySelector('.panel'));
const job='<form><h1>Job application</h1><label>Name<input name="name"></label><label>Email<input type="email"></label><label>Resume<input type="file" name="resume"></label></form>';
test('automatic panel detects delayed and embedded applications, stays dismissed, and ignores ordinary forms',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'formwork-detect-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let writes=0;
 const server=createServer((req,res)=>{if(req.method==='POST')writes++;res.setHeader('Content-Type','text/html');res.end('<!doctype html>'+(
  req.url==='/job'?job:req.url==='/embedded'?'<h1>Company careers</h1><iframe src="/job"></iframe>':
  '<h1>Contact us</h1><form><label>Name<input name="name"></label><label>Email<input type="email"></label><textarea></textarea></form>'))});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()});
 const base=`http://127.0.0.1:${server.address().port}`,ext=join(ROOT,'extension');
 const ctx=await chromium.launchPersistentContext(dir,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});t.after(()=>ctx.close());
 const page=await ctx.newPage();await page.goto(base+'/ordinary');await page.waitForTimeout(900);assert.equal(await page.evaluate(panel),false);
 await page.evaluate(html=>document.body.innerHTML=html,job);await page.waitForFunction(panel);
 assert.equal(await page.locator('input[type=email]').inputValue(),'');
 await page.evaluate(()=>[...document.documentElement.children].find(e=>e.shadowRoot?.querySelector('.panel')).shadowRoot.querySelector('button[aria-label]').click());
 await page.evaluate(()=>document.body.append(document.createElement('p')));await page.waitForTimeout(1000);assert.equal(await page.evaluate(panel),false);
 await page.goto(base+'/embedded');await page.waitForFunction(panel);assert.equal(await page.frames()[1].evaluate(panel),false);
 assert.equal(writes,0,'Detection must not request model output or submit anything');
});
