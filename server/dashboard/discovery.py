"""Saved search priorities, public source choices, and explainable queue ordering."""
from datetime import datetime, timezone
import re
from typing import Literal
from urllib.parse import urlsplit
from pydantic import BaseModel, ConfigDict, Field, field_validator
from . import matching, job_constraints


class Priorities(BaseModel):
    model_config = ConfigDict(extra="forbid")
    targetRoles: list[str] = Field(default_factory=list,max_length=30)
    preferredLocations: list[str] = Field(default_factory=list,max_length=30)
    preferredSkills: list[str] = Field(default_factory=list,max_length=30)
    excludedCompanies: list[str] = Field(default_factory=list,max_length=50)
    excludedTitles: list[str] = Field(default_factory=list,max_length=30)
    order: Literal["recommended","newest"] = "recommended"
    seniority: list[Literal['intern','entry','mid','senior','staff','management','executive']] = Field(default_factory=list,max_length=7)
    useProfileSeniority: bool = True
    workCountries: list[str] = Field(default_factory=list,max_length=30)
    workModes: list[Literal['remote','hybrid','onsite']] = Field(default_factory=list,max_length=3)
    hideMismatches: bool = False
    requireListedCountry: bool = False

    @field_validator('workCountries')
    @classmethod
    def countries(cls,values):
        return list(dict.fromkeys(job_constraints.country_code(value) for value in values))

    @field_validator('targetRoles','preferredLocations','preferredSkills','excludedCompanies','excludedTitles')
    @classmethod
    def terms(cls, values):
        if any(not value.strip() or len(value)>120 for value in values):
            raise ValueError("Each search term must contain 1–120 characters")
        return list(dict.fromkeys(value.strip() for value in values))


