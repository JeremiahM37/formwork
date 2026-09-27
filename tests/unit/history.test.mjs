import test from 'node:test';import assert from 'node:assert/strict';import {lib,profile,schemaOf} from '../helpers/load.mjs';
const {formatDate,answer}=lib('history'),{validate}=lib('validate'),{isEssayField}=lib('draft');
const field=(kind,index,key,more={})=>({id:'f0',type:'text',label:key,history:{kind,index,key,existing:{}},...more});
test('history dates preserve known precision and refuse invented month/day',()=>{
 assert.equal(formatDate('August 2018',{dateFormat:'MM/YYYY'}),'08/2018');
 assert.equal(formatDate('2022-05',{type:'month'}),'2022-05');
 assert.equal(formatDate('2022',{dateFormat:'MM/YYYY'}),null);
 assert.equal(formatDate('May 2022',{type:'date'}),null);
 assert.equal(formatDate('2024-02-29',{type:'date'}),'2024-02-29');
 assert.equal(formatDate('2023-02-29',{type:'date'}),null);
 assert.equal(formatDate('2022-13',{type:'month'}),null);
});
test('each history row is pinned to its actual record, not the first school or employer',()=>{
 const p=profile();p.education.push({school:'Second University',degree:'M.S.',field_of_study:'Robotics',start:'September 2023',end:'May 2025'});
 p.experience.push({employer:'Earlier Lab',title:'Intern',start:'May 2021',end:'August 2021',bullets:['Built 45 tests.']});
 for(const [f,want] of [[field('education',1,'school'),'Second University'],[field('education',1,'start',{dateFormat:'MM/YYYY'}),'09/2023'],[field('experience',1,'employer'),'Earlier Lab'],[field('experience',1,'summary',{type:'textarea'}),'Built 45 tests.']]){
  const result=validate({f0:'invented by model'},schemaOf(f),p);
  assert.equal(result.fills.f0,want);
 }
 assert.equal(isEssayField(field('experience',1,'summary',{type:'textarea'})),false);
 assert.equal(isEssayField({type:'textarea',label:'Summary'}),true);
});
test('existing record identity overrides order; unmatched or ambiguous entries cannot borrow another history',()=>{
 const p=profile();p.experience.push({employer:'Earlier Lab',title:'Intern'});
 const f=field('experience',0,'employer');f.history.existing={employer:'Earlier Lab',title:'Intern'};
 assert.equal(answer(f,p).value,'Earlier Lab');
 f.history.existing={employer:'Someone else'};assert.equal(answer(f,p).value,null);
 p.experience.push({employer:'Earlier Lab',title:'Intern'});f.history.existing={employer:'Earlier Lab'};assert.equal(answer(f,p).value,null);
 assert.equal(answer(field('experience',99,'title'),p).value,null);
});

test('current employment is a saved boolean, never a model choice or an email opt-in',()=>{
 const p=profile();p.experience[0].current=true;
 const f=field('experience',0,'current',{type:'checkbox',label:'I currently work here'});
 assert.equal(validate({f0:'false'},schemaOf(f),p).fills.f0,'true');
 p.experience[0].current=false;assert.equal(validate({f0:'true'},schemaOf(f),p).fills.f0,'false');
});
test('US work authorization does not answer EU or unspecified-country eligibility',()=>{
 const p=profile();p.work_authorization.authorized_to_work_us=true;
 for(const label of ['Are you authorized to work in the EU?','Are you legally authorized to work in Germany?','Are you authorized to work in this country?']){
  const f={id:'f0',type:'radio',label,required:true,options:['Yes','No']};
  const result=validate({f0:'Yes'},schemaOf(f),p);assert.equal(result.fills.f0,undefined,label);assert.ok(result.review.length,label);
 }
 const f={id:'f0',type:'radio',label:'Are you authorized to work in the United States?',options:['Yes','No']};
 assert.equal(validate({f0:'No'},schemaOf(f),p).fills.f0,'Yes');
});

test('clearance and employment attestations need the corresponding facts, not plausible model answers',()=>{
 const p=profile();
 for(const label of ['Do you currently hold an active security clearance?','Have you ever held a clearance in the past?','Do you have the ability to obtain a Secret Clearance? Requirements include US Citizenship, security investigation, etc.','Affirmation: I have not entered into any non-competition, non-solicitation or confidentiality agreement limiting my ability to work:','Would you be able and willing to travel as needed by the job?','May we contact?','Are you able to perform the essential functions of the job?']){
  const f={id:'f0',type:'radio',label,required:true,options:['Yes','No']};
  assert.equal(validate({f0:'Yes'},schemaOf(f),p).fills.f0,undefined,label);
 }
 p.compliance.clearance={currently_held:false,eligible:true};
 assert.equal(validate({f0:'Yes'},schemaOf({id:'f0',type:'radio',label:'Do you currently hold an active security clearance?',options:['Yes','No']}),p).fills.f0,'No');
});

test('role description copies every resume bullet exactly and never becomes an essay',()=>{
 const p=profile();p.experience=[{bullets:['First.','Second.','Third.','Fourth.','Fifth.']}];
 const f={id:'f0',type:'textarea',label:'Role Description'};
 assert.equal(isEssayField(f),false);
 assert.equal(validate({f0:'Generated summary'},schemaOf(f),p).fills.f0,p.experience[0].bullets.join('\n'));
 p.experience.push({bullets:['Different job.']});assert.equal(validate({f0:'Invented'},schemaOf(f),p).fills.f0,undefined);
});

test('skill picker takes at most five saved skills prioritized by this job, preserving C variants',()=>{
 const p=profile();p.skills={languages:['Java','C#','Python','C','C++'],tools:['Docker','Linux','Kubernetes']};
 const f={id:'f0',type:'combobox',label:'Type to Add Skills',skillPicker:true};
 const schema={...schemaOf(f),title:'C++ Software Developer',description:'Develop on Linux with Python, Docker and Kubernetes.'};
 const result=validate({f0:['Invented qualification']},schema,p);
 assert.deepEqual(result.fills.f0,['C++','Python','Docker','Linux','Kubernetes']);
});
