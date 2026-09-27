import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ROOT,profile} from '../helpers/load.mjs';
test('posting context survives application navigation, guides revisions, and never crosses job IDs',async t=>{
 const calls=[];
 const description='Responsibilities: develop embedded C device drivers and test SPI and I2C interfaces. Requirements: experience debugging hardware, writing unit tests and reviewing firmware changes. Work with electrical engineers on microcontroller-based devices.';
 const server=createServer((req,res)=>{
  if(req.method==='POST'){
   let body='';req.on('data',x=>body+=x);req.on('end',()=>{const input=JSON.parse(body);calls.push(input);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({content:input.json?'{}':'A reviewed firmware answer.'}));});return;
  }
  res.setHeader('Content-Type','text/html');
  res.end(req.url.startsWith('/jobs/123?')?`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',title:'Firmware Engineer',hiringOrganization:{name:'Widget Labs'},description})}</script><main><h1>Firmware Engineer</h1><p>${description}</p></main>`:
   '<main><h1>Application</h1><form><label>Email<input type="email"></label><label>Resume<input type="file" name="resume"></label><label>Why do you feel you are a fit for this role?<textarea></textarea></label></form></main>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()});
 const base=`http://127.0.0.1:${server.address().port}`;
 const dir=mkdtempSync(join(tmpdir(),'formwork-job-context-'));const ext=join(ROOT,'extension');
 const ctx=await chromium.launchPersistentContext(dir,{channel:'chromium',headless:true,args:[`--load-extension=${ext}`,`--disable-extensions-except=${ext}`]});t.after(async()=>{await ctx.close();rmSync(dir,{recursive:true,force:true})});
 const worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
 await worker.evaluate(({base,profile})=>chrome.storage.local.set({settings:{provider:'homelab',homelab:{baseUrl:base}},profile:{...profile,company_notes:[{company:'Tailscale',text:'UNRELATED_TAILNET_PITCH'}]},about:'I enjoy firmware engineering.',bank:[]}),{base,profile:profile()});
 const page=await ctx.newPage();await page.goto(base+'/jobs/123?utm_source=test');
 for(let i=0;i<50;i++){if(await worker.evaluate(async()=>Object.keys((await chrome.storage.local.get('jobContexts')).jobContexts||{}).length))break;await page.waitForTimeout(100);}
 await page.goto(base+'/jobs/123/application');
 await page.getByRole('button',{name:'Fill this form',exact:true}).waitFor();
 await page.locator('summary').filter({hasText:'Job description'}).click();
 await page.waitForFunction(()=>[...document.documentElement.children].some(n=>n.shadowRoot?.querySelector('textarea[aria-label="Job description"]')?.value.includes('SPI')));
 assert.equal(await page.getByRole('textbox',{name:'Employer for this application'}).inputValue(),'Widget Labs');
 await page.getByRole('button',{name:'Fill this form',exact:true}).click();await page.getByRole('textbox',{name:'Draft answer',exact:true}).waitFor();
 let prompt=calls.filter(c=>!c.json).at(-1).messages.map(m=>m.content).join('\n');assert.match(prompt,/SPI and I2C/);assert.doesNotMatch(prompt,/UNRELATED_TAILNET_PITCH/);
 await page.getByRole('textbox',{name:'Job description',exact:true}).fill('Requirements: embedded Rust firmware and board bring-up.');
 await page.getByRole('textbox',{name:'How should this change?'}).fill('Focus on the updated requirements.');
 await page.getByRole('button',{name:'Revise with instructions'}).click();await page.getByText('Revised — review and approve to fill.',{exact:true}).waitFor();
 prompt=calls.filter(c=>!c.json).at(-1).messages.map(m=>m.content).join('\n');assert.match(prompt,/embedded Rust firmware/);assert.doesNotMatch(prompt,/SPI and I2C/);
 await page.goto(base+'/jobs/456/application');await page.getByRole('button',{name:'Fill this form',exact:true}).waitFor();
 await page.locator('summary').filter({hasText:'Job description'}).click();assert.equal(await page.getByRole('textbox',{name:'Job description',exact:true}).inputValue(),'');
});
