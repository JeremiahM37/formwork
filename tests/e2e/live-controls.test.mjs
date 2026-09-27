import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';

test('decorative upload label yields to the actual resume caption',async t=>{
  const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent('<span id="caption">Resume</span><label for="upload"><svg aria-hidden="true"><desc>SVGs not supported by this browser.</desc></svg></label><label id="choose" for="upload">Choose file</label><input id="upload" type="file" aria-labelledby="caption choose">');
  await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
  const field=await page.evaluate(()=>window.__formwork.scrape().schema.fields[0]);
  assert.match(field.label,/Resume/);assert.doesNotMatch(field.label,/SVGs/);
});

test('non-input comboboxes fill and read back without applying an input setter to a div',async t=>{
  const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent(`<label for="choice">Gender</label><div id="choice" tabindex="0" role="combobox" aria-haspopup="listbox" aria-controls="options">Select...</div>
    <div id="options" role="listbox" hidden><div role="option">Female</div><div role="option">Choose not to disclose</div></div>
    <script>choice.onclick=()=>{options.hidden=false};options.onclick=e=>{if(e.target.role==='option'){choice.textContent=e.target.textContent;options.hidden=true;}};</script>`);
  for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
  const report=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:'Choose not to disclose'},schema,registry);});
  assert.deepEqual(report.failed,[]);
  assert.equal(report.filled.length,1);
  assert.equal(await page.locator('#choice').innerText(),'Choose not to disclose');
});

test('rejected masked dates restore the previous value without choosing a calendar default',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<label for="date">Start date</label><input id="date" placeholder="MM/YYYY" value="07/2020"><script>
 window.keys=[];date.addEventListener('input',()=>{if(date.value!=='07/2020')date.value='';});date.addEventListener('keydown',e=>{keys.push(e.key);if(e.key==='Enter')date.value='09/2026';});</script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const report=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:'08/2018'},schema,registry)});
 assert.equal(report.filled.length,0);assert.equal(report.failed.length,1);
 assert.equal(await page.locator('#date').inputValue(),'07/2020');assert.deepEqual(await page.evaluate(()=>keys.filter(k=>k!=='Escape')),[]);
});

test('visible choice proxies expose their hidden native checkbox and commit both states',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<ul><li><div data-ui="editor"><input name="company"><input name="title"><label for="current">I currently work here</label><div id="current" role="checkbox" aria-checked="false" tabindex="0"><input name="current" type="checkbox" aria-hidden="true" style="display:none"></div></div></li></ul><div aria-hidden="true"><div role="checkbox"><input name="invisible" type="checkbox" aria-hidden="true"></div></div><script>current.onclick=()=>{const i=current.querySelector('input');i.checked=!i.checked;current.setAttribute('aria-checked',String(i.checked));};</script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const result=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();const field=schema.fields.find(f=>f.history?.key==='current');return {field,count:schema.fields.length,report:await ns.fill({[field.id]:'true'},schema,registry)}});
 assert.equal(result.count,3);assert.equal(result.field.label,'I currently work here');assert.equal(result.field.type,'checkbox');assert.equal(result.report.filled.length,1);assert.deepEqual(result.report.failed,[]);
 assert.equal(await page.locator('#current').getAttribute('aria-checked'),'true');
});

