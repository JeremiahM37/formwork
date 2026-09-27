"""Posting preference checks. These never determine immigration/work authorization."""
import re
import pycountry
from .matching import plain

ALIASES={'uk':'GB','u.k.':'GB','usa':'US','u.s.':'US','u.s.a.':'US','united states of america':'US',
         'south korea':'KR','north korea':'KP','russia':'RU','vietnam':'VN','taiwan':'TW',
         'democratic republic of congo':'CD','democratic republic of the congo':'CD'}


def country_code(value):
    value=str(value).strip()
    if value.casefold() in ALIASES: return ALIASES[value.casefold()]
    try: return pycountry.countries.lookup(value).alpha_2
    except LookupError: raise ValueError(f'Unknown country: {value}. Use its country name or ISO code.')


NAMES={}
for country in pycountry.countries:
    for field in ('name','official_name','common_name'):
        name=getattr(country,field,None)
        if name and name not in {'Georgia','Congo'}: NAMES[name.casefold()]=country.alpha_2
NAMES.update({k:v for k,v in ALIASES.items() if len(k)>4})
COUNTRY_NAMES=re.compile(r'(?<!\w)('+ '|'.join(re.escape(k) for k in sorted(NAMES,key=len,reverse=True))+r')(?!\w)',re.I)


def mentioned_countries(text):
    found={NAMES[m.group().casefold()] for m in COUNTRY_NAMES.finditer(text)}
    # Short country codes are often ordinary words (IN, IT, AS…). Do not scan
    # arbitrary prose for all ISO codes. US/UK aliases are common location tags.
    for pattern,code in [(r'(?<!\w)(?:US|USA|U\.S\.?)(?!\w)','US'),(r'(?<!\w)(?:UK|U\.K\.?)(?!\w)','GB')]:
        if re.search(pattern,text): found.add(code)
    return found


def seniority(title):
    patterns=[('executive',r'\b(chief|vice president|vp|president)\b'),
              ('management',r'\b(manager|director|head of)\b'),
              ('staff',r'\b(staff|principal|distinguished)\b'),
              ('intern',r'\b(intern|internship|working student|apprentice)\b'),
              ('entry',r'\b(junior|jr|entry.level|new grad|graduate)\b'),
              ('mid',r'\b(mid.level|intermediate)\b'),
              ('senior',r'\b(senior|sr)\b')]
    for level,pattern in patterns:
        if level=='staff' and not re.search(r'engineer|developer|scientist|architect|designer',title,re.I): continue
        if re.search(pattern,title,re.I): return level
    return None


def profile_levels(profile):
    titles=[item.get('title','') for item in profile.get('experience',[]) if isinstance(item,dict)]
    levels=[seniority(title) for title in titles if isinstance(title,str)]
    # Unlevelled professional roles make an automatic stage conclusion unsafe.
    if not levels or None in levels: return []
    order=['intern','entry','mid','senior','staff','management','executive']
    highest=max(levels,key=order.index)
    return ['intern','entry'] if highest in {'intern','entry'} else [highest]


def assess(job, preferences, profile):
    raw=job.get('raw',{})
    value=lambda key,default=None:job.get(key,raw.get(key,default))
    locations='; '.join(job.get('locations') or [])
    countries=set()
    unresolved_region=False
    for item in value('countries',[]) or []:
        try: countries.add(country_code(item))
        except ValueError: unresolved_region=True
    countries.update(mentioned_countries(locations))
    if re.search(r'\b(Europe|European Union|EMEA|APAC|Asia|Americas|Latin America|EU)\b',locations,re.I): unresolved_region=True
    workplace=str(value('workplaceType','') or '').casefold().replace('-','')
    mode={'remote':'remote','hybrid':'hybrid','onsite':'onsite'}.get(workplace)
    if not mode:
        if re.search(r'\bhybrid\b',locations,re.I): mode='hybrid'
        elif re.search(r'\bremote\b',locations,re.I): mode='remote'
        elif re.search(r'\bon[ -]?site\b',locations,re.I): mode='onsite'
    description=plain(value('description',''))
    restrictions=[]
    for match in re.finditer(r'\b(?:must (?:be (?:based|located)|reside|live)|only (?:hiring|considering) (?:candidates|applicants)(?: based| located)?|candidates must be based) in\s+([^\n;!?]{1,160})',description,re.I):
        clause=re.split(r'\.\s+|\s+(?:and|but)\s+(?:work|serve|support|report|travel|join)\b',match.group(1),maxsplit=1,flags=re.I)[0]
        named=mentioned_countries(clause)
        restrictions.append((named,match.group(0)[:match.start(1)-match.start()]+clause))
    # Only targeted residency clauses are inspected; company-office mentions
    # elsewhere in a posting are not country restrictions on this job.
    if restrictions:
        countries=set.union(*(item[0] for item in restrictions))
        unresolved_region=any(not item[0] or re.search(r'\b(Europe|European Union|EMEA|APAC|Asia|Americas|EU)\b',item[1],re.I) for item in restrictions)
    worldwide=bool(re.search(r'\b(worldwide|global|anywhere in the world|work from anywhere)\b',locations,re.I)) and not restrictions
    checks=[]
    selected=preferences.seniority or (profile_levels(profile) if preferences.useProfileSeniority else [])
    level=seniority(job.get('title',''))
    if not level and str(value('employmentType','')).casefold() in {'intern','internship'}: level='intern'
    if selected:
        basis='selected levels' if preferences.seniority else 'saved career titles'
        state='unknown' if not level else 'match' if level in selected else 'mismatch'
        checks.append({'kind':'seniority','status':state,'message':f"Title level: {level or 'not stated'}; comparing with {', '.join(selected)} ({basis})",
                       'explicit':bool(preferences.seniority)})
    if preferences.workCountries:
        state='match' if worldwide or countries.intersection(preferences.workCountries) else 'mismatch' if countries and not unresolved_region else 'unknown'
        evidence='; '.join(item[1] for item in restrictions) if restrictions else locations or 'No country supplied'
        scope='worldwide' if worldwide else ', '.join(sorted(countries)) or 'unknown'
        if unresolved_region: scope+=' (regional scope needs review)'
        checks.append({'kind':'country','status':state,'message':f"Listed work countries: {scope}. Requested: {', '.join(preferences.workCountries)}. {evidence}",'explicit':True})
    if preferences.workModes:
        state='unknown' if not mode else 'match' if mode in preferences.workModes else 'mismatch'
        checks.append({'kind':'work mode','status':state,'message':f"Work mode: {mode or 'not stated'}; requested {', '.join(preferences.workModes)}",'explicit':True})
    return {'checks':checks,'countries':sorted(countries),'workMode':mode,'seniority':level,
            'worldwide':worldwide,'note':'These compare posting statements with search preferences, not work authorization. Unknowns remain visible; country matches may still have state, timezone or residency restrictions.'}
