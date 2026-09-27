import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtempSync,readFileSync,writeFileSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {ROOT} from '../helpers/load.mjs';

test('model connection tests inside real Chrome, preserves data, and reports denied/unreachable hosts',{timeout:45000},async t=>{
  const requests=[];
  const server=createServer((req,res)=>{
    let body='';req.on('data',s=>body+=s);req.on('end',()=>{
      requests.push({url:req.url,body:JSON.parse(body)});
      res.setHeader('Content-Type','application/json');
      if(req.url.startsWith('/failed/')) {res.statusCode=503;res.end('{}');}
      else res.end(JSON.stringify({content:'ready'}));
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  const directory=mkdtempSync(join(tmpdir(),'formwork-model-connect-'));
  const extension=join(directory,'extension');cpSync(join(ROOT,'extension'),extension,{recursive:true});
  const manifest=JSON.parse(readFileSync(join(extension,'manifest.json')));
  // The fixture grants only its local HTTP server, as a user-approved host would be.
  manifest.host_permissions=['http://127.0.0.1/*'];
  manifest.content_scripts[0].matches=['http://127.0.0.1/*'];
  writeFileSync(join(extension,'manifest.json'),JSON.stringify(manifest));
  const chromeDir=join(directory,'chrome');
  const context=await chromium.launchPersistentContext(chromeDir,{channel:'chromium',headless:true,
    args:[`--load-extension=${extension}`,`--disable-extensions-except=${extension}`,'--remote-debugging-port=0']});
  t.after(async()=>{await context.close();rmSync(directory,{recursive:true,force:true});});
  const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(()=>chrome.storage.local.set({profile:{identity:{full_name:'Fixture'}},
    settings:{provider:'ollama',ollama:{baseUrl:'http://localhost:11434',model:'fixture'},autoApprove:false},bank:[{text:'keep me'}]}));
  const original=await worker.evaluate(()=>chrome.storage.local.get(null));
  const port=readFileSync(join(chromeDir,'DevToolsActivePort'),'utf8').split('\n')[0];
  const run=async data=>JSON.parse((await promisify(execFile)(process.execPath,['server/dashboard/drive.mjs','modelConnection',JSON.stringify(data)],
    {cwd:ROOT,env:{...process.env,FORMWORK_CDP_URL:`http://localhost:${port}`,FORMWORK_CHROME_PROFILE:chromeDir}})).stdout);
  assert.equal((await run({baseUrl,testOnly:true})).ok,false);
  const missing=await run({baseUrl:'http://unpermitted.test'});
  assert.equal(missing.needsPermission,true);
  assert.deepEqual(await worker.evaluate(()=>chrome.storage.local.get(null)),original);
  const pending=context.pages().find(p=>p.url().includes('connect.html'));
  assert.ok(pending);assert.equal(await pending.getByRole('button',{name:'Allow access and connect'}).count(),1);
  await assert.rejects(run({baseUrl:baseUrl+'/failed'}),err=>/503/.test(JSON.parse(err.stdout).error));
  assert.deepEqual(await worker.evaluate(()=>chrome.storage.local.get(null)),original);
  const receipt=await run({baseUrl});assert.equal(receipt.ok,true);assert.equal(receipt.reply,'ready');
  const saved=await worker.evaluate(()=>chrome.storage.local.get(null));
  assert.equal(saved.settings.provider,'homelab');assert.equal(saved.settings.homelab.baseUrl,baseUrl);
  assert.equal(saved.settings.autoApprove,false);assert.deepEqual(saved.profile,original.profile);assert.deepEqual(saved.bank,original.bank);
  assert.equal((await run({baseUrl,testOnly:true})).ok,true);
  writeFileSync(join(directory,'profile.json'),JSON.stringify(original.profile));
  await promisify(execFile)(process.execPath,['server/dashboard/seed.mjs'],{cwd:ROOT,env:{...process.env,
    FORMWORK_CDP_URL:`http://localhost:${port}`,FORMWORK_PROFILE_DIR:directory,FORMWORK_MODEL_URL:'http://wrong-default.test/api/jobfill/complete'}});
  assert.deepEqual((await worker.evaluate(()=>chrome.storage.local.get('settings'))).settings,saved.settings);
  assert.equal(requests.at(-1).url,'/api/jobfill/complete');
  assert.equal(requests.at(-1).body.messages[0].content,'Reply with the word ready.');
});