test('repeated radio proxy labels preserve the authorization question instead of Details',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<h2>Details</h2><label for="yes">Are you authorized to work in the E.U.? YES</label><div role="radio" id="yes" aria-checked="false"><input type="radio" name="eligible" value="yes" aria-hidden="true"></div><label for="no">Are you authorized to work in the E.U.? NO</label><div role="radio" id="no" aria-checked="false"><input type="radio" name="eligible" value="no" aria-hidden="true"></div>`);
 await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
 const fields=await page.evaluate(()=>window.__formwork.scrape().schema.fields);
 assert.equal(fields.length,1);assert.equal(fields[0].label,'Are you authorized to work in the E.U.?');
});

test('rejected multiword autocomplete queries terminate and later fields still fill',{timeout:12000},async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<label for="location">Current location</label><input id="location"><label for="email">Email</label><input id="email" type="email"><script>locationInput=document.getElementById('location');locationInput.addEventListener('input',()=>locationInput.value='');</script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const result=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:'New York, NY',[schema.fields[1].id]:'candidate@example.test'},schema,registry)});
 assert.equal(result.failed.length,1);assert.equal(result.filled.length,1);assert.equal(await page.locator('#email').inputValue(),'candidate@example.test');assert.equal(await page.locator('#location').inputValue(),'');
});

test('date popovers are dismissed before the next date field opens',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<form><label for="available">Availability date</label><input id="available" placeholder="MM/DD/YYYY"><label for="start">Education start</label><input id="start" placeholder="MM/YYYY"><button type="submit">Submit application</button></form><script>
 let firstOpen=false,blocked=false;window.submits=0;
 available.onfocus=()=>{firstOpen=true};document.body.addEventListener('mousedown',()=>{firstOpen=false});start.onfocus=()=>{blocked=firstOpen};start.oninput=()=>{if(blocked)start.value='';};document.querySelector('form').onsubmit=e=>{e.preventDefault();submits++;};</script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const report=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:'09/08/2026',[schema.fields[1].id]:'08/2018'},schema,registry)});
 assert.deepEqual(report.failed,[]);assert.equal(report.filled.length,2);assert.equal(await page.locator('#start').inputValue(),'08/2018');assert.equal(await page.evaluate(()=>submits),0);
});

test('a repeated question mentioning No does not turn both Yes and No options negative',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<h2>Personal information</h2><label for="yes">Are you at least 18 years or older? (If no, authorization is required): Yes</label><input id="yes" type="radio" name="age" value="y"><label for="no">Are you at least 18 years or older? (If no, authorization is required): No</label><input id="no" type="radio" name="age" value="n">`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const result=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return {schema,report:await ns.fill({[schema.fields[0].id]:'No'},schema,registry)}});
 assert.deepEqual(result.schema.fields[0].options,['Yes','No']);assert.deepEqual(result.report.failed,[]);assert.equal(await page.locator('#no').isChecked(),true);assert.equal(await page.locator('#yes').isChecked(),false);
});

