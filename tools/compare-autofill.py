#!/usr/bin/env python3
"""Compare deterministic decisions, not browser writes or model-assisted accuracy.

Run with the dashboard Python environment and an unmodified CareerPulse checkout.
Neither implementation is copied or patched. No network, real profile or live ATS.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PIN = '629aa992f3e3c3d05575686f350a7173e8b5e108'


def cases(profile):
    i, links = profile['identity'], profile['links']
    entries = [
        ('First name',i['first_name']), ('Given name',i['first_name']),
        ('Last name',i['last_name']), ('Family name',i['last_name']),
        ('Full name',i['full_name']), ('Your name',i['full_name']),
        ('Middle name','Elena'), ('Preferred name','Dani'),
        ('Email',i['email']), ('Email address',i['email']),
        ('Phone',i['phone']), ('Mobile number',i['phone']),
        ('Country phone code','United States (+1)'), ('Phone type','Mobile'),
        ('Street address',i['location']['street']), ('Address line 2','Unit 4'),
        ('City',i['location']['city']), ('State','NC'), ('Postal code','28801'),
        ('Country','United States'), ('LinkedIn URL',links['linkedin']), ('GitHub URL',links['github']),
        ('Website','https://dana.example.test'),
        ('Are you authorized to work in the United States?','Yes'),
        ('Will you require visa sponsorship?','No'), ('Desired salary','95000'),
        ('How did you hear about this job?','LinkedIn'), ('Date of birth','1998-05-12'),
        ('School or university','Blue Ridge State University'), ('Degree','B.S.'),
        ('Field of study','Computer Science'), ('GPA','3.2'),
        ('Current employer','Fixture Company'), ('Current job title','Software Engineer'),
        ('Gender','Decline To Self Identify'), ('Veteran status','I am not a protected veteran'),
        ("Reference's email",None), ('Emergency contact phone',None),
        ('Manager name',None), ('What is your favorite book?',None),
    ]
    result = []
    for index,(label,expected) in enumerate(entries):
        field = {'id':f'f{index}', 'selector':f'#f{index}', 'label':label, 'type':'text', 'tag':'input'}
        if label == 'State': field.update(type='select',tag='select',options=['NC','SC'])
        if label == 'Country phone code': field.update(type='select',tag='select',options=['United States (+1)','United Kingdom (+44)'])
        if label.startswith(('Are you authorized','Will you require')): field.update(type='select',tag='select',options=['Yes','No'])
        result.append({'field':field,'expected':expected})
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--careerpulse',type=Path,required=True)
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    commit=subprocess.check_output(['git','-C',str(args.careerpulse),'rev-parse','HEAD'],text=True).strip()
    source=args.careerpulse/'app/routers/autofill.py'
    if commit != PIN or subprocess.check_output(['git','-C',str(args.careerpulse),'status','--porcelain','--','app/routers/autofill.py'],text=True).strip():
        raise SystemExit(f'Use unmodified CareerPulse {PIN}')
    spec=importlib.util.spec_from_file_location('comparison_careerpulse',source)
    upstream=importlib.util.module_from_spec(spec);spec.loader.exec_module(upstream)
    profile=json.loads((ROOT/'tests/fixtures/profile.example.json').read_text())
    profile['identity'].update(middle_name='Elena',preferred_name='Dani',date_of_birth='1998-05-12',phone_country_code='+1')
    profile['identity']['location'].update(street2='Unit 4',postal_code='28801')
    profile['preferences']['desired_salary']=95000
    profile['links']['website']='https://dana.example.test'
    cp={'full_name':profile['identity']['full_name'],'middle_name':'Elena','preferred_name':'Dani',
        'email':profile['identity']['email'],'phone':profile['identity']['phone'],'phone_type':'Mobile','phone_country_code':'+1',
        'address_street1':profile['identity']['location']['street'],'address_street2':'Unit 4',
        'address_city':'Asheville','address_state':'North Carolina','address_zip':'28801','address_country_name':'United States',
        'linkedin_url':profile['links']['linkedin'],'github_url':profile['links']['github'],'website_url':profile['links']['website'],
        'authorized_to_work_us':'Yes','requires_sponsorship':'No','desired_salary_min':95000,
        'how_heard_default':'LinkedIn','date_of_birth':'1998-05-12',
        'experience':profile['experience'],'education':profile['education'],'skills':profile['skills'],
        **profile['demographics']}
    suite=cases(profile)
    partial=copy.deepcopy(profile)
    for key in ['middle_name','preferred_name','date_of_birth','phone','phone_country_code']:
        partial['identity'].pop(key,None)
    partial['identity']['location']={}
    partial['preferences']={}
    partial['work_authorization']={}
    partial_cp={k:v for k,v in cp.items() if k not in {'middle_name','preferred_name','date_of_birth','phone','phone_country_code','authorized_to_work_us','requires_sponsorship','desired_salary_min','how_heard_default'} and not k.startswith('address_')}
    unknown_labels={'Middle name','Preferred name','Date of birth','Phone','Mobile number','Country phone code','Street address','Address line 2','City','State','Postal code','Country','Desired salary','How did you hear about this job?','Are you authorized to work in the United States?','Will you require visa sponsorship?'}
    unknown=[dict(case,expected=None) for case in suite if case['field']['label'] in unknown_labels]
    report={'scope':'Deterministic field decisions only; no model, DOM scraping, widget writes, attachments, speed or hiring outcomes. Synthetic cases chosen by the Formwork maintainer, not an independent or representative ATS benchmark.',
        'careerpulse_commit':commit,'careerpulse_source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),
        'formwork_validator_sha256':hashlib.sha256((ROOT/'extension/src/lib/validate.js').read_bytes()).hexdigest(),
        'harness_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'results':[]}
    runner="const v=require('./extension/src/lib/validate.js');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const d=JSON.parse(input);process.stdout.write(JSON.stringify(v.validate({}, {fields:d.fields,company:'Example'}, d.profile).fills));});"
    for name,fw_profile,cp_profile,items in [('complete',profile,cp,suite),('partial',partial,partial_cp,unknown)]:
        fields=[c['field'] for c in items]
        fw=json.loads(subprocess.check_output(['node','-e',runner],input=json.dumps({'profile':fw_profile,'fields':fields}),text=True,cwd=ROOT))
        mappings,_=upstream._deterministic_fill(copy.deepcopy(fields),cp_profile)
        cp_values={m['selector'].lstrip('#'):m['value'] for m in mappings if m['action']!='skip'}
        for item in items:
            row={'profile':name,'label':item['field']['label'],'expected':item['expected']}
            for product,values in [('formwork',fw),('careerpulse',cp_values)]:
                actual=values.get(item['field']['id'])
                if actual=='': actual=None
                row[product]={'actual':actual,'outcome': 'correct_abstention' if actual is None and item['expected'] is None else 'correct_answer' if actual==item['expected'] else 'unanswered' if actual is None else 'wrong_answer'}
            report['results'].append(row)
    report['totals']={product:{outcome:sum(row[product]['outcome']==outcome for row in report['results']) for outcome in ['correct_answer','correct_abstention','unanswered','wrong_answer']} for product in ['formwork','careerpulse']}
    args.report.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report['totals'],indent=2))


if __name__=='__main__': main()