class Sources(BaseModel):
    model_config = ConfigDict(extra="forbid")
    greenhouse: list[str] = Field(default_factory=list,max_length=50)
    lever: list[str] = Field(default_factory=list,max_length=50)
    ashby: list[str] = Field(default_factory=list,max_length=50)
    smartrecruiters: list[str] = Field(default_factory=list,max_length=30)
    rippling: list[str] = Field(default_factory=list,max_length=30)
    workday: list[str] = Field(default_factory=list,max_length=5)
    github: bool = False
    feeds: list[Literal["Remotive","Arbeitnow"]] = Field(default_factory=lambda:['Remotive','Arbeitnow'])

    @field_validator('workday')
    @classmethod
    def workday_urls(cls, values):
        result=[]
        for value in values:
            url=urlsplit(value.strip())
            parts=url.path.strip('/').split('/')
            if re.fullmatch(r'[a-z]{2}-[A-Z]{2}',parts[0]): parts=parts[1:]
            if (url.scheme!='https' or not re.fullmatch(r'[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com',url.netloc,re.I)
                    or url.query or url.fragment or len(parts)!=1 or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',parts[0])):
                raise ValueError('Use a Workday careers board URL, without a job path or query')
            result.append(f'https://{url.netloc.lower()}/en-US/{parts[0]}')
        return list(dict.fromkeys(result))

    @field_validator('greenhouse','lever','ashby','smartrecruiters','rippling')
    @classmethod
    def board_ids(cls, values):
        if any(not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',value.strip()) for value in values):
            raise ValueError("Enter board IDs, not URLs (letters, numbers, underscores and hyphens)")
        return list(dict.fromkeys(value.strip() for value in values))


class Settings(BaseModel):
    priorities: Priorities
    sources: Sources


def phrase(text, term):
    return bool(re.search(r'(?<!\w)'+re.escape(term)+r'(?!\w)',text,re.I))


def role_matches(title, role):
    words = re.findall(r'[\w+#]+',role)
    # Engineering/development are common title variants, while a management
    # title is a different function unless the candidate actually targets it.
    leadership=r'\b(manager|director|head|vp|president|chief)\b'
    if re.search(leadership,title,re.I) and not re.search(leadership,role,re.I): return False
    def present(word):
        variants=['engineer','engineering','developer','development'] if word.casefold() in {'engineer','engineering','developer','development'} else [word]
        return any(phrase(title,variant) for variant in variants)
    return bool(words) and all(present(word) for word in words)


def timestamp(value):
    try:
        parsed=datetime.fromisoformat(str(value).replace('Z','+00:00'))
        return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).timestamp()
    except (ValueError,TypeError):
        return 0


def rank(jobs, profile, resume_text, preferences=None):
    preferences=Priorities.model_validate(preferences or {})
    explicit_roles=bool(preferences.targetRoles)
    role_targets=preferences.targetRoles or list(dict.fromkeys(
        re.sub(r'\b(senior|junior|staff|principal|lead|intern|internship)\b','',item.get('title',''),flags=re.I).strip(' -–,')
        for item in profile.get('experience',[]) if isinstance(item,dict) and isinstance(item.get('title'),str)))
    role_targets=[role for role in role_targets if role.strip()]
    ranked=[]
    for original in jobs:
        job=dict(original)
        title=job.get('title',''); company=job.get('company','')
        if any(company.casefold()==v.casefold() for v in preferences.excludedCompanies): continue
        if any(phrase(title,v) for v in preferences.excludedTitles): continue
        constraints=job_constraints.assess(job,preferences,profile)
        if preferences.requireListedCountry and preferences.workCountries and not set(constraints['countries']).intersection(preferences.workCountries): continue
        mismatches=[check for check in constraints['checks'] if check['status']=='mismatch']
        if preferences.hideMismatches and any(check['explicit'] for check in mismatches): continue
        description=job.get('description') or job.get('raw',{}).get('description','')
        fit=matching.fit(description,profile,resume_text)
        locations=', '.join(job.get('locations') or [])
        roles=[v for v in role_targets if role_matches(title,v)]
        places=[v for v in preferences.preferredLocations if phrase(locations,v)]
        aliases={key.casefold():value for key,value in matching.CATALOG.items()}
        skills=[v for v in preferences.preferredSkills if matching.occurrence(matching.plain(description),aliases.get(v.casefold(),[v]))]
        # User priorities dominate skill mentions; the score is only a sorting
        # rule, not a probability or a claim that optional skills are required.
        points=(40 if roles else 0)+(20 if places else 0)
        points+=20*len(skills)/len(preferences.preferredSkills) if preferences.preferredSkills else 0
        points+=0.2*fit['coverage'] if fit['coverage'] is not None else 0
        points-=30*len(mismatches)
        reasons=[]
        if roles: reasons.append(('Role preference: ' if explicit_roles else 'Similar to a saved role: ')+', '.join(roles))
        if places: reasons.append('Location preference: '+', '.join(places))
        if skills: reasons.append('Preferred skills mentioned: '+', '.join(skills))
        if fit['recognized']: reasons.append(f"Profile evidence for {len(fit['matched'])} of {fit['recognized']} recognized skill mentions")
        unknown=[]
        if not description: unknown.append('No description supplied by this source')
        elif not fit['recognized']: unknown.append('No recognized skill evidence to compare')
        if not locations: unknown.append('Location not supplied')
        weights={'role':25 if role_targets else 0,'location':10 if preferences.preferredLocations else 0,'preferredSkills':5 if preferences.preferredSkills else 0,'skillCoverage':60}
        maximum=sum(weights.values())
        match_points=(weights['role'] if roles else 0)+(weights['location'] if places else 0)
        match_points+=weights['preferredSkills']*len(skills)/len(preferences.preferredSkills) if preferences.preferredSkills else 0
        match_points+=0.6*(fit['coverage'] or 0)
        match_points-=30*len(mismatches)
        score=round(max(0,min(100,100*match_points/maximum))) if fit['recognized']>=3 else None
        job['match']={'score':score,'label':'Strong match' if score is not None and score>=80 else 'Good match' if score is not None and score>=60 else 'Partial match' if score is not None else 'Limited evidence',
            'basis':'Profile skill evidence and saved search preferences. Not a hiring probability or an ATS score. At least three recognized skills are needed for a score.',
            'skillCoverage':fit['coverage'],'recognizedSkills':fit['recognized'],'points':round(match_points,2),
            'weights':weights,'maximumPoints':maximum,'constraintPenalty':30*len(mismatches)}
        job['fit']=fit
        job['recommendation']={'points':round(points,2),'reasons':reasons,'unknown':unknown,
            'constraints':constraints,
            'unmatchedRoles':[] if roles else role_targets,
            'unmatchedLocations':[] if places else preferences.preferredLocations,
            'explanation':'Preference ordering, not an ATS score. Role +40 (saved career titles when no target roles are set), location +20, preferred skill mentions up to +20, profile skill coverage up to +20. Each stated constraint mismatch subtracts 30; unknowns do not. Posting date breaks ties. Work authorization and mandatory requirements still need review.'}
        ranked.append(job)
    ranked.sort(key=lambda j:(-(j['recommendation']['points'] if preferences.order=='recommended' else 0),-timestamp(j.get('posted')),j.get('url','')))
    return ranked


def recent(jobs, days):
    if not days: return jobs
    cutoff=datetime.now(timezone.utc).timestamp()-days*86400
    return [job for job in jobs if timestamp(job.get('posted'))>=cutoff]