test('site locale controls and footer forms are excluded from application fields',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<nav><button role="combobox" aria-label="Choose your country">United States</button></nav><main><form><label for="country">Country</label><select id="country"><option>United States</option></select><label for="email">Email</label><input id="email" type="email"></form></main><footer><form><input type="email" aria-label="Newsletter email"></form></footer>`);
 await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
 const fields=await page.evaluate(()=>window.__formwork.scrape().schema.fields);assert.deepEqual(fields.map(f=>f.label),['Country','Email']);
});

test('radio proxy selection clicks the visible control once and verifies the intended answer',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<fieldset><legend>Choice</legend><label for="yes">Yes</label><div role="radio" id="yes" aria-checked="false"><input type="radio" name="choice" aria-hidden="true" value="yes"></div><label for="no">No</label><div role="radio" id="no" aria-checked="false"><input type="radio" name="choice" aria-hidden="true" value="no"></div></fieldset><script>window.clicks=[];for(const proxy of document.querySelectorAll('[role=radio]'))proxy.onclick=e=>{clicks.push(e.target.tagName);for(const p of document.querySelectorAll('[role=radio]')){p.querySelector('input').checked=p===proxy;p.setAttribute('aria-checked',String(p===proxy));}};</script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const report=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:'No'},schema,registry)});
 assert.deepEqual(report.failed,[]);assert.deepEqual(await page.evaluate(()=>clicks),['DIV']);assert.equal(await page.locator('#no').getAttribute('aria-checked'),'true');
});

test('an upload-error page cannot report detached filled fields as successful',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<form><label for="email">Email</label><input id="email" type="email"><label for="resume">Resume</label><input id="resume" type="file"></form><script>resume.onchange=()=>{document.body.innerHTML='<p>Sorry, an unknown error occurred.</p>'};</script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const report=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:'candidate@example.test'},schema,registry,{files:{[schema.fields[1].id]:new File(['synthetic'],'resume.txt',{type:'text/plain'})}})});
 assert.deepEqual(report.filled,[]);assert.equal(report.failed.length,2);
});

test('day calendars navigate across years, reject disabled/invalid dates, and normalize zero padding',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<label for="date">Start date</label><input id="date" placeholder="MM/DD/YYYY"><script>
 const input=document.getElementById('date');let year=2026,month=12;window.selections=[];
 function render(){document.querySelector('.react-datepicker')?.remove();const popup=document.createElement('div');popup.className='react-datepicker';popup.innerHTML='<button type="button" aria-label="Previous month">Back</button><button type="button" aria-label="Next month">Next</button><div class="react-datepicker__month" role="listbox" aria-label="month '+year+'-'+String(month).padStart(2,'0')+'"><div class="react-datepicker__day react-datepicker__day--001 react-datepicker__day--outside-month">1</div><div class="react-datepicker__day react-datepicker__day--001">1</div><div class="react-datepicker__day react-datepicker__day--002" aria-disabled="true">2</div></div>';document.body.append(popup);const buttons=popup.querySelectorAll('button');buttons.forEach((b,i)=>b.onclick=()=>{month+=i?1:-1;if(month===13){month=1;year++;}if(month===0){month=12;year--;}render();});popup.querySelector('.react-datepicker__day--001:not(.react-datepicker__day--outside-month)').onclick=()=>{selections.push(year+'-'+month+'-1');input.value=String(month).padStart(2,'0')+'/01/'+year;popup.remove();};}
 input.onfocus=render;input.oninput=()=>{input.value='';};</script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const report=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:'1/1/2027'},schema,registry)});
 assert.deepEqual(report.failed,[]);assert.equal(await page.locator('#date').inputValue(),'01/01/2027');assert.deepEqual(await page.evaluate(()=>selections),['2027-1-1']);
 for(const value of ['01/02/2027','02/30/2027']){
  const failed=await page.evaluate(async value=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:value},schema,registry)},value);
  assert.equal(failed.filled.length,0);assert.equal(failed.failed.length,1);assert.equal(await page.locator('#date').inputValue(),'01/01/2027');
 }
 assert.deepEqual(await page.evaluate(()=>selections),['2027-1-1']);
});

test('a native ISO date input is not verified as its US placeholder text',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent('<label for="date">Date</label><input id="date" type="date" placeholder="MM/DD/YYYY">');
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const report=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:'2026-09-08'},schema,registry)});
 assert.deepEqual(report.failed,[]);assert.equal(await page.locator('#date').inputValue(),'2026-09-08');
});

test('a radio wrapper without a click handler falls back to the native change event',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<fieldset><legend>Qualified?</legend><label for="yes">YES</label><div id="yes" role="radio" aria-checked="false"><input type="radio" name="qualified" value="true" aria-hidden="true"></div><label for="no">NO</label><div id="no" role="radio" aria-checked="false"><input type="radio" name="qualified" value="false" aria-hidden="true"></div></fieldset><script>for(const input of document.querySelectorAll('input'))input.onchange=()=>{for(const i of document.querySelectorAll('input'))i.parentElement.setAttribute('aria-checked',String(i.checked));};</script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const report=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:'YES'},schema,registry)});
 assert.deepEqual(report.failed,[]);assert.equal(await page.locator('#yes').getAttribute('aria-checked'),'true');
});

test('a nested radio label is activated instead of its outer presentation wrapper',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<fieldset><legend>Qualified?</legend><div id="yes" role="radio" aria-label="YES" aria-checked="false"><label><input type="radio" name="qualified" value="true" aria-hidden="true"><span>YES</span></label></div></fieldset><script>window.targets=[];yes.addEventListener('click',e=>{targets.push(e.target.tagName);yes.setAttribute('aria-checked',String(yes.querySelector('input').checked));});</script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const report=await page.evaluate(async()=>{const ns=window.__formwork,{schema,registry}=ns.scrape();return ns.fill({[schema.fields[0].id]:'YES'},schema,registry)});
 assert.deepEqual(report.failed,[]);assert.equal((await page.evaluate(()=>targets))[0],'LABEL');assert.equal(await page.locator('#yes input').isChecked(),true);assert.equal(await page.locator('#yes').getAttribute('aria-checked'),'true');
});

test('a neighboring country selector does not turn the phone textbox into a combobox',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent('<div><div><input role="combobox" aria-label="Country code" placeholder="Search"></div><div><input inputmode="tel" aria-label="Phone number"></div></div>');
 await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
 const fields=await page.evaluate(()=>window.__formwork.scrape().schema.fields);
 assert.equal(fields.find(f=>f.label==='Country code').type,'combobox');
 assert.equal(fields.find(f=>f.label==='Phone number').type,'text');
});

test('a label targeting the radiogroup supplies the question and proxies supply individual answers',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<label for="eligibility">Are you authorized to work in the United States?</label><div id="eligibility" role="radiogroup"><div role="radio" aria-checked="false"><input style="opacity:0;width:1px" type="radio" name="eligible" value="yes"><p>Yes</p></div><div role="radio" aria-checked="false"><input style="opacity:0;width:1px" type="radio" name="eligible" value="no"><p>No</p></div></div>`);
 await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
 const field=await page.evaluate(()=>window.__formwork.scrape().schema.fields[0]);
 assert.equal(field.label,'Are you authorized to work in the United States?');assert.deepEqual(field.options,['Yes','No']);
});

