/** Real dashboard, temporary SQLite/profile, real desktop/mobile browser. No live job sites. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {readFileSync,mkdtempSync, writeFileSync, cpSync, rmSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join} from 'node:path';
import {ROOT, profile} from '../helpers/load.mjs';
import {attachToPage} from '../../server/dashboard/drive.mjs';
import {createServer} from 'node:http';
const {chromium} = await import(process.env.PW_MODULE || 'playwright');
const candidates = [process.env.FORMWORK_TEST_PYTHON, join(homedir(),'.venvs/formwork-dashboard/bin/python'),'python3'].filter(Boolean);
const python = candidates.find(p=>spawnSync(p,['-c','import fastapi,uvicorn,httpx,docx,pypdf,pycountry,authlib']).status===0);

test('dashboard workflow persists notes, outcomes, interviews and contacts', {timeout:90000}, async t=>{
  assert.ok(python,'Dashboard test needs Python with server/requirements.txt installed');
  const work=mkdtempSync(join(tmpdir(),'formwork-dashboard-e2e-'));
  const modelCalls=[];
  const modelServer=createServer((req,res)=>{
    let data='';req.on('data',part=>data+=part);req.on('end',()=>{
      modelCalls.push(JSON.parse(data));res.setHeader('Content-Type','application/json');
      const extracting = modelCalls.at(-1).messages[0].content.startsWith('Extract résumé');
      res.end(JSON.stringify({content:extracting ? JSON.stringify({experience:[{employer:'Fixture Company',title:'Software Engineer',bullets:['Built Python services.'],source:'Fixture Company\nSoftware Engineer\nBuilt Python services.'}],skills:['Python']}) : 'I built a Python service.'}));
    });
  });
  await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
  t.after(()=>{modelServer.closeAllConnections();modelServer.close();});
  writeFileSync(join(work,'profile.json'),JSON.stringify(profile()));
  writeFileSync(join(work,'answers.json'),'{}');
  cpSync(join(ROOT,'tests/fixtures/resume.example.tex'),join(work,'resume.tex'));
  // Uvicorn chooses an available port, reported on stderr. No racy reserve/release.
  const process=spawn(python,['-m','uvicorn','dashboard.app:app','--host','127.0.0.1','--port','0'],{
    cwd:join(ROOT,'server'), env:{...globalThis.process.env, FORMWORK_STATE_DIR:work, FORMWORK_PROFILE_DIR:work, FORMWORK_CDP_URL:'http://127.0.0.1:1',
      FORMWORK_MODEL_URL:`http://127.0.0.1:${modelServer.address().port}/complete`}});
  let output='';process.stderr.on('data',d=>output+=d);
  t.after(async()=>{process.kill();await new Promise(r=>process.once('exit',r));rmSync(work,{recursive:true,force:true});});
  const start=Date.now();
  while(!/http:\/\/127\.0\.0\.1:\d+/.test(output)&&Date.now()-start<15000) await new Promise(r=>setTimeout(r,50));
  const origin=output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];assert.ok(origin,output);
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/#workspace');
  await page.getByText('Add a job from its URL',{exact:true}).click();
  await page.getByLabel('Posting URL',{exact:true}).fill('https://example.test/jobs/fixture');
  await page.getByLabel('Company',{exact:true}).fill('Fixture Company');
  await page.getByLabel('Job title',{exact:true}).fill('Platform Engineer');
  await page.getByLabel('Paste job description').fill('Python, Kubernetes and PostgreSQL.');
  await page.getByRole('button',{name:'Save job',exact:true}).click();
  await page.getByRole('button',{name:'Details',exact:true}).click();
  await page.getByLabel('Application stage').selectOption('submitted');
  await page.getByRole('button',{name:'Update stage'}).click();
  await page.locator('#pipelineList .chip').filter({hasText:'submitted'}).waitFor();
  await page.getByRole('button',{name:'Details',exact:true}).click();
  await page.getByLabel('Timeline note').fill('Recruiter replied with a technical interview.');
  await page.getByRole('button',{name:'Save note',exact:true}).click();
  await page.getByText(/Recruiter replied with a technical interview\./).last().waitFor();
  await page.getByText('Schedule interview',{exact:true}).click();
  await page.getByLabel('Interview date and time').fill('2026-10-01T10:30');
  await page.getByLabel('Interviewer',{exact:true}).fill('Pat');
  await page.getByRole('button',{name:'Add interview',exact:true}).click();
  await page.getByLabel('Outcome for Fixture Company Technical interview').selectOption('passed');
  await page.getByRole('button',{name:'Save outcome'}).click();
  // Saving replaces the workspace; wait for its completion before opening
  // another editor that the in-flight render would otherwise remove.
  await page.getByText('Interview outcome saved.',{exact:true}).waitFor();
  await page.getByText('Add a contact',{exact:true}).click();
  await page.getByLabel('Contact name').fill('Pat Example');
  await page.getByLabel('Contact company').fill('Fixture Company');
  await page.getByRole('button',{name:'Save contact'}).click();
  await page.getByText('Pat Example · Fixture Company',{exact:true}).waitFor();
  await page.reload();
  await page.getByText('Pat Example · Fixture Company',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Outcome for Fixture Company Technical interview').inputValue(),'passed');
  const calendar=await (await page.request.get(origin+'/api/calendar.ics')).text();assert.match(calendar,/BEGIN:VEVENT/);
  assert.match(await (await page.request.get(origin+'/api/export/applications.csv')).text(),/Fixture Company/);
  // Phone navigation is a real viewport, and table/form content must fit it.
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('.navbtn').evaluateAll(buttons=>buttons.every(button=>{
    const r=button.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1 && r.height>=44;
  })),true);
  await page.getByRole('button',{name:'Queue',exact:false}).tap();
  await page.getByRole('heading',{name:'Discover jobs',exact:true}).waitFor();
  await page.getByRole('button',{name:'Job search',exact:true}).tap();
  await page.reload();await page.getByText('Pat Example · Fixture Company',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.getByRole('button',{name:'Details',exact:true}).click();
  await page.getByText('Interview prep & correspondence',{exact:true}).click();
  await page.getByLabel('Writing task').selectOption('followup');
  await page.getByRole('button',{name:'Prepare draft',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Prepared draft"]').value.includes('Python service'));
  assert.equal(modelCalls.length,1);
  assert.ok(!JSON.stringify(modelCalls).includes(profile().identity.full_name));
  await page.getByRole('button',{name:'Résumé',exact:true}).click();
  await page.getByLabel('Import resume document').setInputFiles({name:'candidate.txt',mimeType:'text/plain',buffer:Buffer.from('Dana Rivera\nBuilt Python services with PostgreSQL.')});
  await page.waitForFunction(()=>document.querySelector('#resumeStudio textarea').value.includes('PostgreSQL'));
  await page.getByRole('button',{name:'Save new resume version',exact:true}).click();
  await page.getByRole('link',{name:'DOCX',exact:true}).waitFor();
  const docx=await page.request.get(await page.getByRole('link',{name:'DOCX',exact:true}).getAttribute('href').then(path=>origin+path));
  assert.equal((await docx.body()).subarray(0,2).toString(),'PK');
  await page.getByLabel('Resume version text').fill('Dana Rivera\nExperience\nFixture Company\nSoftware Engineer\nBuilt Python services.\nSkills\nPython');
  await page.getByText('Use this resume to update autofill',{exact:true}).click();
  await page.getByRole('button',{name:'Extract career fields for autofill'}).click();
  await page.getByLabel('Replace experience from resume').waitFor();
  assert.equal(await page.getByLabel('Replace experience from resume').isChecked(),false);
  const beforeImport=(await (await page.request.get(origin+'/api/profile')).json()).profile;
  assert.equal(beforeImport.experience[0].employer,profile().experience[0].employer);
  await page.getByLabel('Replace experience from resume').check();
  await page.getByRole('button',{name:'Save reviewed fields to profile'}).click();
  await page.getByText('Profile saved. Retry extension sync in Settings.',{exact:true}).waitFor();
  const afterImport=(await (await page.request.get(origin+'/api/profile')).json()).profile;
  assert.deepEqual(afterImport.experience[0].bullets,['Built Python services.']);
  assert.deepEqual(afterImport.identity,beforeImport.identity);
  assert.deepEqual(afterImport.work_authorization,beforeImport.work_authorization);
  assert.deepEqual(afterImport.skills,beforeImport.skills);
  assert.ok(!JSON.stringify(modelCalls.at(-1)).includes('Dana Rivera'));
  await page.getByText('Build and arrange a resume',{exact:true}).click();
  await page.getByRole('button',{name:'Start from saved profile',exact:true}).click();
  await page.getByLabel('Resume display name',{exact:true}).waitFor();
  await page.getByLabel('Builder version name').fill('Platform layout');
  await page.getByLabel('Resume template',{exact:true}).selectOption('modern');
  await page.getByLabel('Paper size',{exact:true}).selectOption('a4');
  await page.getByLabel('Resume headline',{exact:true}).fill('Platform engineer');
  await page.getByRole('button',{name:'Move section 1 down',exact:true}).click();
  assert.equal(await page.getByLabel('Section 1 heading',{exact:true}).inputValue(),'Education');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.getByRole('button',{name:'Save builder as new version',exact:true}).click();
  await page.getByRole('link',{name:'Preview saved PDF',exact:true}).waitFor();
  const savedLayouts=(await (await page.request.get(origin+'/api/resumes')).json()).versions;
  const layoutVersion=savedLayouts.find(v=>v.name==='Platform layout');
  assert.equal(layoutVersion.format,'structured');
  const layoutBody=JSON.parse((await (await page.request.get(origin+`/api/resumes/${layoutVersion.id}`)).json()).text);
  assert.equal(layoutBody.sections[0].heading,'Education');
  assert.equal(layoutBody.template,'modern');
  const layoutDocx=await page.request.get(origin+`/api/resumes/${layoutVersion.id}/export.docx`);
  assert.equal((await layoutDocx.body()).subarray(0,2).toString(),'PK');
  await page.getByRole('button',{name:'Job search',exact:true}).click();
  await page.getByLabel('Pipeline layout').selectOption('board');
  await page.locator('[aria-label="submitted stage"] .card').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.getByRole('button',{name:'Details',exact:true}).click();
  await page.getByText('Compare saved resumes for this job',{exact:true}).click();
  await page.getByLabel('Compare resume Platform layout',{exact:true}).check();
  await page.locator('#pipelineDetail input[aria-label^="Compare resume"]').last().check();
  await page.getByRole('button',{name:'Compare resume evidence',exact:true}).click();
  await page.getByText(/Compares recognized skill evidence in each document only/).waitFor();
  const handoff=await page.request.get(await page.getByRole('link',{name:'Download preparation handoff'}).getAttribute('href').then(path=>origin+path));
  assert.match(await handoff.text(),/Fixture Company/);
  await page.getByRole('button',{name:'Prepare weekly digest'}).click();
  await page.getByLabel('Search digest').waitFor({state:'visible'});
  assert.match(await page.getByLabel('Search digest').inputValue(),/Formwork/);
  await page.setViewportSize({width:1280,height:900});
  await page.locator('[aria-label="submitted stage"] .card').dragTo(page.locator('[aria-label="screening stage"]'));
  await page.locator('[aria-label="screening stage"] .card').waitFor();
  await page.setViewportSize({width:390,height:844});
  await page.getByText('Pipeline insights',{exact:true}).click();
  await page.getByText('submitted → screening: 1',{exact:true}).waitFor();
  await page.locator('[aria-label="screening stage"] .card').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.screenshot({path:join(work,'pipeline-mobile.png')});
  await page.getByLabel('Pipeline layout').selectOption('list');
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByLabel('Drafting provider').waitFor();
  assert.equal(await page.getByLabel('Full name',{exact:true}).inputValue(),profile().identity.full_name);
  await page.getByRole('button',{name:'Connect extension',exact:true}).click();
  await page.locator('#modelConnectionStatus').filter({hasText:'Connection failed:'}).waitFor();
  await page.getByLabel('Target roles',{exact:true}).fill('Platform engineer\nBackend engineer');
  await page.getByLabel('Preferred locations',{exact:true}).fill('Remote\nDenver');
  await page.getByLabel('Preferred skills',{exact:true}).fill('Python\nPostgreSQL');
  await page.getByText('Seniority and work location',{exact:true}).click();
  await page.getByLabel('Target level: entry',{exact:true}).check();
  await page.getByLabel('Countries to work from (names or ISO codes)').fill('United States\nCanada');
  await page.getByLabel('Work mode: remote',{exact:true}).check();
  await page.getByText('Choose public job sources',{exact:true}).click();
  await page.getByLabel('Workday careers board URLs',{exact:true}).fill('https://example.wd5.myworkdayjobs.com/ExampleCareerSite');
  await page.getByRole('button',{name:'Save job search',exact:true}).click();
  await page.locator('#discoverySaveStatus').filter({hasText:'Search saved.'}).waitFor();
  await page.reload();
  await page.getByLabel('Target roles',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Target roles',{exact:true}).inputValue(),'Platform engineer\nBackend engineer');
  assert.deepEqual((await (await page.request.get(origin+'/api/discovery')).json()).priorities.preferredSkills,['Python','PostgreSQL']);
  const discoverySettings=await (await page.request.get(origin+'/api/discovery')).json();
  assert.deepEqual(discoverySettings.sources.workday,['https://example.wd5.myworkdayjobs.com/en-US/ExampleCareerSite']);
  const priorities=discoverySettings.priorities;
  assert.deepEqual(priorities.workCountries,['US','CA']);assert.deepEqual(priorities.seniority,['entry']);assert.deepEqual(priorities.workModes,['remote']);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.route('**/api/queue',route=>route.fulfill({json:{jobs:[{
    url:'https://example.test/long-role',title:'Software Engineer — a long public posting title for the mobile queue',company:'Fixture Company',
    source:'fixture',locations:['Remote'],fit:{coverage:100,missing:[]},
    recommendation:{reasons:['Similar to a saved role: Software Engineering'],unknown:[],unmatchedRoles:[],unmatchedLocations:[],explanation:'Preference ordering based on profile evidence and the role you selected.'}
  }],sources:[],discovery:{fetchedMatches:1238,eligible:1200}}}));
  await page.goto(origin+'/#queue');
  // Hash navigation reuses the existing page; reload to fetch this queue fixture.
  await page.reload();
  await page.getByText('Match breakdown',{exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.getByText('Sources & saved alerts',{exact:true}).click();
  await page.getByText('Saved search alerts (0)',{exact:true}).click();
  await page.getByLabel('Search alert name',{exact:true}).fill('Platform roles');
  await page.getByLabel('Alert keywords (all must match)').fill('Python engineer');
  await page.getByRole('button',{name:'Save search alert',exact:true}).click();
  await page.getByText('Saved search alerts (1)',{exact:true}).waitFor();
  await page.reload();
  await page.getByText('Sources & saved alerts',{exact:true}).click();
  await page.getByText('Saved search alerts (1)',{exact:true}).click();
  await page.getByText('Platform roles: Python engineer · 0% minimum',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Remove alert',exact:true}).click();
  await page.getByText('Saved search alerts (0)',{exact:true}).waitFor();
  // Exercise OAuth setup and the real local inbox review endpoints. Consent and
  // mailbox data are fixtures; no Google account is accessed by this test.
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByText('Google OAuth setup',{exact:true}).click();
  await page.getByLabel('Google OAuth client ID',{exact:true}).fill('fixture.apps.googleusercontent.com');
  await page.getByLabel('Google OAuth client secret',{exact:true}).fill('fixture-private-secret');
  await page.getByRole('button',{name:'Save Google setup',exact:true}).click();
  await page.getByText('A client secret is saved. Leave the field blank to retain it.',{exact:true}).waitFor({state:'attached'});
  assert.equal(await page.getByLabel('Google OAuth client secret',{exact:true}).inputValue(),'');
  await page.route('https://accounts.google.com/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Consent fixture</h1>'}));
  await page.getByRole('button',{name:'Connect Google',exact:true}).click();
  await page.getByRole('heading',{name:'Consent fixture'}).waitFor();
  const consent=new URL(page.url());assert.equal(consent.searchParams.get('scope'),'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(consent.searchParams.get('code_challenge_method'),'S256');
  const connectionPath=join(work,'connections','google.json');
  const connection=JSON.parse(readFileSync(connectionPath));delete connection.pending;
  connection.account='candidate@example.test';connection.token={access_token:'fixture-only',expires_at:Date.now()/1000+3600};
  writeFileSync(connectionPath,JSON.stringify(connection),{mode:0o600});
  const inboxMessage={id:'fixturemail',subject:'Fixture Company interview',snippet:'<script>this is message text, not executable code</script>',
    senderName:'Recruiter',senderEmail:'recruiter@example.test',receivedAt:Date.now()/1000,suggestedStatus:'interview',
    provenance:'Message From header; identity is not independently verified.'};
  const seeded=spawnSync(python,['-c','import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("INSERT INTO inbox_messages(id,payload,received_at) VALUES(?,?,?)",("fixturemail",sys.argv[2],1)); db.commit()',join(work,'formwork.db'),JSON.stringify(inboxMessage)]);
  assert.equal(seeded.status,0,seeded.stderr?.toString());
  await page.goto(origin+'/#workspace');
  await page.getByText('Job-search inbox (1 to review)',{exact:true}).click();
  await page.getByText(inboxMessage.snippet,{exact:true}).waitFor();
  const choices=await (await page.request.get(origin+'/api/applications')).json();
  await page.getByLabel('Application for Fixture Company interview',{exact:true}).selectOption(String(choices.applications[0].id));
  assert.equal(await page.getByLabel('Status for Fixture Company interview',{exact:true}).inputValue(),'');
  await page.getByRole('button',{name:'Import sender contact',exact:true}).click();
  await page.getByText('Sender imported with message provenance.',{exact:true}).waitFor();
  await page.getByLabel('Status for Fixture Company interview',{exact:true}).selectOption('interview');
  await page.getByRole('button',{name:'Link reviewed message',exact:true}).click();
  await page.getByText('Job-search inbox (0 to review)',{exact:true}).waitFor();
  assert.equal((await (await page.request.get(origin+'/api/applications')).json()).applications[0].status,'interview');

  // Calendar controls in the real mobile dashboard. Provider responses are
  // intercepted; backend persistence/conflict handling has separate API tests.
  const calendarActions=[];
  await page.route(origin+'/api/calendar/google**',async route=>{
    const req=route.request(),url=new URL(req.url());
    const occurrence={id:'series_20261001',etag:'fixture-etag',summary:'Recurring interview',
      start:{dateTime:'2026-10-01T10:00:00-06:00'},end:{dateTime:'2026-10-01T11:00:00-06:00'}};
    let result={};
    if(url.pathname==='/api/calendar/google') result={connected:true,events:[{id:'series',summary:'Weekly interviews',recurrence:['RRULE:FREQ=WEEKLY']} ]};
    else if(url.pathname.endsWith('/instances')) {
      assert.ok(Number(url.searchParams.get('end'))>Number(url.searchParams.get('start')));
      result={events:[occurrence],page:''};
    } else {calendarActions.push({path:url.pathname,body:req.postDataJSON()});result={id:'fixture'};}
    await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.reload();
  await page.getByText('Google Calendar',{exact:true}).click();
  await page.getByLabel('Occurrences from',{exact:true}).fill('2026-10-01');
  await page.getByLabel('Occurrences until',{exact:true}).fill('2026-11-01');
  await page.getByRole('button',{name:'Show occurrences',exact:true}).click();
  await page.getByLabel('Application for Recurring interview',{exact:true}).selectOption(String(choices.applications[0].id));
  await page.getByRole('button',{name:'Import reviewed schedule',exact:true}).click();
  await page.getByText('Interview schedule imported.',{exact:true}).waitFor();
  assert.deepEqual(calendarActions[0],{path:'/api/calendar/google/events/series_20261001/import',body:{applicationId:choices.applications[0].id,etag:'fixture-etag'}});
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'Export to Google Calendar',exact:true}).first().click();
  await page.getByText('Interview exported to Google Calendar.',{exact:true}).waitFor();
  assert.match(calendarActions[1].path,/interviews\/\d+\/export$/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.unroute(origin+'/api/calendar/google**');

  // Queue decisions stay usable on a phone, with visible score, filters and
  // honest unknowns. No preparation action is clicked in this check.
  await page.route(origin+'/api/queue',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({jobs:[
    {url:'https://example.test/match',title:'Backend Engineer',company:'Match Fixture',locations:['Remote'],match:{score:92,basis:'Profile evidence'},fit:{recognized:2,matched:['Python'],missing:[]}},
    {url:'https://example.test/unknown',title:'Designer',company:'Unknown Fixture',locations:[],match:{score:null},fit:{recognized:0,matched:[],missing:[]}}
  ]})}));
  await page.reload();await page.getByRole('button',{name:/^Queue/}).click();
  await page.getByLabel('92 percent profile match').waitFor();
  await page.getByLabel('Search jobs').fill('Designer');
  assert.equal(await page.locator('.job-card').count(),1);
  await page.getByLabel('Match unavailable').waitFor();
  await page.getByLabel('Search jobs').fill('');
  await page.getByRole('button',{name:'Strong matches',exact:true}).click();
  assert.equal(await page.locator('.job-card').count(),1);
  await page.getByLabel('92 percent profile match').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.unroute(origin+'/api/queue');

  // Component check: factual quotations must not remain presented as a review
  // of newly edited wording. No application operation is invoked here.
  await page.evaluate(()=>{
    state.current={id:999,url:'https://example.test/fixture',company:'Fixture',title:'Fact review',status:'ready',
      snapshot:{cover:{text:'I reviewed weekly ticket trends.',factualReview:{status:'checked',note:'Model-assisted review',concerns:[{quote:'I reviewed weekly ticket trends.',reason:'Not in candidate facts.'}]}}}};
    show('review');renderReview();
  });
  await page.getByText('Not in candidate facts.',{exact:true}).waitFor();
  await page.locator('#reviewBody textarea').first().fill('I would like to review ticket trends.');
  await page.getByText('Letter edited since factual review. Check the changed wording against your experience.',{exact:true}).waitFor();
  assert.equal(await page.getByText('Not in candidate facts.',{exact:true}).count(),0);
  await page.evaluate(()=>{
    state.current={id:999,url:'https://fixture.wd5.myworkdayjobs.com/en-US/External/job/Denver/Engineer_R1',company:'Fixture',title:'Workday review',status:'queued',
      snapshot:{flow:{kind:'login',message:'Sign in to Workday in Browser'},fields:[],staged:[]}};renderReview();
  });
  assert.equal(await page.getByRole('button',{name:'Resume after sign-in',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Submit application',exact:true}).count(),0);
  await page.evaluate(()=>{state.current.status='ready';state.current.snapshot.flow={kind:'next',message:'Review this step'};renderReview();});
  assert.equal(await page.getByRole('button',{name:'Save and continue',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Submit application',exact:true}).count(),0);
  await page.evaluate(()=>{state.current.snapshot.flow={kind:'review',message:'Final review'};
    state.current.snapshot.steps=[{flow:{heading:'My Information'},fields:[{label:'Name',value:'Previously saved candidate'}]}];
    state.current.snapshot.reviewText='Workday final review text';renderReview();});
  assert.equal(await page.getByRole('button',{name:'Submit application',exact:true}).count(),1);
  await page.getByText('Saved step 1: My Information',{exact:true}).click();
  await page.getByText('Name: Previously saved candidate',{exact:true}).waitFor();
  await page.getByText('Read the employer’s review',{exact:true}).click();
  await page.getByText('Workday final review text',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
});

test('cover upload replaces the right file in an iframe and reports rejected writes',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage();
  const work=mkdtempSync(join(tmpdir(),'formwork-attach-'));t.after(()=>rmSync(work,{recursive:true,force:true}));
  const file=join(work,'approved-cover.pdf');writeFileSync(file,'%PDF-1.4 approved wording');
  await page.setContent(`<input type="file" aria-label="Resume"><iframe srcdoc='<label>Cover letter<input type="file"></label>'></iframe>`);
  await page.frames()[1].waitForSelector('input');
  const result=await attachToPage(page,file,'cover');assert.equal(result.ok,true);
  assert.equal(await page.locator('input').evaluate(n=>n.files.length),0);
  assert.equal(await page.frames()[1].locator('input').evaluate(n=>n.files[0].name),'approved-cover.pdf');
  await page.frames()[1].locator('input').setInputFiles([]);
  await page.frames()[1].locator('input').evaluate(n=>n.addEventListener('change',()=>{n.value='';}));
  assert.equal((await attachToPage(page,file,'cover')).ok,false);
});
