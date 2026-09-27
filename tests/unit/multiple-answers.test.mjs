import test from 'node:test';import assert from 'node:assert/strict';import {lib,profile,schemaOf} from '../helpers/load.mjs';const {validate}=lib('validate');
test('checkbox arrays validate every choice and never leak into single-choice fields',()=>{
 const s=schemaOf({label:'Tools used',type:'checkbox-group',options:['Python','Go','Rust'],required:true},{label:'Primary tool',type:'radio',options:['Python','Go']});
 assert.deepEqual(validate({f0:['Python','Go','Python'],f1:['Python','Go']},s,profile()).fills,{f0:['Python','Go']});
 assert.equal(validate({f0:['Python','Unknown']},s,profile()).fills.f0,undefined);
 assert.equal(validate({f0:[]},s,profile()).missingRequired.length,1);
});
test('C2 language answers use explicit proficiency records instead of model guesses',()=>{
 const p=profile();const s=schemaOf({label:'Which languages do you speak at a near-native (C2) level?',type:'checkbox-group',required:true,options:['English','French','Spanish']});
 assert.deepEqual(validate({f0:['French']},s,p).fills,{});
 p.languages=[{name:'English',proficiency:'native'},{name:'French',proficiency:'C2'},{name:'Spanish',proficiency:'B1'}];
 assert.deepEqual(validate({f0:['Spanish']},s,p).fills,{f0:['English','French']});
});
test('offered office locations are not inferred from a general onsite preference',()=>{
 const p=profile();const s=schemaOf({label:'Locations*Required',type:'checkbox-group',required:true,options:['Barcelona','Paris']});
 assert.deepEqual(validate({f0:['Barcelona','Paris']},s,p).fills,{});
 p.preferences.work_locations=['Paris'];assert.deepEqual(validate({f0:['Barcelona','Paris']},s,p).fills,{f0:['Paris']});
});
test('explicit single-answer checkbox groups reject multiple distinct selections',()=>{
 const s=schemaOf({label:'Choose one role',type:'checkbox-group',required:true,maxSelections:1,options:['Junior','Senior']});
 assert.deepEqual(validate({f0:['Junior','Senior']},s,profile()).fills,{});
 assert.deepEqual(validate({f0:['Junior','Junior']},s,profile()).fills,{f0:['Junior']});
});
