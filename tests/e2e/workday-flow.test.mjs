import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {inspectWorkdayStep,advanceWorkday,enterWorkday} from '../../tools/workday-flow.mjs';
import {openPanel} from '../../server/dashboard/drive.mjs';

const URL='https://fixture.wd5.myworkdayjobs.com/en-US/External/job/Denver/Engineer_R1';
const fixture=`<main id="app"><button data-automation-id="adventureButton" onclick="app.innerHTML='<button data-automation-id=applyManually onclick=manual()>Apply Manually</button>'">Apply</button></main>
<script>
 window.sent=0;window.saved=0;
 window.manual=()=>{history.pushState({},'',location.pathname+'/apply/applyManually');app.innerHTML='<button data-automation-id="SignInWithEmailButton">Sign in with email</button>'};
 window.information=()=>{app.innerHTML='<h1 data-automation-id="pageHeaderTitle">My Information</h1><label for="name">Full Name</label><input id="name"><button data-automation-id="bottom-navigation-next-button" onclick="save()">Save and Continue</button><p role="alert"></p>'};
 window.save=()=>{if(!document.querySelector('#name').value){document.querySelector('[role=alert]').textContent='Name is required';return}window.saved++;app.innerHTML='<h1 data-automation-id="pageHeaderTitle">Review</h1><button data-automation-id="wd-Submit" onclick="window.sent++">Submit</button><button onclick="window.sent++">Next</button>'};
</script>`;

test('a direct Workday apply URL still opens Apply Manually and stops at login',async t=>{
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:fixture}));await page.goto(URL+'/apply');
 await page.locator('[data-automation-id=adventureButton]').click();
 const flow=await enterWorkday(page);
 assert.equal(flow.kind,'login');assert.equal(await page.evaluate(()=>sent),0);
});

test('Workday progression targets the footer, refuses competing footers, and preserves final review',async t=>{
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:fixture}));await page.goto(URL+'/apply');
 await page.evaluate(()=>{information();app.insertAdjacentHTML('afterbegin','<button id="unrelated" onclick="window.sent++">Continue</button>');});
 let flow=await page.evaluate(inspectWorkdayStep);
 assert.equal(flow.kind,'next');assert.equal(await page.locator('[data-formwork-next="1"]').getAttribute('data-automation-id'),'bottom-navigation-next-button');
 await page.evaluate(()=>app.insertAdjacentHTML('beforeend','<button data-automation-id="pageFooterNext" onclick="window.sent++">Save and Continue</button>'));
 flow=await page.evaluate(inspectWorkdayStep);assert.equal(flow.kind,'unknown');
 await assert.rejects(advanceWorkday(page,flow.fingerprint),/intermediate/);assert.equal(await page.evaluate(()=>sent),0);
 await page.evaluate(()=>app.insertAdjacentHTML('beforeend','<button data-automation-id="wd-Submit">Submit</button>'));
 assert.equal((await page.evaluate(inspectWorkdayStep)).kind,'review');
});

test('Workday entry pauses at login, validates intermediate steps, and never advances a final submit',{timeout:40000},async t=>{
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:fixture}));await page.goto(URL);
 let flow=await enterWorkday(page);assert.equal(flow.kind,'login');assert.match(page.url(),/applyManually/);
 await assert.rejects(advanceWorkday(page,flow.fingerprint),/intermediate/);
 await page.evaluate(()=>information());flow=await page.evaluate(inspectWorkdayStep);assert.equal(flow.kind,'next');
 await assert.rejects(advanceWorkday(page,'stale'),/changed/);assert.equal(await page.evaluate(()=>saved),0);
 let result=await advanceWorkday(page,flow.fingerprint);assert.equal(result.advanced,false);assert.deepEqual(result.flow.errors,['Name is required']);
 await page.getByLabel('Full Name').fill('Fixture Candidate');result=await advanceWorkday(page,flow.fingerprint);assert.equal(result.advanced,true);assert.equal(result.flow.kind,'review');
 await assert.rejects(advanceWorkday(page,result.flow.fingerprint),/intermediate/);assert.equal(await page.evaluate(()=>sent),0);assert.equal(await page.evaluate(()=>saved),1);
});

