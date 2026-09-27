import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,cpSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {ROOT} from '../helpers/load.mjs';

test('extension analyzes a posting and switches resume without filling or automatically saving', {timeout:45000},async t=>{
 const work=mkdtempSync(join(tmpdir(),'formwork-analysis-'));t.after(()=>rmSync(work,{recursive:true,force:true}));
 const ext=join(work,'extension');cpSync(join(ROOT,'extension'),ext,{recursive:true});
 const path=join(ext,'manifest.json'),manifest=JSON.parse(readFileSync(path));
 // These fixtures exercise explicit manual opening, including non-application forms.
 // Automatic detection is tested separately with the unmodified manifest.
 manifest.content_scripts[0].js=["src/content/scrape.js","src/content/fill.js","src/content/history-rows.js","src/content/index.js"];
 manifest.host_permissions.push('http://localhost/*','http://127.0.0.1/*');manifest.content_scripts[0].matches=['http://localhost/*'];writeFileSync(path,JSON.stringify(manifest));
 const calls=[];const server=createServer((req,res)=>{
  if(req.method==='POST') {
   let text='';req.on('data',v=>text+=v);req.on('end',()=>{
    const body=JSON.parse(text);calls.push({path:req.url,body});res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.url==='/api/applications' ? {id:1} : {fit:{coverage:50,matched:[{skill:'Python',evidence:'Built Python APIs'}],missing:[{skill:'SQL',posting:'SQL required'}],explanation:'Recognized evidence only'},versions:[{id:7,name:'Backend'}],note:'Nothing changed'}));
   });return;
  }
  res.setHeader('Content-Type','text/html');res.end('<main><h1>Python Engineer</h1><p>Python and SQL required</p><form><label>Name<input id="name" value="Private value"></label><textarea>PRIVATE NOTES</textarea></form></main>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const ctx=await chromium.launchPersistentContext(join(work,'browser'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});t.after(()=>ctx.close());
 const sw=ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
 await sw.evaluate(base=>chrome.storage.local.set({settings:{dashboardUrl:base}}),base);
 const page=await ctx.newPage();await page.goto(base.replace('127.0.0.1','localhost'));
 await page.getByRole('button',{name:'Analyze job',exact:true}).click();
 await page.getByText('50% of recognized skills evidenced',{exact:true}).waitFor();
 assert.equal(await page.locator('#name').inputValue(),'Private value');assert.equal(calls.length,1);
 assert.ok(!calls[0].body.description.includes('PRIVATE NOTES'));assert.ok(!calls[0].body.description.includes('Private value'));
 await page.getByLabel('Resume to analyze').selectOption('7');
 await page.waitForFunction(()=>[...document.documentElement.children].some(n=>n.shadowRoot?.querySelector('select')?.value==='7'));
 assert.equal(calls[1].body.version_id,7);assert.ok(calls.every(c=>c.path==='/api/posting-analysis'));
 await page.getByRole('button',{name:'Save job to Formwork'}).click();await page.getByRole('button',{name:'Job saved',exact:true}).waitFor();
 assert.equal(calls[2].path,'/api/applications');assert.equal(calls[2].body.source,'extension');
 assert.equal(await page.locator('#name').inputValue(),'Private value');
 await page.getByRole('button',{name:'Hide Formwork',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Analyze job',exact:true}).count(),0);
 await sw.evaluate(async()=>{const tab=(await chrome.tabs.query({})).find(t=>t.url?.startsWith('http://localhost:'));await chrome.tabs.sendMessage(tab.id,{type:'formwork/toggle-current'});});
 await page.getByRole('button',{name:'Analyze job',exact:true}).waitFor();
});
