import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {confirmationOnPage,inspectResume,reviewText} from '../../server/dashboard/submission.mjs';
import {attachToPage,findSubmitControl} from '../../server/dashboard/drive.mjs';

test('submission evidence rejects generic thanks, requires unique controls and recognizes Indeed receipt',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent('<p>Thank you for visiting. Your application has not been submitted.</p><button>Submit your application</button>');
    assert.equal((await page.evaluate(confirmationOnPage)).confirmation,false);
    assert.equal((await page.evaluate(findSubmitControl)).text,'Submit your application');
    await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<button>Submit application</button>'));
    assert.equal((await page.evaluate(findSubmitControl)).found,false);
    assert.equal(await page.locator('[data-formwork-submit]').count(),0);
    await page.setContent('<h1>Your application was submitted to Fixture Employer</h1>');
    assert.equal((await page.evaluate(confirmationOnPage)).confirmation,true);
  } finally {await browser.close();}
});

test('résumé checks distinguish selected files, reverted drafts, iframe preview and ambiguous upload controls',async()=>{
  const browser=await chromium.launch({headless:true});
  const dir=mkdtempSync(join(tmpdir(),'formwork-resume-proof-'));
  const filename='Tailored.pdf', path=join(dir,filename), bytes=Buffer.from('fixture exact resume bytes');
  writeFileSync(path,bytes);
  const expected={filename,sha256:createHash('sha256').update(bytes).digest('hex')};
  try {
    const page=await browser.newPage();
    // A secure origin is needed for Web Crypto. Route all requests locally.
    await page.route('https://fixture.test/**',route=>route.fulfill({contentType:'text/html',body:'<label>Resume<input type="file" id="resume"></label>'}));
    await page.goto('https://fixture.test/application');
    assert.equal((await attachToPage(page,path)).ok,true);
    let check=await inspectResume(page,expected);
    assert.equal(check.status,'matched');assert.equal(check.files[0].sha256,expected.sha256);
    await page.setContent('<label><input type="radio" checked>Old.pdf</label><label><input type="radio">Tailored.pdf</label>');
    assert.equal((await inspectResume(page,expected)).status,'mismatch');
    await page.setContent('<iframe title="Application preview"></iframe>');
    await page.locator('iframe').evaluate(el=>el.srcdoc='<section><h2>Resume</h2><p>Tailored.pdf</p><p>Fixture applicant experience</p></section>');
    await page.waitForTimeout(100);
    assert.equal((await inspectResume(page,expected)).status,'matched');
    assert.match(await reviewText(page),/Fixture applicant experience/);
    await page.setContent('<label>Resume<input type="file"></label><label>Resume<input type="file"></label>');
    assert.equal((await attachToPage(page,path)).ok,false);
    assert.equal(await page.locator('input').first().evaluate(el=>el.files.length),0);
    // Some sites replace the input with their server-rendered document preview.
    await page.setContent('<label>Resume<input id="resume" type="file" onchange="this.parentElement.outerHTML=\'<section><h2>Resume</h2><p>Tailored.pdf</p></section>\'"></label>');
    assert.equal((await attachToPage(page,path)).ok,true);
    await page.setContent('<section><h2>Resume</h2><p>Unrelated.pdf</p></section>');
    assert.equal((await inspectResume(page,expected)).status,'mismatch');
  } finally {await browser.close();rmSync(dir,{recursive:true,force:true});}
});

test('Indeed telephone widget uses its visible required label without borrowing another question marker',async()=>{
 const browser=await chromium.launch();
 try {
  const page=await browser.newPage();
  await page.route('https://smartapply.indeed.com/**',r=>r.fulfill({contentType:'text/html',body:'<form><div><label>Phone number *</label><div><input type="tel" aria-label="Type phone number"></div></div><div><label>Optional alternate phone</label><input type="tel" aria-label="Alternate phone"></div></form>'}));
  await page.goto('https://smartapply.indeed.com/application');
  await page.addScriptTag({path:join(process.cwd(),'extension/src/content/scrape.js')});
  assert.deepEqual(await page.evaluate(()=>window.__formwork.scrape().schema.fields.map(f=>f.required)),[true,false]);
 } finally {await browser.close();}
});
