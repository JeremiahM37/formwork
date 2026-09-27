/** Real dashboard → CDP driver → installed MV3 extension → local employer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,cpSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {ROOT,profile} from '../helpers/load.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));

test('dashboard prepares with the installed extension, replaces a reverted résumé and records confirmed versus uncertain submissions', {timeout:180000}, async t=>{
  const work=mkdtempSync(join(tmpdir(),'formwork-joint-'));
  const extension=join(work,'extension');cpSync(join(ROOT,'extension'),extension,{recursive:true});
  const manifest=JSON.parse(readFileSync(join(extension,'manifest.json'),'utf8'));
  manifest.host_permissions.push('http://localhost/*','http://127.0.0.1/*');
  manifest.content_scripts[0].matches.push('http://127.0.0.1/confirmed*','http://127.0.0.1/uncertain*');
  manifest.content_scripts[0].js=['src/content/scrape.js','src/content/fill.js','src/content/history-rows.js','src/content/index.js'];
  writeFileSync(join(extension,'manifest.json'),JSON.stringify(manifest));
  writeFileSync(join(work,'profile.json'),JSON.stringify(profile()));
  writeFileSync(join(work,'answers.json'),'{}');
  cpSync(join(ROOT,'tests/fixtures/resume.example.tex'),join(work,'resume.tex'));
  const received=[];
  const employer=createServer((req,res)=>{
    if(req.method==='POST') {
      const parts=[];req.on('data',b=>parts.push(b));req.on('end',()=>{
        res.setHeader('Content-Type','application/json');
        if(req.url==='/api/jobfill/complete') {res.end(JSON.stringify({content:'{}',model:'fixture'}));return;}
        received.push({url:req.url,body:Buffer.concat(parts)});res.end('{}');
      });return;
    }
    res.setHeader('Content-Type','text/html');
    res.end(`<h1>Fixture Engineer</h1><p>Fixture Employer — build Python services.</p>
      <form><label>First name<input name="first" autocomplete="given-name" required></label>
      <label>Last name<input name="last" autocomplete="family-name" required></label>
      <label>Email<input name="email" type="email" required></label>
      <label>Resume<input name="resume" type="file" required></label>
      <button type="submit">Submit your application</button></form>
      <script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();await fetch(location.pathname,{method:'POST',body:new FormData(e.target)});
      document.querySelector('form').outerHTML=location.pathname.includes('uncertain')?'<p>Thank you for visiting.</p>':'<h2>Your application was submitted to Fixture Employer</h2>'}</script>`);
  });
  await new Promise(r=>employer.listen(0,'127.0.0.1',r));
  const employerOrigin=`http://127.0.0.1:${employer.address().port}`;
  let ctx,proc;
  t.after(async()=>{
    if(proc && proc.exitCode===null) {proc.kill();await new Promise(r=>proc.once('exit',r));}
    if(ctx) await ctx.close();employer.closeAllConnections();employer.close();rmSync(work,{recursive:true,force:true});
  });
  const chromeProfile=join(work,'chrome');
  ctx=await chromium.launchPersistentContext(chromeProfile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--remote-debugging-port=0']});
  const cdpPort=readFileSync(join(chromeProfile,'DevToolsActivePort'),'utf8').split('\n')[0];
  const worker=ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  await worker.evaluate(async ({prof,base})=>chrome.storage.local.set({profile:prof,bank:[],about:'Fixture engineer',settings:{provider:'homelab',autoApprove:false,homelab:{baseUrl:base}},documents:{}}),{prof:profile(),base:employerOrigin});
  // Keep the real extension's options target available for normal driver discovery.
  const options=await ctx.newPage();await options.goto(new URL('/src/options/options.html',worker.url()).href);
  const python=[process.env.FORMWORK_TEST_PYTHON,join(homedir(),'.venvs/formwork-dashboard/bin/python'),'python3'].filter(Boolean).find(p=>spawnSync(p,['-c','import fastapi,uvicorn,httpx,docx,pypdf,pycountry,authlib']).status===0);
  assert.ok(python);
  proc=spawn(python,['-m','uvicorn','dashboard.app:app','--host','127.0.0.1','--port','0'],{cwd:join(ROOT,'server'),env:{...process.env,FORMWORK_STATE_DIR:work,FORMWORK_PROFILE_DIR:work,FORMWORK_CHROME_PROFILE:chromeProfile,FORMWORK_CDP_URL:`http://127.0.0.1:${cdpPort}`,FORMWORK_MODEL_URL:employerOrigin+'/api/jobfill/complete'}});
  let logs='';proc.stderr.on('data',d=>logs+=d);
  for(let i=0;i<300&&!/http:\/\/127\.0\.0\.1:\d+/.test(logs);i++) await wait(50);
  const origin=logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];assert.ok(origin,logs);
  const api=async(path,data)=>{const r=await fetch(origin+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});assert.ok(r.ok,`${path}: ${r.status} ${await r.clone().text()}`);return r.json();};
  await api('/api/settings',{values:{tailorResume:false,draftCoverLetter:false,autoMode:false}});
  for(const outcome of ['confirmed','uncertain']) {
    const record=await api('/api/applications',{url:employerOrigin+'/'+outcome,company:'Fixture Employer',title:'Fixture Engineer'});
    await api(`/api/applications/${record.id}/prepare`,{});
    let prepared;
    for(let i=0;i<600;i++) {prepared=await api(`/api/applications/${record.id}`);if(prepared.progress?.done)break;await wait(100);}
    assert.equal(prepared.status,'ready',JSON.stringify(prepared));
    const form=ctx.pages().find(p=>p.url()===record.url);assert.ok(form);
    assert.equal(await form.locator('[name="first"]').inputValue(),profile().identity.first_name);
    assert.equal(received.length,outcome==='confirmed'?0:1,'Preparation must not submit');
    assert.equal(await form.locator('[name="resume"]').evaluate(el=>el.files.length),1,JSON.stringify(prepared.snapshot));
    const file=await form.locator('[name="resume"]').evaluate(async el=>({name:el.files[0]?.name,bytes:Array.from(new Uint8Array(await el.files[0].arrayBuffer()))}));
    assert.equal(file.name,prepared.snapshot.expectedResume.filename);
    const original=Buffer.from(file.bytes);assert.equal(createHash('sha256').update(original).digest('hex'),prepared.snapshot.expectedResume.sha256);
    // Simulate the site reopening a draft with an older selected attachment.
    await form.locator('[name="resume"]').setInputFiles({name:'Old.pdf',mimeType:'application/pdf',buffer:Buffer.from('old')});
    const refreshed=await api(`/api/applications/${record.id}/refresh`,{});assert.equal(refreshed.resumeCheck.status,'mismatch');
    assert.equal((await api(`/api/applications/${record.id}/submit`,{})).ok,false);
    assert.equal((await api(`/api/applications/${record.id}/resume/attach`,{})).ok,true);
    const dashboard=await ctx.newPage();await dashboard.goto(origin);
    // Open the review through its public UI; submit uses both the real preflight and real confirmation dialog.
    await dashboard.getByRole('button',{name:/^Applications/}).click();
    await dashboard.getByRole('button',{name:'Open',exact:true}).first().click();
    dashboard.on('dialog',dialog=>dialog.accept());
    await dashboard.getByRole('button',{name:'Submit application',exact:true}).click();
    await dashboard.getByText(outcome==='confirmed'?'Submitted — the page confirmed it.':'Submission unconfirmed. Check the employer record; retry is blocked.',{exact:true}).waitFor({timeout:30000});
    const saved=await api(`/api/applications/${record.id}`);
    assert.equal(saved.status,outcome==='confirmed'?'submitted':'submission_unconfirmed');
    assert.ok(received.at(-1).body.includes(original),'Employer received exact prepared bytes');
    assert.equal((await fetch(origin+`/api/applications/${record.id}/submit`,{method:'POST'})).status,409);
    await dashboard.close();
  }
  assert.equal(received.length,2,'Exactly one send per explicitly submitted application');
});
