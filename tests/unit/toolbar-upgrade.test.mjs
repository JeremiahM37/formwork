import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../extension/src/background/service-worker.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
for(const previous of [null,'0.1.7','0.1.8'])test(`toolbar upgrades stale UI before considering a toggle (${previous})`,async()=>{
 const calls=[];let click;
 const chrome={runtime:{getManifest:()=>({version:'0.1.8'}),onInstalled:{addListener(){}},onMessage:{addListener(){}}},action:{onClicked:{addListener:fn=>click=fn}},scripting:{executeScript:async args=>{calls.push(args.files?'inject':'probe');return[{result:previous}]}},tabs:{sendMessage:async(id,message,target)=>{calls.push('toggle');assert.equal(message.type,'formwork/toggle-current');assert.equal(target.frameId,0)}}};
 vm.runInNewContext(source,{chrome,__formwork:{}});await click({id:5});
 assert.deepEqual(calls,previous==='0.1.8'?['probe','inject','toggle']:['probe','inject']);
});
