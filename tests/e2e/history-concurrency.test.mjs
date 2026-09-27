import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';

test('overlapping history requests cannot add duplicate Workday rows, and a failed read releases ownership',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent(`<section data-automation-id="workExperienceSection"><button type="button">Add</button></section>
    <script>window.adds=0;document.querySelector('button').onclick=()=>{adds++;setTimeout(()=>{
      document.querySelector('section').insertAdjacentHTML('beforeend','<input data-automation-id="company">');
    },80)};</script>`);
  await page.addScriptTag({path:join(ROOT,'extension/src/content/history-rows.js')});
  const results=await page.evaluate(async()=>{
    const ns=window.__formwork;
    const send=async()=>{await new Promise(r=>setTimeout(r,30));return {experience:[{employer:'Example',title:'Engineer'}]};};
    const reports=await Promise.all([ns.fillHistory(send),ns.fillHistory(send)]);
    const failed=await ns.fillHistory(async()=>{throw Error('profile unavailable')}).catch(e=>({issues:[e.message]}));
    const retry=await ns.fillHistory(send);
    return {reports,failed,retry,adds:window.adds,rows:document.querySelectorAll('input').length};
  });
  assert.equal(results.adds,1);assert.equal(results.rows,1);
  assert.equal(results.reports.filter(r=>r.issues.some(s=>/already running/.test(s))).length,1);
  assert.match(results.failed.issues.join(' '),/profile unavailable/);
  assert.deepEqual(results.retry.issues,[]);
});

test('an unconfirmed Add is not repeated, including after content-script reinjection',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent(`<section data-automation-id="educationSection"><button type="button">Add</button></section>
    <script>window.adds=0;document.querySelector('button').onclick=()=>{adds++};
    window.finishAdd=()=>document.querySelector('section').insertAdjacentHTML('beforeend','<input data-automation-id="school">');</script>`);
  const source=join(ROOT,'extension/src/content/history-rows.js');
  await page.addScriptTag({path:source});
  const run=()=>page.evaluate(()=>window.__formwork.fillHistory(async()=>({education:[{school:'Example University'}]})));
  const first=await run();assert.ok(first.issues.length);
  await page.addScriptTag({path:source});
  const second=await run();
  assert.equal(await page.evaluate(()=>adds),1);
  assert.match(second.issues.join(' '),/earlier Add/);
  await page.evaluate(()=>finishAdd());
  const third=await run();assert.deepEqual(third.issues,[]);
  assert.equal(await page.evaluate(()=>adds),1);assert.equal(await page.locator('input').count(),1);
});
