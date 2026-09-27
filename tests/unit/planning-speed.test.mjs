import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {lib,profile,schemaOf} from '../helpers/load.mjs';
const source=readFileSync(new URL('../../extension/src/background/service-worker.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
function worker(chat){
 const context=vm.createContext({URL,chrome:{runtime:{onInstalled:{addListener(){}},onMessage:{addListener(){}}},action:{onClicked:{addListener(){}}}},__formwork:{
  validate:lib('validate'),prompt:lib('prompt'),draft:lib('draft'),
  providers:{resolve:()=>({chat}),parseJSON:JSON.parse},
  storage:{getCandidateContext:async()=>({profile:profile(),about:'',settings:{}}),getBank:async()=>[],getDocuments:async()=>({}),getCredentials:async()=>({})}
 }});
 vm.runInContext(source,context);return context.plan;
}
test('profile-only form bypasses the model and retains identical validated answers',async()=>{
 let calls=0;const run=worker(async()=>{calls++;throw new Error('Model must not be needed')});
 const schema=schemaOf({label:'First Name'},{label:'Last Name'},{label:'Email',type:'email'});
 const result=await run({schema,fullOptions:{}},{});
 assert.equal(calls,0);assert.equal(result.mapError,null);
 assert.deepEqual(JSON.parse(JSON.stringify(result.fills)),lib('validate').validate({},schema,profile()).fills);
});
test('unresolved mapping and essay drafting start together without approving the draft',async()=>{
 const pending=[];const run=worker((messages,opts)=>new Promise(resolve=>pending.push({messages,opts,resolve})));
 const resultPromise=run({schema:schemaOf({label:'Which office arrangement would you prefer?'},{label:'Why are you interested in this company?',type:'textarea'}),fullOptions:{}},{});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(pending.length,2,'mapping and drafting must both start before either response');
 pending.find(p=>p.opts.json).resolve('{}');pending.find(p=>!p.opts.json).resolve('Draft for review');
 const result=await resultPromise;assert.equal(result.staged[0].text,'Draft for review');assert.equal(result.staged[0].needsApproval,true);assert.equal(result.autoApprove,false);
});
test('a mapping failure retains profile answers and still returns a draft',async()=>{
 const run=worker(async(messages,opts)=>{if(opts.json)throw new Error('offline');return 'Draft for review'});
 const result=await run({schema:schemaOf({label:'First Name'},{label:'Why are you interested in this company?',type:'textarea'}),fullOptions:{}},{});
 assert.match(result.mapError,/offline/);assert.ok(result.fills.f0);assert.equal(result.staged.length,1);
});
