import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../extension/src/lib/storage.js',import.meta.url),'utf8');
function fixture({paired=true,fail=false}={}){
 const state={settings:paired?{dashboardUrl:'https://dashboard.example'}:{},profile:{identity:{email:'local@example.test'},work_authorization:{requires_sponsorship_now:true}},about:'My local interests'};
 let calls=0;
 const context=vm.createContext({URL,AbortSignal,chrome:{storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,state[k]])),set:async v=>Object.assign(state,structuredClone(v))}}},fetch:async()=>{calls++;if(fail)throw Error('offline');return{ok:true,json:async()=>({profile:{identity:{email:'server@example.test'},experience:[{employer:'Fixture TLS'}],projects:[{name:'Fixture infrastructure'}],education:[{school:'Fixture University'}],work_authorization:{requires_sponsorship_now:false}},about:'My firsthand product experience'})}}});
 vm.runInContext(source,context);return{state,calls:()=>calls,get:()=>vm.runInContext('__formwork.storage.getCandidateContext()',context)};
}
test('paired browser refreshes career grounding, preserves local protected values and interests across repeated refreshes',async()=>{
 const f=fixture();for(let i=0;i<2;i++){
  const c=await f.get();assert.equal(c.profile.experience[0].employer,'Fixture TLS');assert.equal(c.profile.identity.email,'local@example.test');assert.equal(c.profile.work_authorization.requires_sponsorship_now,true);
  assert.equal(c.about,'My firsthand product experience\n\nMy local interests');
 }
});
test('unpaired browser stays local; offline dashboard reports cached context explicitly',async()=>{
 const local=fixture({paired:false});await local.get();assert.equal(local.calls(),0);
 const offline=fixture({fail:true});const c=await offline.get();assert.match(c.contextWarning,/offline/);assert.equal(c.about,'My local interests');
});
