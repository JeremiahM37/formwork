#!/usr/bin/env python3
"""Synthetic drafting/revision quality probes using the configured dashboard model.

Calls the model, never the browser; no real candidate profile is loaded. Report
criteria are limited mechanical checks plus prose for human review, not a hiring
score or a claim that every factual assertion has been verified.
"""
import argparse
import asyncio
import json
import sys
import time
import subprocess
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from dashboard import humanize, resume

CASES = [
    {'id':'platform','company':'Example Infrastructure','role':'Platform Engineer',
     'posting':'Build Python services backed by PostgreSQL. Maintain reliable APIs and improve latency. Work with a small infrastructure team.',
     'facts':'At Fixture Company I built a small Python service to organize sample records. I simplified a recurring preparation task and maintained the service.',
     'voice':'I like following a slow request through the system until I can explain it. I write down what I changed so the next person does not have to guess.'},
    {'id':'operations','company':'Example Support','role':'Support Operations Lead',
     'posting':'Lead the support team, improve response times and coach colleagues. Review weekly ticket trends and document common solutions.',
     'facts':'At Cedar Help I supervised 16 support staff. The team handled 180 tickets per day. I introduced weekly coaching and reduced average response time by 40%.',
     'voice':'I like giving people a clear answer and enough context to act on it. My best weeks are the ones when a teammate solves something without needing me.'},
    {'id':'graduate','company':'Example Analytics','role':'Junior Data Analyst',
     'posting':'Analyze customer data using SQL and Python. Explain results clearly and check data quality. This is an entry-level role.',
     'facts':'I completed a B.S. in Statistics at Example University in 2026. In a course project I analyzed 12000 synthetic records with SQL and Python, and identified 430 duplicate records. I have no professional data analyst experience.',
     'voice':'I enjoy checking a result a second way before sharing it. I want to learn from people who can explain why a useful analysis sometimes starts with a smaller question.'},
]


async def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report',type=Path,required=True)
    parser.add_argument('--resume',action='store_true',help='Keep successful phases from this report and retry errors only')
    args=parser.parse_args()
    report={'scope':'Three synthetic career profiles, one initial draft and one revision each, through the configured model. Small diagnostic sample, not an independent or competitor-quality benchmark. Unsupported/lost checks cover recognizable tokens and numbers, not all semantic claims.', 'cases':[]}
    existing=json.loads(args.report.read_text()) if args.resume and args.report.exists() else {'cases':[]}
    for case in CASES:
        old=next((r for r in existing['cases'] if r['case']==case),{'drafts':[]})
        row={'case':case,'drafts':[]}
        previous=None
        for phase in ['initial','revision']:
            saved=next((d for d in old['drafts'] if d['phase']==phase and 'error' not in d),None)
            if saved:
                row['drafts'].append(saved);previous=saved['text'];continue
            started=time.monotonic()
            try:
                instruction=''
                if previous:
                    instruction=subprocess.check_output(['node','-e',"const h=require('./extension/src/lib/humanize.js');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(h.instruction(JSON.parse(s))));"],
                        input=json.dumps(humanize.report(previous)),text=True,cwd=Path(__file__).resolve().parents[1])
                result=await resume.cover_letter(case['posting'],case['company'],case['role'],case['facts'],case['voice'],
                    revision={'previous':previous,'instruction':instruction+' Preserve every numeric result and named tool already present.'} if previous else None,
                    identity={'full_name':'Fixture Candidate','email':'fixture@example.test'})
                text=result['text']; previous=text
                row['drafts'].append({'phase':phase,'seconds':round(time.monotonic()-started,2),**result,
                    'checks':{'nonempty':bool(text),'under250words':len(text.split())<=250,'approvalRequired':result['needsApproval'],
                        'noFlaggedUnsupportedClaims':not result['unsupported'],'noFlaggedLostClaims':not result['lost'],
                        'noContactLeak':'fixture@example.test' not in text and 'Fixture Candidate' not in text},'words':len(text.split())})
                print(case['id'],phase,row['drafts'][-1]['checks'],flush=True)
            except Exception as err:
                row['drafts'].append({'phase':phase,'error':str(err),'seconds':round(time.monotonic()-started,2)})
                print(case['id'],phase,'ERROR',str(err),flush=True)
        report['cases'].append(row)
        args.report.write_text(json.dumps(report,indent=2)+'\n')
    passed=all('checks' in d and all(d['checks'].values()) for c in report['cases'] for d in c['drafts'])
    print('Mechanical writing checks:', 'PASS' if passed else 'REVIEW REQUIRED',flush=True)
    return 0 if passed else 1


if __name__=='__main__': raise SystemExit(asyncio.run(main()))