for(const accepts of [true,false])test(`input-rendered selector requires the host's selected-option confirmation (${accepts})`,async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<div data-testid="select-controller"><input id="race" role="combobox" aria-label="Race" data-input="select-search-input" aria-controls="choices"></div><ul id="choices" role="listbox" hidden><li role="option" aria-selected="false">Two or more races</li><li role="option" aria-selected="false">Choose not to disclose</li></ul><script>
 window.arrows=0;race.onclick=()=>choices.hidden=false;race.onkeydown=e=>{if(e.key==='ArrowDown')arrows++;if(e.key==='Escape')choices.hidden=true};
 for(const option of choices.children)option.onclick=()=>{if(${accepts}){for(const o of choices.children)o.setAttribute('aria-selected',String(o===option));race.value=option.textContent;}choices.hidden=true;};
 </script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const report=await page.evaluate(async()=>{const n=window.__formwork,s=n.scrape();return n.fill({f0:'Choose not to disclose'},s.schema,s.registry)});
 assert.equal(report.filled.length,accepts?1:0);assert.equal(report.failed.length,accepts?0:1);
 assert.equal(await page.evaluate(()=>arrows),0);
 assert.equal(await page.locator('#race').inputValue(),accepts?'Choose not to disclose':'');
});

test('a single custom-question wrapper supplies its adjacent prompt without borrowing another question',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<main><section><div><p>Are you currently enrolled in a graduate program?</p></div><div data-testid="field"><div role="combobox" aria-label="Select" aria-haspopup="listbox" tabindex="0">Select</div></div></section><section><div><p>Do you consent to text messages?</p></div><div data-testid="field"><div role="radiogroup"><div role="radio" aria-checked="false"><input type="radio" name="consent" value="yes"><p>Yes</p></div><div role="radio" aria-checked="false"><input type="radio" name="consent" value="no"><p>No</p></div></div></div></section></main>`);
 await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
 const fields=await page.evaluate(()=>window.__formwork.scrape().schema.fields);
 assert.equal(fields.find(f=>f.type==='combobox').label,'Are you currently enrolled in a graduate program?');
 assert.equal(fields.find(f=>f.type==='radio').label,'Do you consent to text messages?');
 assert.deepEqual(fields.find(f=>f.type==='radio').options,['Yes','No']);
});

for(const mode of ['accept','ignore','wrong-region','ambiguous'])test(`location suggestions require a unique city/region and a committed selection (${mode})`,async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<div data-testid="location"><input id="place" aria-label="Location" aria-autocomplete="list" aria-haspopup="listbox"></div><script>
 place.oninput=()=>{document.querySelector('#places')?.remove();const list=document.createElement('ul');list.id='places';list.role='listbox';place.setAttribute('aria-controls','places');
 const values=${JSON.stringify(mode==='wrong-region'?['Asheville, Tennessee, USA']:mode==='ambiguous'?['Asheville, North Carolina, USA','Asheville, North Carolina, Canada']:['Asheville, North Carolina, USA','Ashville, Alabama, USA'])};
 for(const value of values){const li=document.createElement('li');li.role='option';li.textContent=value;li.onclick=()=>{if(${mode!=='ignore'}){place.value=value;list.remove();place.removeAttribute('aria-controls');}};list.append(li);}document.body.append(list);};
 </script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const report=await page.evaluate(async()=>{const n=window.__formwork,s=n.scrape();return n.fill({f0:'Asheville, North Carolina'},s.schema,s.registry)});
 assert.equal(report.filled.length,mode==='accept'?1:0);
 assert.equal(report.failed.length,mode==='accept'?0:1);
 assert.equal(await page.locator('#place').inputValue(),mode==='accept'?'Asheville, North Carolina, USA':'Asheville, North Carolina');
});

test('required text and choice questions recognize Teamtailor markers without marking optional siblings',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<label for="first">First name<sup>*</sup><span>Required</span></label><input id="first"><label for="optional">Optional nickname</label><input id="optional"><div data-question-mandatory="true"><h3>Languages</h3><label><input type="checkbox" name="lang" value="English">English</label><label><input type="checkbox" name="lang" value="French">French</label></div>`);
 await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});const fields=await page.evaluate(()=>window.__formwork.scrape().schema.fields);
 assert.equal(fields.find(f=>f.label.startsWith('First name')).required,true);assert.equal(fields.find(f=>f.label==='Optional nickname').required,false);assert.equal(fields.find(f=>f.type==='checkbox-group').required,true);
});

