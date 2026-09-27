#!/usr/bin/env python3
"""Run synthetic factual-review calibration through the configured model."""
import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'server'))
from dashboard import resume


async def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,default=ROOT/'tests/fixtures/factual-review.json')
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    report={'scope':'Maintainer-authored calibration cases, not an independent benchmark or proof of factual accuracy. Calls the configured model; no browser or real candidate profile.','results':[]}
    for case in json.loads(args.input.read_text()):
        start=time.monotonic()
        review=await resume.review_facts(case['draft'],case['facts'],case['posting'])
        result={**case,'review':review,'seconds':round(time.monotonic()-start,2),
                'passed':review['status']=='checked' and bool(review['concerns'])==case['expectedConcern']}
        report['results'].append(result)
        args.report.write_text(json.dumps(report,indent=2)+'\n')
        print(case['case'], 'PASS' if result['passed'] else 'FAIL',flush=True)
    return 0 if all(c['passed'] for c in report['results']) else 1


if __name__=='__main__':raise SystemExit(asyncio.run(main()))
