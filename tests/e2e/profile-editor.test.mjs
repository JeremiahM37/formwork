import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {ROOT,profile} from '../helpers/load.mjs';

async function fixture(t,candidate) {
  const work=mkdtempSync(join(tmpdir(),'formwork-profile-editor-'));
  if(candidate) writeFileSync(join(work,'profile.json'),JSON.stringify(candidate));
  const python=[process.env.FORMWORK_TEST_PYTHON,join(homedir(),'.venvs/formwork-dashboard/bin/python'),'python3'].filter(Boolean)
    .find(p=>spawnSync(p,['-c','import fastapi,uvicorn,httpx,docx,pypdf,pycountry,authlib']).status===0);
  assert.ok(python,'Install the dashboard Python requirements');
  const service=spawn(python,['-m','uvicorn','dashboard.app:app','--host','127.0.0.1','--port','0'],{
    cwd:join(ROOT,'server'),env:{...process.env,FORMWORK_STATE_DIR:work,FORMWORK_PROFILE_DIR:work,
      FORMWORK_CDP_URL:'http://127.0.0.1:1',FORMWORK_MODEL_URL:'http://127.0.0.1:1'}});
  let output='';service.stderr.on('data',data=>output+=data);
  t.after(async()=>{service.kill();await new Promise(r=>service.once('exit',r));rmSync(work,{recursive:true,force:true});});
  const deadline=Date.now()+10000;
  while(!/http:\/\/127\.0\.0\.1:\d+/.test(output)&&Date.now()<deadline) await new Promise(r=>setTimeout(r,50));
  const origin=output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];assert.ok(origin,output);
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  const saved=async()=>(await (await page.request.get(origin+'/api/profile')).json()).profile;
  return {page,origin,saved};
}

test('fresh dashboard guides a candidate through ordinary profile forms without inferred answers',{timeout:45000},async t=>{
  const {page,origin,saved}=await fixture(t);
  await page.goto(origin);
  await page.getByRole('heading',{name:'Set up your application profile'}).waitFor();
  assert.match(page.url(),/#settings$/);
  await page.getByLabel('Full name',{exact:true}).fill('Fixture Example');
  await page.getByLabel('Email',{exact:true}).fill('fixture@example.test');
  await page.getByRole('button',{name:'Save contact details',exact:true}).click();
  await page.locator('#profileSaveStatus').filter({hasText:'Profile saved.'}).waitFor();
  await page.getByText('Work history',{exact:true}).first().click();
  await page.getByRole('button',{name:'Add work history entry'}).click();
  await page.getByLabel('Employer',{exact:true}).fill('Fixture Company');
  await page.getByLabel('Role title',{exact:true}).fill('Engineer');
  await page.getByLabel('Achievements',{exact:true}).fill('Built a Python service.\nDocumented its API.');
  assert.equal(await page.getByLabel('Current role',{exact:true}).inputValue(),'');
  await page.getByRole('button',{name:'Save work history',exact:true}).click();
  await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='saving…'));
  const candidate=await saved();
  assert.equal(candidate.identity.full_name,'Fixture Example');
  assert.deepEqual(candidate.experience[0].bullets,['Built a Python service.','Documented its API.']);
  assert.equal(candidate.experience[0].current,undefined);
  assert.equal(candidate.demographics,undefined);
  assert.equal(candidate.work_authorization,undefined);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.reload();
  await page.getByText('Work history',{exact:true}).first().click();
  assert.equal(await page.getByLabel('Employer',{exact:true}).inputValue(),'Fixture Company');
});

test('guided editing preserves custom fields and refuses a stale section overwrite',{timeout:45000},async t=>{
  const original=profile();original.experience[0].customEvidence={id:'retain-me'};
  original.work_authorization.requires_sponsorship_now='No';
  const {page,origin,saved}=await fixture(t,original);
  await page.goto(origin+'/#settings');
  await page.getByText('Work history',{exact:true}).first().click();
  await page.getByLabel('Role title',{exact:true}).fill('Senior Engineer');
  await page.getByRole('button',{name:'Save work history',exact:true}).click();
  await page.locator('#profileSaveStatus').filter({hasText:'Profile saved.'}).waitFor();
  const edited=await saved();assert.equal(edited.experience[0].title,'Senior Engineer');
  assert.deepEqual(edited.experience[0].customEvidence,{id:'retain-me'});
  assert.deepEqual(edited.demographics,original.demographics);
  await page.getByText('Work authorization',{exact:true}).first().click();
  await page.getByRole('button',{name:'Save work authorization',exact:true}).click();
  await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='saving…'));
  assert.equal((await saved()).work_authorization.requires_sponsorship_now,'No');
  const concurrent=await saved();concurrent.experience[0].title='Changed in another tab';
  await page.request.post(origin+'/api/profile',{data:{text:JSON.stringify(concurrent)}});
  await page.getByLabel('Role title',{exact:true}).fill('Stale overwrite');
  await page.getByRole('button',{name:'Save work history',exact:true}).click();
  await page.getByText(/This section changed since you opened it/).waitFor();
  assert.equal((await saved()).experience[0].title,'Changed in another tab');
});

test('phone country, proficiency records and office preferences save independently without inventing facts',{timeout:45000},async t=>{
  const original=profile();original.languages=['English',{name:'French',proficiency:'C2',evidence:{source:'user'}}];
  const {page,origin,saved}=await fixture(t,original);await page.goto(origin+'/#settings');
  const saveSection=async name=>Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/profile')&&r.request().method()==='POST'),page.getByRole('button',{name,exact:true}).click()]);
  await page.getByText('Contact details',{exact:true}).first().click();
  await page.getByLabel('Phone country (for dialing-code selectors)',{exact:true}).fill('United Kingdom');
  await saveSection('Save contact details');
  await page.getByText('Languages',{exact:true}).first().click();
  assert.equal(await page.getByLabel('Proficiency',{exact:true}).first().inputValue(),'');
  await page.getByRole('button',{name:'Add languages entry',exact:true}).click();
  await page.getByLabel('Language',{exact:true}).last().fill('Spanish');
  assert.equal(await page.getByLabel('Proficiency',{exact:true}).last().inputValue(),'');
  await saveSection('Save languages');
  await page.getByText('Application preferences',{exact:true}).first().click();
  assert.equal(await page.getByLabel('Preferred contact method (optional)',{exact:true}).inputValue(),'');
  await page.getByLabel('Preferred contact method (optional)',{exact:true}).fill('Email');
  await page.getByLabel('Preferred work locations (one per line)',{exact:true}).fill('Paris\nBarcelona');
  await saveSection('Save application preferences');
  const updated=await saved();assert.equal(updated.identity.phone_country,'United Kingdom');
  assert.equal(updated.identity.location.country,original.identity.location.country);
  assert.deepEqual(updated.languages,[{name:'English'},{name:'French',proficiency:'C2',evidence:{source:'user'}},{name:'Spanish'}]);
  assert.deepEqual(updated.preferences.work_locations,['Paris','Barcelona']);
  assert.equal(updated.preferences.preferred_contact_method,'Email');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.reload();await page.getByText('Languages',{exact:true}).first().click();
  assert.deepEqual(await page.getByLabel('Proficiency',{exact:true}).evaluateAll(es=>es.map(e=>e.value)),['','C2','']);
});
