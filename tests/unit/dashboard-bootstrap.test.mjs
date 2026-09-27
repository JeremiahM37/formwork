import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../extension/src/background/dashboard-bootstrap.js',import.meta.url),'utf8');
async function upgrade(settings) {
 const state={profile:{identity:{full_name:'Test Applicant'}},about:'Keep my notes',settings};
 const context=vm.createContext({chrome:{storage:{local:{get:async()=>structuredClone(state),set:async(v)=>Object.assign(state,v)}},runtime:{getURL:x=>x,onInstalled:{addListener(){}},onStartup:{addListener(){}}}},fetch:async()=>({json:async()=>({origin:'http://lab.example:9113'})})});
 vm.runInContext(source,context);
 await vm.runInContext('pairDashboard()',context);
 return state;
}
test('paired upgrade repairs missing model address without replacing applicant or preferences',async()=>{
 const result=await upgrade({provider:'homelab',homelab:{},autoApprove:false,custom:'keep'});
 assert.equal(result.settings.homelab.baseUrl,'http://lab.example:9113');
 assert.equal(result.settings.custom,'keep');
 assert.equal(result.profile.identity.full_name,'Test Applicant');
 assert.equal(result.about,'Keep my notes');
});
test('paired upgrade preserves explicitly chosen hosts and other providers',async()=>{
 assert.equal((await upgrade({provider:'homelab',homelab:{baseUrl:'http://my-model:8000'}})).settings.homelab.baseUrl,'http://my-model:8000');
 assert.equal((await upgrade({provider:'ollama',ollama:{baseUrl:'http://my-model:11434'}})).settings.provider,'ollama');
});
