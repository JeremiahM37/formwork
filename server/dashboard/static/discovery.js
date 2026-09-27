"use strict";

async function renderDiscoverySettings() {
  const config=await api('/api/discovery');
  const holder=$('discoverySettings');holder.replaceChildren();
  const fields=[['targetRoles','Target roles'],['preferredLocations','Preferred locations'],
    ['preferredSkills','Preferred skills'],['excludedCompanies','Exclude companies (exact names)'],['excludedTitles','Exclude title phrases']]
    .map(([key,label])=>({key,...workspaceField(label,'textarea',(config.priorities[key] || []).join('\n'))}));
  const order=el('select',{ariaLabel:'Job ordering'},...['recommended','newest'].map(value=>el('option',{
    value,textContent:value==='recommended'?'My preferences and profile':'Newest first',selected:config.priorities.order===value})));
  const boards=['greenhouse','lever','ashby','smartrecruiters','rippling'].map(key=>({key,...workspaceField(`${key} board IDs`,'textarea',(config.sources[key] || []).join('\n'))}));
  const workday=workspaceField('Workday careers board URLs','textarea',(config.sources.workday || []).join('\n'));
  const github=workspaceField('Include community job lists','checkbox');github.input.checked=config.sources.github;
  const feeds=['Remotive','Arbeitnow'].map(name=>{
    const field=workspaceField(`Include ${name}`,'checkbox');field.input.checked=config.sources.feeds.includes(name);return {name,...field};});
  const status=el('p',{role:'status',id:'discoverySaveStatus',className:'small muted'});
  const lines=input=>input.value.split('\n').map(s=>s.trim()).filter(Boolean);
  const countries=workspaceField('Countries to work from (names or ISO codes)','textarea',(config.priorities.workCountries || []).join('\n'));
  const strict=workspaceField('Only show jobs explicitly listing a selected country','checkbox');strict.input.checked=Boolean(config.priorities.requireListedCountry);
  const levels=['intern','entry','mid','senior','staff','management','executive'].map(value=>{
    const field=workspaceField(`Target level: ${value}`,'checkbox');field.input.checked=(config.priorities.seniority || []).includes(value);return {value,...field};});
  const modes=['remote','hybrid','onsite'].map(value=>{
    const field=workspaceField(`Work mode: ${value}`,'checkbox');field.input.checked=(config.priorities.workModes || []).includes(value);return {value,...field};});
  const automatic=workspaceField('Use saved career titles when no levels are selected','checkbox');automatic.input.checked=config.priorities.useProfileSeniority !== false;
  const hide=workspaceField('Hide stated mismatches with my selected constraints','checkbox');hide.input.checked=Boolean(config.priorities.hideMismatches);
  holder.append(el('h2',{textContent:'Your job search'}),
    el('p',{className:'small muted',textContent:'One phrase per line. Role, location and skill preferences change ordering; exclusions remove results. Without target roles, your saved career titles guide ordering. Explicit target roles replace that default and the older title-pattern filter below. Remote locations can still have country restrictions: review each posting.'}),
    ...fields.map(f=>f.node),el('label',{className:'field'},el('span',{textContent:'Job ordering'}),order),
    el('details',{},el('summary',{textContent:'Seniority and work location'}),
      el('p',{className:'small muted',textContent:'Select any acceptable levels or modes; leaving them blank imposes no explicit constraint. Saved titles can supply a seniority signal without excluding jobs. Unknown locations/levels stay visible, even when hiding mismatches. Countries are search preferences, not a statement of work authorization.'}),
      ...levels.map(f=>f.node),automatic.node,countries.node,strict.node,...modes.map(f=>f.node),hide.node),
    el('details',{},el('summary',{textContent:'Choose public job sources'}),
      el('p',{className:'small muted',textContent:'Add company board IDs from their public careers URL, such as “stripe” from boards.greenhouse.io/stripe. These use public board APIs; no account login or paid API key is required.'}),
      ...boards.map(f=>f.node),workday.node,
      el('p',{className:'small muted',textContent:'For Workday, paste the careers board URL, for example https://example.wd5.myworkdayjobs.com/en-US/ExampleCareerSite. Up to five boards. Large or unavailable boards may return partial results, shown in source health.'}),github.node,...feeds.map(f=>f.node)),
    workspaceButton('Save job search',async()=>{
      const priorities={...Object.fromEntries(fields.map(f=>[f.key,lines(f.input)])),order:order.value,
        seniority:levels.filter(f=>f.input.checked).map(f=>f.value),useProfileSeniority:automatic.input.checked,
        requireListedCountry:strict.input.checked,workCountries:lines(countries.input),workModes:modes.filter(f=>f.input.checked).map(f=>f.value),hideMismatches:hide.input.checked};
      const sources={...Object.fromEntries(boards.map(f=>[f.key,lines(f.input)])),workday:lines(workday.input),github:github.input.checked,feeds:feeds.filter(f=>f.input.checked).map(f=>f.name)};
      await api('/api/discovery',{method:'POST',body:{priorities,sources}});
      status.replaceChildren(document.createTextNode('Search saved. Refresh jobs to apply preferences to the full source set. '),
        el('a',{href:'#queue',textContent:'Go to Find jobs'}));
    }),status);
}

function recommendationDetails(job) {
  const value=job.recommendation;
  if (!value) return null;
  const notes=[...value.reasons,...value.unknown];
  for (const check of value.constraints?.checks || []) notes.push(`${check.status === 'mismatch' ? 'Preference mismatch' : check.status === 'unknown' ? 'Needs review' : 'Preference match'}: ${check.message}`);
  if (value.constraints?.checks?.length) notes.push(value.constraints.note);
  if (value.unmatchedRoles.length) notes.push('No target or saved role phrase matched this title');
  if (value.unmatchedLocations.length) notes.push('No preferred location matched the listed locations');
  return el('details',{className:'small'},el('summary',{textContent:'Why this job is here'}),
    ...notes.map(text=>el('p',{textContent:text})),el('p',{className:'muted',textContent:value.explanation}));
}