for(const mode of ['format','truncate','reject'])test(`telephone readback allows formatting but preserves every digit (${mode})`,async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<label for="phone">Phone</label><input id="phone" type="tel"><script>phone.oninput=()=>{phone.value=phone.value.replace(/[^0-9]/g,'')${mode==='truncate'?'.slice(1)':''};${mode==='reject'?'phone.setAttribute("aria-invalid","true");':''}};</script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const result=await page.evaluate(async()=>{const n=window.__formwork,s=n.scrape();return n.fill({f0:'919-555-0142'},s.schema,s.registry)});
 assert.equal(result.filled.length,mode==='format'?1:0);
});

test('a checkbox group selects multiple choices, replaces the set, and rejects unknown choices before touching it',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent('<fieldset><legend>Languages</legend><label><input type="checkbox" name="languages" value="1">English</label><label><input type="checkbox" name="languages" value="2">French</label><label><input type="checkbox" name="languages" value="3">Spanish</label></fieldset>');
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const fill=values=>page.evaluate(async values=>{const n=window.__formwork,s=n.scrape();return n.fill({f0:values},s.schema,s.registry)},values);
 assert.equal((await fill(['English','French'])).filled.length,1);assert.deepEqual(await page.locator('input').evaluateAll(es=>es.map(e=>e.checked)),[true,true,false]);
 assert.equal((await fill(['French'])).filled.length,1);assert.deepEqual(await page.locator('input').evaluateAll(es=>es.map(e=>e.checked)),[false,true,false]);
 assert.equal((await fill(['French','Unknown'])).failed.length,1);assert.deepEqual(await page.locator('input').evaluateAll(es=>es.map(e=>e.checked)),[false,true,false]);
});