test('dashboard driver resumes the same Workday tab, fills with the extension, and stops at review',{timeout:65000},async t=>{
 const {mkdtempSync,readFileSync,writeFileSync,cpSync,rmSync}=await import('node:fs');
 const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const {createServer}=await import('node:http');const {ROOT}=await import('../helpers/load.mjs');
 const model=createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({content:'{}'}));});});
 await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));t.after(()=>{model.closeAllConnections();model.close();});
 const directory=mkdtempSync(join(tmpdir(),'formwork-step-driver-'));const extension=join(directory,'extension');cpSync(join(ROOT,'extension'),extension,{recursive:true});
 const manifest=JSON.parse(readFileSync(join(extension,'manifest.json')));manifest.host_permissions.push('http://127.0.0.1/*');writeFileSync(join(extension,'manifest.json'),JSON.stringify(manifest));
 const chromeDir=join(directory,'chrome');const context=await chromium.launchPersistentContext(chromeDir,{channel:'chromium',headless:true,
   args:[`--load-extension=${extension}`,`--disable-extensions-except=${extension}`,'--remote-debugging-port=0']});
 t.after(async()=>{await context.close();rmSync(directory,{recursive:true,force:true});});
 await context.route('https://fixture.wd5.myworkdayjobs.com/**',route=>route.fulfill({contentType:'text/html',body:fixture}));
 const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
 await worker.evaluate(baseUrl=>chrome.storage.local.set({profile:{schema_version:1,identity:{full_name:'Fixture Candidate',email:'fixture@example.test',phone_type:'Mobile'}},
   settings:{provider:'homelab',homelab:{baseUrl},autoApprove:false}}),`http://127.0.0.1:${model.address().port}`);
 const port=readFileSync(join(chromeDir,'DevToolsActivePort'),'utf8').split('\n')[0];
 const run=async(command,data)=>JSON.parse((await promisify(execFile)(process.execPath,['server/dashboard/drive.mjs',command,JSON.stringify(data)],
   {cwd:ROOT,env:{...process.env,FORMWORK_CDP_URL:`http://localhost:${port}`,FORMWORK_CHROME_PROFILE:chromeDir}})).stdout);
 let result=await run('fill',{url:URL});assert.equal(result.flow.kind,'login');assert.equal(result.fields.length,0);
 const page=context.pages().find(p=>p.url().startsWith(URL));assert.ok(page);await page.evaluate(()=>information());
 const duplicate=await context.newPage();await duplicate.goto(URL+'/apply');await duplicate.evaluate(()=>information());
 await page.getByLabel('Full Name').fill('First tab human edit');
 await duplicate.getByLabel('Full Name').fill('Second tab human edit');
 const ambiguous=error=>/multiple tabs/i.test(JSON.parse(error.stdout || '{}').error || '');
 await assert.rejects(run('fill',{url:URL,resume:true}),ambiguous);
 await assert.rejects(run('read',{url:URL}),ambiguous);
 assert.equal(await page.getByLabel('Full Name').inputValue(),'First tab human edit');
 assert.equal(await duplicate.getByLabel('Full Name').inputValue(),'Second tab human edit');
 assert.equal(await page.evaluate(()=>saved),0);assert.equal(await duplicate.evaluate(()=>saved),0);
 await duplicate.close();
 await page.evaluate(()=>{
   app.insertAdjacentHTML('beforeend','<div data-automation-id="formFieldPhone"><label for="phonetype">Phone Device Type</label><button id="phonetype" role="combobox" aria-haspopup="listbox" aria-controls="phoneoptions" aria-invalid="true">Choose</button><div id="phoneoptions" role="listbox" hidden><div role="option">Mobile</div><div role="option">Landline</div></div></div>');
   phonetype.onclick=()=>phoneoptions.hidden=false;
   for(const option of phoneoptions.children) option.onclick=event=>{if(event.isTrusted){phonetype.textContent=option.textContent;phonetype.setAttribute('aria-invalid','false');phoneoptions.hidden=true;}};
 });
 result=await run('fill',{url:URL,resume:true});assert.equal(result.flow.kind,'next');assert.equal(await page.getByLabel('Full Name').inputValue(),'Fixture Candidate',JSON.stringify(result.fields));
 assert.ok(result.trustedInput.some(attempt=>attempt.label==='Phone Device Type' && attempt.ok),JSON.stringify(result.trustedInput));
 assert.equal(result.fields.find(field=>field.label==='Phone Device Type').value,'Mobile');
 assert.equal(await page.locator('#phonetype').innerText(),'Mobile');
 // The dashboard hides the panel after filling; reopening must use the
 // current content-script message rather than a stale toolbar protocol.
 await page.getByRole('button',{name:'Reopen Formwork',exact:true}).waitFor({timeout:3000});
 await openPanel(context,worker.url().split('/')[2],page.url());
 await page.getByRole('button',{name:'Fill this form',exact:true}).waitFor({timeout:3000});
 await page.getByLabel('Full Name').fill('Edited Candidate');
 result=await run('fill',{url:URL,resume:true,advance:true,fingerprint:result.flow.fingerprint});
 assert.equal(result.flow.kind,'review');assert.equal(result.previousStep.fields.find(f=>f.label==='Full Name').value,'Edited Candidate');
 assert.equal(result.fields.length,0);assert.equal(await page.evaluate(()=>sent),0);assert.equal(await page.evaluate(()=>saved),1);
 const read=await run('read',{url:URL});assert.equal(read.fields.length,0);assert.equal(read.flow.kind,'review');assert.match(read.reviewText,/Review/);
 assert.equal(context.pages().filter(p=>p.url().startsWith(URL)).length,1);
 await assert.rejects(run('fill',{url:URL,resume:true,advance:true,fingerprint:result.flow.fingerprint}));assert.equal(await page.evaluate(()=>sent),0);
});
