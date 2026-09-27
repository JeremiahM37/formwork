import test from 'node:test';
import assert from 'node:assert/strict';
import {lib,profile,schemaOf} from '../helpers/load.mjs';
const {validate}=lib('validate');

test('residence and language gate uses an explicit country only for an unambiguous country option',()=>{
  const p=profile();
  const s=schemaOf({label:'Location of Residence and Language:',type:'select',options:['United States','Denmark','Other']});
  assert.equal(validate({f0:'Denmark'},s,p).fills.f0,'United States');
  s.fields[0].options=['United States - English','United States - Spanish','Other'];
  assert.equal(validate({f0:'United States - English'},s,p).fills.f0,undefined);
  s.fields[0].options=['United States','United States','Other'];
  assert.equal(validate({},s,p).fills.f0,undefined);
  s.fields[0].options=['United States','Denmark','Other'];
  delete p.identity.location.country;
  assert.equal(validate({f0:'United States'},s,p).fills.f0,undefined);
  s.fields[0].type='text';p.identity.location.country='United States';
  assert.equal(validate({f0:'United States, English'},s,p).fills.f0,undefined);
});

test('Personio short name captions use profile facts without filling last-employer questions',()=>{
  const p=profile();
  const schema=schemaOf({label:'First'},{label:'Last'},{label:'Last employer'},{label:"Reference last name"});
  const result=validate({},schema,p);
  assert.deepEqual(result.fills,{f0:p.identity.first_name,f1:p.identity.last_name});
});

test('preferred and middle names are explicit facts, never a legal-name fallback',()=>{
  const p=profile();p.identity.preferred_name='Dani';p.identity.middle_name='Elena';
  const schema=schemaOf({label:'Preferred name'},{label:'Middle name'},{label:'Your name'});
  assert.deepEqual(validate({},schema,p).fills,{f0:'Dani',f1:'Elena',f2:p.identity.full_name});
  delete p.identity.preferred_name;delete p.identity.middle_name;
  assert.deepEqual(validate({f0:'Guessed',f1:'Guessed'},schema,p).fills,{f2:p.identity.full_name});
  p.identity.preferred_name='Dani Rivera';
  const parts=schemaOf({label:'Preferred first name'},{label:'Preferred last name'});
  assert.deepEqual(validate({},parts,p).fills,{});
  p.identity.preferred_first_name='Dani';p.identity.preferred_last_name='Rivera';
  assert.deepEqual(validate({},parts,p).fills,{f0:'Dani',f1:'Rivera'});
});

test('US state abbreviations match only within the state field and explicit US country',()=>{
  const p=profile();
  const schema=schemaOf({label:'State',type:'select',options:['NC','SC']});
  assert.equal(validate({},schema,p).fills.f0,'NC');
  p.identity.location.state='NC';schema.fields[0].options=['North Carolina','South Carolina'];
  assert.equal(validate({},schema,p).fills.f0,'North Carolina');
  p.identity.location.country='Canada';
  assert.equal(validate({},schema,p).fills.f0,undefined);
});

test('current employment requires a single explicitly current role',()=>{
  const p=profile();const schema=schemaOf({label:'Current employer'},{label:'Current job title'});
  assert.deepEqual(validate({},schema,p).fills,{f0:'Fixture Company',f1:'Software Engineer'});
  p.experience.push({...p.experience[0],employer:'Concurrent job'});
  assert.deepEqual(validate({f0:'Guessed'},schema,p).fills,{});
  p.experience=[{...p.experience[0],current:false,end:'2023'}];
  assert.deepEqual(validate({},schema,p).fills,{});
  p.experience[0].end='Present';
  assert.deepEqual(validate({},schema,p).fills,{});
});

test('second address line and birth date use only saved facts',()=>{
  const p=profile();p.identity.location.street2='Unit 4';p.identity.date_of_birth='1998-05-12';
  const schema=schemaOf({label:'Address line 2'},{label:'Date of birth'});
  assert.deepEqual(validate({},schema,p).fills,{f0:'Unit 4',f1:'1998-05-12'});
  delete p.identity.date_of_birth;
  assert.equal(validate({f1:'1999-01-01'},schema,p).fills.f1,undefined);
});