test('JazzHR checkboxes share their actual question and enforce an explicit single-answer limit',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<div class="form-group"><label class="control-label" for="question">Which role do you want? Please choose 1 answer only<i class="asterisk">*</i></label><input type="hidden" id="question" class="resumator-questionnaire-checkbox-answer"><label><input class="resumator-questionnaire-checkbox" type="checkbox" name="role-junior" value="Junior">Junior</label><label><input class="resumator-questionnaire-checkbox" type="checkbox" name="role-senior" value="Senior">Senior</label></div>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const result=await page.evaluate(async()=>{const n=window.__formwork,s=n.scrape();return{fields:s.schema.fields,report:await n.fill({f0:['Junior','Senior']},s.schema,s.registry)}});
 assert.equal(result.fields.length,1);assert.match(result.fields[0].label,/Which role/);assert.equal(result.fields[0].required,true);assert.equal(result.fields[0].maxSelections,1);assert.deepEqual(result.fields[0].options,['Junior','Senior']);assert.equal(result.report.failed.length,1);assert.equal(await page.locator('input:checked').count(),0);
});

for(const existing of [false,true])test(`JazzHR attachment mode opens only when no pasted resume exists (${existing})`,async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<div id="resumator-resume"><label for="resumator-resume-value">Resume*</label><a id="resumator-choose-upload" href="#">Attach resume</a><div id="upload" style="display:none"><input id="resumator-resume-value" type="file"></div><textarea id="resumator-resumetext-value" style="display:none">${existing?'Existing resume':''}</textarea></div><script>window.opens=0;document.getElementById('resumator-choose-upload').onclick=e=>{e.preventDefault();opens++;upload.style.display='block';};</script>`);
 await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
 const fields=await page.evaluate(async()=> (await window.__formwork.scrapeFull()).schema.fields);
 assert.equal(await page.evaluate(()=>opens),existing?0:1);
 assert.equal(fields.some(f=>f.type==='file'),!existing);
 assert.equal(await page.locator('#resumator-resumetext-value').inputValue(),existing?'Existing resume':'');
});

for (const hidden of [false,true]) test(`Breezy resume uses its visible application trigger (${hidden})`,async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<form ng-submit="apply()"><a class="resume" ng-click="showFileSelector()" ${hidden?'style="display:none"':''}>Upload Resume</a><input type="hidden" id="resume_required" value="required"><input type="file" id="main-attachment" name="cResume" ng-file-select="onFileSelect($files)" style="display:none"><input type="file" id="unrelated" style="display:none"><div aria-hidden="true"><input type="file" name="honeypot"></div></form>`);
 await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
 const fields=await page.evaluate(()=>window.__formwork.scrape().schema.fields);
 assert.equal(fields.length,hidden?0:1);
 if(!hidden){assert.equal(fields[0].label,'Resume');assert.equal(fields[0].required,true);}
});

for(const innerTag of ["ul","div"])for(const accepts of [true,false])test(`input selection finds a virtualized exact option and verifies host selection (${accepts}, inner=${innerTag})`,async t=>{
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<div data-testid="select-controller"><input id="dial" role="combobox" aria-label="Phone country code" data-input="select-search-input" aria-controls="menu"></div><div id="menu" role="listbox" hidden><${innerTag} id="codes" style="height:100px;overflow:auto"></${innerTag}></div><script>
 let chosen=false;
 function draw(){codes.innerHTML='<div style="height:400px"><li role="option" aria-selected="'+chosen+'">'+(codes.scrollTop>50?'+44 GB - United Kingdom':'+1 US - United States')+'</li></div>';codes.querySelector('li').onclick=()=>{if(${accepts}){chosen=true;dial.value='+44 GB';}menu.hidden=true;};}
 codes.onscroll=draw;dial.onclick=()=>{menu.hidden=false;codes.scrollTop=0;draw();};dial.onkeydown=e=>{if(e.key==='Escape')menu.hidden=true;};dial.oninput=draw;
 </script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const report=await page.evaluate(async()=>{const n=window.__formwork,s=n.scrape();return n.fill({f0:'+44 GB - United Kingdom'},s.schema,s.registry)});
 assert.equal(report.filled.length,accepts?1:0);assert.equal(report.failed.length,accepts?0:1);
 if(accepts)assert.equal(await page.locator('#dial').inputValue(),'+44 GB');
});

