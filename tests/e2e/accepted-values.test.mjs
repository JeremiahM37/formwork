import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';

test('Personio chrome is excluded while applicant language questions remain', async t => {
  const browser=await chromium.launch(); t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent(`<div class="locale-display language-selector"><button role="combobox" aria-label="Select language, current: English">English</button></div>
    <form><label for="language">Language proficiency</label><select id="language"><option>English</option></select></form>`);
  await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
  const labels=await page.evaluate(()=>window.__formwork.scrape().schema.fields.map(f=>f.label));
  assert.deepEqual(labels,['Language proficiency']);
});

test('lazy entry requires a unique reviewed control outside any form',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
  for(const [html,expected] of [
    ['<button type="button" data-bi-id="careers-site-apply-button">Apply for This Job</button>',true],
    ['<button type="button">Apply for This Job</button>',false],
    ['<form><button type="button" data-bi-id="careers-site-apply-button">Apply for This Job</button></form>',false],
    ['<button disabled type="button" data-bi-id="careers-site-apply-button">Apply for This Job</button>',false],
    ['<button type="button" data-bi-id="careers-site-apply-button">Apply for This Job</button>'.repeat(2),false],
  ]) {
    await page.setContent(html);await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
    assert.equal(await page.evaluate(()=>Boolean(window.__formwork.lazyFormOpener())),expected);
  }
});

test('repeated Apply links need the same destination and label; buttons remain ambiguous',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
  for(const [html,expected] of [
    ['<a href="https://example.test/login?job=1">Apply Now</a>'.repeat(2),true],
    ['<a href="https://example.test/login?job=1">Apply Now</a><a href="https://example.test/login?job=2">Apply Now</a>',false],
    ['<a href="https://example.test/login?job=1">Apply Now</a><a href="https://example.test/login?job=1">Apply with LinkedIn</a>',false],
    ['<button type="button">Apply Now</button>'.repeat(2),false],
    ['<a role="button">Apply Now</a>'.repeat(2),false],
    ['<a target="_blank" href="https://example.test/login">Apply Now</a>'.repeat(2),false],
    ['<button disabled type="button">Apply Now</button>',false],
  ]){
    await page.setContent(html);await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
    assert.equal(await page.evaluate(()=>Boolean(window.__formwork.findOpener())),expected,html);
  }
});

test('Personio exposes document inputs only through their visible matching upload control',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent(`<form>
    <div class="document-field-wrapper" role="group" aria-labelledby="doc-label-cv"><div id="doc-label-cv">CV<span>*</span><span>(required)</span></div>
      <div class="document-input-wrapper"><button type="button" class="add-file-button">Add file</button><input style="display:none" id="doc-input-cv" type="file" name="documents.cv" aria-label="Upload CV"></div></div>
    <input style="display:none" type="file" name="trap">
    <div class="document-field-wrapper" role="group" aria-labelledby="doc-label-other" hidden><div id="doc-label-other">Other</div><div class="document-input-wrapper"><button class="add-file-button" type="button">Add file</button><input style="display:none" id="doc-input-other" name="documents.other" type="file"></div></div>
    </form>`);
  await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
  const fields=await page.evaluate(()=>window.__formwork.scrape().schema.fields);
  assert.equal(fields.length,1);assert.equal(fields[0].label,'CV');assert.equal(fields[0].required,true);
});

