import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';
test('hidden file inputs use their unique visible label and own legend',async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();
 await p.setContent(`<style>input[type=file]{display:none}</style>
 <fieldset><legend>Upload CV <abbr title="required">*</abbr><span class="upload-hint">PDF, max 2 MB</span></legend><label>Select file<input type="file"></label></fieldset>
 <fieldset><legend>Supporting documents</legend><label>Select file<input type="file"></label></fieldset>
 <fieldset hidden><legend>Hidden upload</legend><label>Select file<input type="file"></label></fieldset>
 <label>Select file<input type="file"><input type="file"></label>
 <label>Leave this blank<input type="file" name="bot-trap"></label>
 <label for="inactive">Resume</label><div hidden><input type="file" id="inactive"></div>
 <input type="file" id="unlabelled">`);
 await p.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
 const fields=await p.evaluate(()=>window.__formwork.scrape().schema.fields);
 assert.equal(fields.length,2);
 assert.equal(fields[0].type,'file');assert.match(fields[0].label,/Upload CV/);assert.doesNotMatch(fields[0].label,/max 2 MB/);assert.equal(fields[0].required,true);
 assert.equal(fields[1].label,'Supporting documents');assert.equal(fields[1].required,false);
});

test('Dayforce files bind to attachment buttons without importing resume data',async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();
 const slot=(id,trigger,text,extra='')=>`<span class="ant-upload"><input type="file" id="jobPostingApplication_files_${id}" style="display:none"><button type="button" test-id="${trigger}" ${extra}>${text}</button></span>`;
 const resume=slot('resume','resume-upload-button','Import Resume');
 await p.setContent(slot('resume','import-resume-section-button','Import Resume')+resume+
  slot('coverLetter','cover-letter-upload-button','Add Cover Letter')+
  slot('additionalDocument','additional-documents-upload-button','Add Additional Documents')+
  '<div hidden>'+resume+'</div>'+slot('resume','resume-upload-button','Import Resume','disabled')+
  slot('resume','resume-upload-button','Import Resume','aria-disabled="true"')+
  slot('resume','resume-upload-button','Delete Resume')+
  resume.replace('</span>','<input type="file" style="display:none"></span>'));
 await p.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
 assert.deepEqual(await p.evaluate(()=>__formwork.scrape().schema.fields.map(f=>({label:f.label,type:f.type}))),[
  {label:'Resume',type:'file'},{label:'Cover Letter',type:'file'},{label:'Additional Documents',type:'file'}]);
 await p.addScriptTag({path:join(ROOT,'extension/src/content/fill.js')});
 const result=await p.evaluate(async()=>{
  const ns=__formwork,{schema,registry}=ns.scrape();
  const report=await ns.fill({},schema,registry,{files:{f0:new File(['Synthetic resume'], 'resume.pdf',{type:'application/pdf'})}});
  return {report,counts:[...document.querySelectorAll('input[type=file]')].map(el=>el.files.length),bytes:await registry[0][0].files[0].text()};
 });
 assert.deepEqual(result.report.filled,['f0']);assert.deepEqual(result.report.failed,[]);
 assert.deepEqual(result.counts,[0,1,0,0,0,0,0,0,0,0]);assert.equal(result.bytes,'Synthetic resume');
 const rejected=await p.evaluate(async()=>{
  const {schema,registry}=__formwork.scrape();
  registry[0][0].addEventListener('change',e=>{e.target.value=''});
  return __formwork.fill({},schema,registry,{files:{f0:new File(['replacement'],'resume.pdf',{type:'application/pdf'})}});
 });
 assert.deepEqual(rejected.filled,[]);assert.match(rejected.failed[0].reason,/attachment.*confirm/i);
});