for(const mode of ['replace','ambiguous','replace-container'])test(`phone-country replacement is observed within the original phone pair (${mode})`,async t=>{
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<div id="pair"><div id="holder"></div><input data-input="phone_number" aria-label="Phone number"></div><ul id="menu" role="listbox" hidden><li role="option" aria-selected="false">+44 GB - United Kingdom</li></ul><script>
 let selected=false;window.optionClicks=0;
 function render(){holder.innerHTML='<div data-testid="phone_number-code"><div data-testid="select-controller"><input data-input="select-search-input" role="combobox" aria-label="Search" aria-controls="menu" value="'+(selected?'+44 GB':'+1 US')+'"></div></div>';const input=holder.querySelector('input');input.onclick=()=>menu.hidden=false;input.onkeydown=e=>{if(e.key==='Escape')menu.hidden=true;};}
 menu.firstElementChild.onclick=()=>{optionClicks++;selected=true;menu.firstElementChild.setAttribute('aria-selected','true');menu.hidden=true;if('${mode}'==='replace-container'){pair.outerHTML=pair.outerHTML;}render();if('${mode}'==='ambiguous')holder.append(holder.firstElementChild.cloneNode(true));};render();
 </script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const result=await page.evaluate(async()=>{const n=__formwork,s=n.scrape();const report=await n.fill({f0:'+44 GB - United Kingdom'},s.schema,s.registry);return {report,connected:s.registry[0][0].isConnected,clicks:optionClicks}});
 assert.equal(result.report.filled.length,mode==='replace'?1:0);assert.equal(result.clicks,1);
 if(mode==='replace')assert.equal(result.connected,true);
});

for(const mode of ['accept','wrong-country','unconfirmed','truncate','changed-country'])test(`paired phone preserves international identity (${mode})`,async t=>{
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent(`<div id="pair"><div data-testid="phone_number-code"><div data-testid="select-controller"><input id="dial" data-input="select-search-input" role="combobox" aria-label="Phone country code" aria-controls="menu" value="+44 GB"></div></div><div><input id="number" data-input="phone_number" inputmode="tel" aria-label="Phone number"></div></div><ul id="menu" role="listbox" hidden><li role="option" aria-selected="true">+44 GB - United Kingdom</li></ul><script>
 dial.onclick=()=>menu.hidden=false;dial.onkeydown=e=>{if(e.key==='Escape')menu.hidden=true};menu.firstElementChild.onclick=()=>menu.hidden=true;
 number.oninput=()=>{number.value=number.value.replace(/[^0-9]/g,'')${mode==='truncate'?'.slice(1)':''};};number.onblur=()=>{${mode==='changed-country'?"dial.value='+1 US';":''}};
 </script>`);
 for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const result=await page.evaluate(async mode=>{const n=__formwork,s=n.scrape();const fills={};if(mode!=='unconfirmed')fills.f0='+44 GB - United Kingdom';fills.f1=mode==='wrong-country'?'+1 202 555 0199':'+44 7700 900123';const report=await n.fill(fills,s.schema,s.registry);return{report,value:document.querySelector('#number').value}},mode);
 assert.equal(result.report.filled.includes('f1'),mode==='accept');
 if(mode==='accept')assert.equal(result.value,'7700900123');
 if(['wrong-country','unconfirmed'].includes(mode))assert.equal(result.value,'');
});