test('visa eligibility and a requirement for authorization cannot inherit general US eligibility',()=>{
 const p=profile();const s=schemaOf(
  {label:'If you answered yes, are you eligible for a TN, H-1B1, E-3, or F-1 EAD visa?',type:'radio',options:['Yes','No']},
  {label:'Do you require work authorization to work in the United States for this internship?',type:'radio',options:['Yes','No']},
  {label:'Are you authorized to work in the United States?',type:'radio',options:['Yes','No']});
 const result=validate({f0:'Yes',f1:'Yes'},s,p);
 assert.equal(result.fills.f0,undefined);assert.equal(result.fills.f1,undefined);assert.equal(result.fills.f2,'Yes');
 assert.equal(result.review.length,2);
});

test('unknown present sponsorship is not treated as false by a known future false',()=>{
 const p=profile();delete p.work_authorization.requires_sponsorship_now;p.work_authorization.requires_sponsorship_future=false;
 const s=schemaOf({label:'Will you require sponsorship now or in the future?',type:'radio',options:['Yes','No']});
 assert.equal(validate({},s,p).fills.f0,undefined);
 p.work_authorization.requires_sponsorship_now=true;assert.equal(validate({},s,p).fills.f0,'Yes');
});

test('phone-country selectors never inherit the country of residence',()=>{
 const p=profile();p.identity.phone='+44 20 7946 0123';
 const s=schemaOf({label:'country calling code: Spain',type:'combobox',options:['United States','United Kingdom','Spain']},{label:'Which country are you located in?'},{label:'What country do you reside in?'});
 const result=validate({f0:'United States'},s,p);
 assert.equal(result.fills.f0,undefined);assert.equal(result.fills.f1,'United States');assert.equal(result.fills.f2,'United States');
 p.identity.phone_country='United Kingdom';assert.equal(validate({f0:'United States'},s,p).fills.f0,'United Kingdom');
});

test('bare Country code with dialing options uses phone country, never residence',()=>{
 const p=profile();p.identity.location.country='United States';p.identity.phone='+44 20 7946 0123';
 const s=schemaOf({label:'Country code',type:'combobox',required:true,options:['🇬🇧 (+44) United Kingdom','🇺🇸 (+1) United States']});
 assert.equal(validate({f0:'🇺🇸 (+1) United States'},s,p).fills.f0,undefined);
 p.identity.phone_country='United Kingdom';
 assert.equal(validate({},s,p).fills.f0,'🇬🇧 (+44) United Kingdom');
 s.fields[0].options=['United States','United Kingdom'];
 assert.equal(validate({},s,p).fills.f0,'United States');
});

test('dialing country maps complete country identity through flag/code decoration',()=>{
 const p=profile();p.identity.phone_country='United States';
 const s=schemaOf({label:'Country dialing code',type:'combobox',options:['🇨🇦 +1 Canada','🇺🇸 +1 United States of America','🇺🇲 +1 United States Minor Outlying Islands']});
 assert.equal(validate({},s,p).fills.f0,'🇺🇸 +1 United States of America');
 s.fields[0].options=['🇨🇦 +1 Canada','🇺🇲 +1 United States Minor Outlying Islands'];
 assert.equal(validate({},s,p).fills.f0,undefined);
 s.fields[0].options=['🇺🇸 +1 United States of America','+1 US - United States'];
 assert.equal(validate({},s,p).fills.f0,undefined);
 p.identity.phone_country='United Kingdom';s.fields[0].options=['+44 GB - United Kingdom','+1 US - United States'];
 assert.equal(validate({},s,p).fills.f0,'+44 GB - United Kingdom');
 delete p.identity.phone_country;assert.equal(validate({f0:'+1 US - United States'},s,p).fills.f0,undefined);
});

test('contact method is an explicit preference, never inferred from a saved phone',()=>{
 const p=profile(),s=schemaOf({label:'Preferred Contact Method',type:'combobox',required:true,options:['Email','Mobile Phone','Home Phone']});
 assert.equal(validate({f0:'Mobile Phone'},s,p).fills.f0,undefined);
 p.preferences.preferred_contact_method='Email';assert.equal(validate({f0:'Mobile Phone'},s,p).fills.f0,'Email');
 p.preferences.preferred_contact_method='Mobile Phone';assert.equal(validate({},s,p).fills.f0,'Mobile Phone');
 p.preferences.preferred_contact_method='Carrier pigeon';assert.equal(validate({},s,p).fills.f0,undefined);
 delete p.preferences.preferred_contact_method;assert.equal(validate({f0:'Email'},s,p).fills.f0,undefined);
});