test('readback respects site rejection for every ordinary control type', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<form>
    <input id="text" aria-invalid="true" value="Example">
    <textarea id="area" aria-invalid="true">Example</textarea>
    <input id="email" type="email" value="invalid-address">
    <select id="select" aria-invalid="true"><option selected>Example</option></select>
    <input id="checkbox" type="checkbox" checked aria-invalid="true">
    <input id="radio" type="radio" checked value="Example" aria-invalid="true">
    <div class="field"><input id="hiddenError" value="Example"><span class="error" hidden>Required</span></div>
  </form>`);
  for (const file of ['scrape.js','fill.js']) await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
  const results = await page.evaluate(() => {
    const ns=window.__formwork;
    return Object.fromEntries([
      ['text','text','Example'], ['area','textarea','Example'],
      ['email','email','invalid-address'], ['select','select','Example'],
      ['checkbox','checkbox',true], ['radio','radio','Example'],
      ['hiddenError','text','Example'],
    ].map(([id,type,want])=>[id,ns.verifyValue([document.getElementById(id)],{type},want)]));
  });
  assert.deepEqual(results, {text:false,area:false,email:false,select:false,checkbox:false,radio:false,hiddenError:true});
});

test('site validation after blur prevents a successful fill report', async t => {
  const browser=await chromium.launch(); t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent(`<label for="email">Email</label><input id="email" type="email">
    <script>document.getElementById('email').addEventListener('blur',e=>setTimeout(()=>e.target.setAttribute('aria-invalid','true'),60));</script>`);
  for (const file of ['scrape.js','fill.js']) await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
  const report=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:'synthetic@example.test'},schema,registry);});
  assert.equal(report.filled.length,0);
  assert.equal(report.failed.length,1);
});

for (const mode of ['retain','replace','late-replace']) test(`attachment readback checks the requested bytes (${mode})`, async t => {
  const browser=await chromium.launch(); t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent('<label for="resume">Resume</label><input type="file" id="resume">');
  for (const file of ['scrape.js','fill.js']) await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
  const report=await page.evaluate(async mode=>{
    const ns=window.__formwork,{schema,registry}=ns.scrape();
    const file=new File(['right'],'resume.txt',{type:'text/plain',lastModified:1000});
    if(mode!=='retain') document.getElementById('resume').addEventListener('change',()=>{
      const replace=()=>{const dt=new DataTransfer();dt.items.add(new File(['wrong'],'resume.txt',{type:'text/plain',lastModified:1000}));document.getElementById('resume').files=dt.files;};
      if(mode==='late-replace')setTimeout(replace,60);else replace();
    });
    return ns.fill({},schema,registry,{files:{[schema.fields[0].id]:file}});
  },mode);
  assert.equal(report.filled.length,mode==='retain'?1:0);
  assert.equal(report.failed.length,mode==='retain'?0:1);
  assert.equal(report.receipts[0].state,mode==='retain'?'verified':'unconfirmed');
  assert.equal(report.receipts[0].verification,'local_file_bytes');
  assert.ok(!JSON.stringify(report.receipts).includes('resume.txt'));
});

test('readback never erases meaningful punctuation or non-Latin letters', async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent('<input id="value">');
  await page.addScriptTag({path:join(ROOT,'extension/src/content/fill.js')});
  const results=await page.evaluate(()=>{
    const el=document.getElementById('value');
    return [['Jose','José'],['a.b@example.test','a+b@example.test'],['C','C++'],['北京','東京'],[' Dana  Rivera ','Dana Rivera'],['Jose\u0301','José']].map(([actual,want])=>{
      el.value=actual;return window.__formwork.verifyValue([el],{type:'text'},want);
    });
  });
  assert.deepEqual(results,[false,false,false,false,true,true]);
});


test('Rippling phone-code search has a stable identity separate from ordinary Search',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent(`<form><div data-testid="phone_number-code"><input id="country" data-input="select-search-input" role="combobox" aria-label="Search" placeholder="Search" value="+1 US"></div>
    <input data-input="phone_number" inputmode="tel" aria-label="Phone number">
    <input id="unrelated" role="combobox" aria-label="Search">
    <div data-testid="phone_number-code"><label for="explicit">Preferred dialing country</label><input id="explicit" role="combobox" aria-label="Search"></div></form>`);
  await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
  const labels=await page.evaluate(()=>window.__formwork.scrape().schema.fields.map(f=>f.label));
  assert.deepEqual(labels,['Phone country code','Phone number','Search','Preferred dialing country']);
  await page.locator('#country').fill('+44 GB');
  assert.equal(await page.evaluate(()=>window.__formwork.scrape().schema.fields[0].label),'Phone country code');
});

test('option discovery reads a scrolling viewport inside the listbox',async t=>{
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<input id="country" role="combobox" aria-label="Phone country code" aria-controls="menu"><div id="menu" role="listbox" hidden><div id="viewport" style="height:100px;overflow:auto"><div id="rows" style="height:400px"></div></div></div><script>
 const scrollViewport=document.querySelector("#viewport");
 const draw=()=>{rows.innerHTML='<div role="option">'+(scrollViewport.scrollTop>50?'United Kingdom':'United States')+'</div>';};
 scrollViewport.onscroll=draw;country.onclick=()=>{menu.hidden=false;draw()};country.onkeydown=e=>{if(e.key==='Escape')menu.hidden=true};
 </script>`);
 await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
 const result=await page.evaluate(async()=>{const s=await window.__formwork.scrapeFull();return {field:s.schema.fields[0],scroll:document.querySelector('#viewport').scrollTop,html:document.querySelector('#menu').outerHTML}});
 assert.deepEqual(result.field.options,['United States','United Kingdom'],JSON.stringify(result));assert.equal(result.scroll,0);
});

test('UKG custom Apply entry requires its reviewed identity, enabled state and unique non-form scope',async t=>{
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
 const button='<ukg-button data-automation="apply-now-button" data-tag-name="button">Apply now</ukg-button>';
 for(const [html,expected] of [[button,true],[button.repeat(2),false],['<form>'+button+'</form>',false],[button.replace('data-tag-name','disabled data-tag-name'),false],[button.replace('data-tag-name','aria-disabled="true" data-tag-name'),false],[button.replace('Apply now','Submit application'),false]]){
  await page.setContent(html);await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
  assert.equal(await page.evaluate(()=>Boolean(__formwork.findOpener())),expected,html);
 }
});

 test('Dayforce guest entry is unique, enabled and outside an application form',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
  const button='<button type="button" test-id="apply-without-account">Apply without an Account</button>';
  for(const [html,expected] of [[button,true],[button.repeat(2),false],['<form>'+button+'</form>',false],[button.replace('type=', 'disabled type='),false],[button.replace('type=', 'aria-disabled="true" type='),false],[button.replace('Apply without an Account','Submit application'),false]]) {
    await page.setContent(html);await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
    assert.equal(await page.evaluate(()=>Boolean(window.__formwork.lazyFormOpener())),expected,html);
  }
});
