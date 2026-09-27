/** Public employer boards; API shapes cross-checked against JobNavigator.
 * No account sessions or generic URL fetching. Keep distinct requisitions and
 * all stated locations, even when an employer repeats a UUID for each location.
 */
import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';

const slug = value => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid public board ID');
  return value;
};
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const text = value => typeof value === 'string' ? value : '';
const location = value => typeof value === 'string' ? value : value?.label || value?.city || '';
function safeURL(value) {try {const u=new URL(value);return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : '';} catch {return '';}}

export async function fetchPublicATS(ats, company, {health=[],cacheDir,fetcher=fetch,maxPages=20}={}) {
  slug(company);
  if (!['smartrecruiters','rippling'].includes(ats)) throw new Error('Unsupported public board');
  const origin=ats==='rippling' ? `https://api.rippling.com/platform/api/ats/v1/board/${company}/jobs`
    : `https://api.smartrecruiters.com/v1/companies/${company}/postings`;
  const report={url:origin,source:`${ats}:${company}`,ok:false,checkedAt:new Date().toISOString()};
  health.push(report);
  const path=cacheDir && join(cacheDir,`${ats}-${company}-v2.json`);
  let cached;
  if (path) {mkdirSync(cacheDir,{recursive:true});try {cached=JSON.parse(readFileSync(path,'utf8'));} catch { /* first run */ }}
  if (cached && Date.now()<cached.until && Array.isArray(cached.jobs)) {
    Object.assign(report,cached.report,{cached:true,checkedAt:new Date(cached.at).toISOString()});return cached.jobs;
  }
  const found=new Map();
  let offset=0,done=false;
  try {
    for(let page=0;page<maxPages;page++) {
      const url=ats==='rippling' ? origin : `${origin}?limit=100&offset=${offset}`;
      const res=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(20000),headers:{'User-Agent':'Formwork public job discovery (+https://github.com/JeremiahM37/formwork)'}});
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const data=await res.json();
      const items=ats==='rippling' ? data : data.content;
      if(!Array.isArray(items)) throw new Error('Unexpected response shape');
      let added=0;
      for(const raw of items) {
        const id=text(ats === "smartrecruiters" ? raw.id : raw.uuid);
        const url=safeURL(raw.url || raw.applyUrl || (ats==='smartrecruiters' && id ? `https://jobs.smartrecruiters.com/${company}/${encodeURIComponent(id)}` : ''));
        if(!id || !url || !text(raw.name).trim()) continue;
        const places=ats==='rippling' ? [location(raw.workLocation)] : [raw.location?.city,raw.location?.region,raw.location?.country];
        const remote=raw.location?.remote === true || /\bremote\b/i.test(places.filter(Boolean).join(' '));
        const previous=found.get(id);
        const descriptions=raw.jobAd?.sections ? Object.values(raw.jobAd.sections).map(s=>s?.text || '').join('\n') : text(raw.description);
        const job=previous || {source:`${ats}:${company}`,company:raw.company?.name || company,title:raw.name.trim(),url,
          description:descriptions.slice(0,30000),posted:date(raw.releasedDate || raw.createdAt),active:true,sponsorship:null,
          countries:[],locations:[],workplaceType:remote ? 'remote' : null,employmentType:raw.typeOfEmployment?.label || null};
        job.locations=[...new Set([...job.locations,...places.filter(v=>typeof v==='string' && v.trim()),...(remote?['Remote']:[])])];
        if(ats==='smartrecruiters' && raw.location?.country) job.countries=[...new Set([...job.countries,raw.location.country])];
        if(!previous) added++;
        found.set(id,job);
      }
      offset+=items.length;
      if(ats==='rippling' || !items.length || (Number.isFinite(data.totalFound) && offset>=data.totalFound) || items.length<100) {done=true;break;}
      if(!added) throw new Error('Pagination repeated a page; results are partial');
    }
    if(!done) throw new Error('Page limit reached; results are partial');
    report.ok=true;
  } catch(err) {report.error=String(err.message);report.partial=found.size>0;}
  const jobs=[...found.values()];report.count=jobs.length;
  // Preserve last successful postings on a transport failure, clearly marked stale.
  if(!report.ok && !jobs.length && cached?.jobs?.length) {jobs.push(...cached.jobs);report.stale=true;report.count=jobs.length;}
  if(path) {
    const at=Date.now(), tmp=`${path}.${process.pid}.tmp`;
    writeFileSync(tmp,JSON.stringify({at,until:at+(report.ok?6*3600000:15*60000),jobs,report}));renameSync(tmp,path);
  }
  return jobs;
}
