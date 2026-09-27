import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';
test('iCIMS lazy entry requires a unique same-job same-origin application link',async t=>{
 const b=await chromium.launch();t.after(()=>b.close());const p=await b.newPage();await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<main></main>'}));await p.goto('https://careers-example.icims.com/jobs/7810/software-engineer/job');
 const link='<a class="iCIMS_ApplyOnlineButton" title="Apply for this job online" href="/jobs/7810/software-engineer/job?mode=apply&apply=yes"><span class="iCIMS_LongLabel">Apply for this job online</span><span class="iCIMS_ShortLabel">Apply</span></a>';
 for(const [html,expected] of [[link,true],[link+link,false],['<form>'+link+'</form>',false],[link.replace('7810','9999'),false],[link.replace('href="/','href="https://other.example/'),false],[link.replace('apply=yes','apply=no'),false],[link.replace('<a ','<a aria-disabled="true" '),false],[link.replace('<a ','<a onclick="return false" '),false]]){
  await p.setContent(html);await p.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});assert.equal(await p.evaluate(()=>Boolean(__formwork.lazyFormOpener())),expected,html);
 }
});
