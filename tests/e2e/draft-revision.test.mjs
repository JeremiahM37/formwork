import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';

test('approved drafts re-find replaced fields; instructions and errors stay visible',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent('<form><label for="answer">What interests you about Outmarket?</label><textarea id="answer"></textarea></form>');
 await page.evaluate(()=>{window.requests=[];window.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async message=>{
  window.requests.push(message);
  if(message.type==='plan')return {fills:{},review:[],dropped:[],missingRequired:[],staged:[{id:message.payload.schema.fields[0].id,question:'What interests you about Outmarket?',text:'Original draft'}]};
  if(message.type==='redraft')return window.revisionFails?{error:'Model unavailable'}:{text:'Shorter revised answer',tells:[]};
  if(message.type==='historyRecords')return {};
  if(message.type==='fanout')return [];
  return {};
 }}}});
 for(const file of ['scrape.js','fill.js','index.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 await page.getByRole('button',{name:'Fill this form',exact:true}).click();
 const draft=page.getByRole('textbox',{name:'Draft answer',exact:true});await draft.waitFor();
 await page.getByRole('textbox',{name:'How should this change?',exact:true}).fill('Make it shorter and focus on my internship');
 await page.getByRole('button',{name:'Revise with instructions'}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-formwork-ui=panel]')].some(host=>host.shadowRoot?.querySelector('textarea[aria-label="Draft answer"]')?.value==='Shorter revised answer'));
 assert.equal(await draft.inputValue(),'Shorter revised answer');
 const request=await page.evaluate(()=>window.requests.find(r=>r.type==='redraft'));
 assert.equal(request.payload.previous,'Original draft');assert.match(request.payload.instruction,/internship/);
 assert.equal(await page.locator('#answer').inputValue(),'');
 await page.evaluate(()=>window.revisionFails=true);await page.getByRole('button',{name:'Revise with instructions'}).click();
 await page.getByText('Revision failed: Model unavailable',{exact:true}).waitFor();assert.equal(await draft.inputValue(),'Shorter revised answer');
 await page.evaluate(()=>{const old=document.querySelector('#answer');old.replaceWith(old.cloneNode());const other=document.createElement('input');other.name='unrelated';document.querySelector('form').prepend(other)});
 await page.getByRole('button',{name:'Approve & fill',exact:true}).click();await page.getByText('approved and filled',{exact:true}).waitFor();
 assert.equal(await page.locator('#answer').inputValue(),'Shorter revised answer');assert.equal(await page.locator('input[name=unrelated]').inputValue(),'');
});

test('approval refuses ambiguous replacement questions rather than using a shifted id',async t=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent('<label>Why this role?<textarea></textarea></label>');
 await page.evaluate(()=>window.chrome={runtime:{onMessage:{addListener(){}}}});
 for(const file of ['scrape.js','fill.js','index.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
 const result=await page.evaluate(async()=>{const ns=window.__formwork,scraped=ns.scrape();ns._last={scraped};document.body.append(document.querySelector('label').cloneNode(true));return ns.fillApproved(scraped.schema.fields[0].id,'Approved answer')});
 assert.equal(result.ok,false);assert.match(result.reason,/ambiguous/);assert.deepEqual(await page.locator('label textarea').evaluateAll(es=>es.map(e=>e.value)),['','']);
});
