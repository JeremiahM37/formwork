import {readFileSync,writeFileSync,mkdirSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
/** Public Workday careers feed. No authenticated recruiting APIs or submissions. */
export function workdayBoard(value) {
  const url = new URL(value);
  const host = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i.exec(url.hostname);
  const parts = url.pathname.split('/').filter(Boolean);
  if (/^[a-z]{2}-[A-Z]{2}$/.test(parts[0] || '')) parts.shift();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      !host || parts.length !== 1 || !/^[A-Za-z0-9_-]{1,100}$/.test(parts[0]))
    throw new Error('Use a Workday careers board URL, without a job path or query.');
  return {company:host[1], base:`${url.origin}/en-US/${parts[0]}`,
    api:`${url.origin}/wday/cxs/${host[1]}/${parts[0]}/jobs`};
}

export function normalizeWorkday(raw, board) {
  // Relative/localized dates (especially "30+ days") do not establish a date.
  // Keep the label, never turn an unknown age into a fresh posting.
  if (typeof raw.externalPath !== 'string' || !raw.externalPath.startsWith('/job/') ||
      /[?#\\]/.test(raw.externalPath)) throw new Error('Unexpected Workday posting path');
  return {source:`workday:${board.company}`, company:board.company,
    title:String(raw.title || '').trim(), url:board.base+raw.externalPath,
    locations:raw.locationsText ? [String(raw.locationsText)] : [], posted:null,
    postedLabel:String(raw.postedOn || ''), sponsorship:null, active:true};
}

export async function fetchWorkday(url, {health=[], request=fetch, maxPages=250, budgetMs=120000}={}) {
  const report={url,ok:false,count:0,checkedAt:new Date().toISOString()};health.push(report);
  const out=[], seen=new Set(); const started=Date.now();
  try {
    const board=workdayBoard(url);report.url=board.api;
    let offset=0;
    for(let page=0;page<maxPages;page++) {
      const remaining=budgetMs-(Date.now()-started);
      if(remaining<=0) throw new Error('Workday time budget reached; results are partial');
      const res=await request(board.api,{method:'POST',redirect:'error',
        headers:{'Content-Type':'application/json','Accept':'application/json','Accept-Language':'en-US',
          'User-Agent':'formwork-job-aggregator (+https://github.com/JeremiahM37/formwork)'},
        body:JSON.stringify({appliedFacets:{},limit:20,offset,searchText:''}),
        signal:AbortSignal.timeout(Math.min(20000,remaining))});
      report.status=res.status;
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const data=await res.json();
      if(!Array.isArray(data.jobPostings) || !Number.isInteger(data.total) || data.total<0)
        throw new Error('Unexpected Workday response shape');
      // CXS returns total=0 on later pages even while returning jobs. The
      // first response establishes the target; later zeros are not an empty board.
      report.total=Math.max(report.total || 0,data.total); report.pages=page+1;
      if(page===0 && data.total===0 && data.jobPostings.length) throw new Error('Workday returned jobs without a valid total');
      let added=0;
      for(const raw of data.jobPostings) {
        const job=normalizeWorkday(raw,board);
        if(!seen.has(job.url)) {seen.add(job.url);out.push(job);added++;}
      }
      report.count=out.length;
      offset+=data.jobPostings.length;
      if(out.length>=report.total) {report.ok=true;return out;}
      if(offset>=report.total) throw new Error('Workday returned duplicate postings; results are partial');
      if(!added) throw new Error('Workday pagination made no progress; results are partial');
    }
    throw new Error('Workday page limit reached; results are partial');
  } catch(err) {report.error=String(err.message); report.partial=out.length>0;return out;}
}


/** Cache public postings, with a short retry window for incomplete collections. */
export async function fetchWorkdayCached(url,{health=[],cacheDir,...options}={}) {
  if(!cacheDir) return fetchWorkday(url,{health,...options});
  const path=join(cacheDir,'workday-'+createHash('sha256').update(url).digest('hex')+'.json');
  try {
    const saved=JSON.parse(readFileSync(path,'utf8'));
    const age=Date.now()-saved.at;
    if(age>=0 && age<(saved.report.ok?6*3600000:300000) && Array.isArray(saved.jobs)) {
      health.push({...saved.report,cached:true});return saved.jobs;
    }
  } catch { /* Missing, expired or malformed cache: collect again. */ }
  const reports=[];
  const jobs=await fetchWorkday(url,{health:reports,...options});
  health.push(...reports);
  const temporary=path+'.'+randomUUID()+'.tmp';
  try {
    mkdirSync(cacheDir,{recursive:true});
    writeFileSync(temporary,JSON.stringify({at:Date.now(),report:reports[0],jobs}),{mode:0o600});
    renameSync(temporary,path);
  } catch {try{unlinkSync(temporary);}catch{} /* Cache failure must not discard fresh results. */}
  return jobs;
}

/** Enrich the full Workday pool before location filters and candidate ranking. */
export async function enrichWorkday(jobs,{request=fetch,health=[],cacheDir,budgetMs=100000,concurrency=4}={}) {
  const pending=jobs.filter(job=>job.source?.startsWith('workday:'));
  if(!pending.length) return jobs;
  const report={url:'workday:descriptions',ok:false,count:0,total:pending.length,failed:0,cached:0,checkedAt:new Date().toISOString()};health.push(report);
  let index=0;const started=Date.now();const paused=new Set();
  async function one(job) {
    const url=new URL(job.url),match=url.pathname.match(/^\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)(\/job\/[^?#\\]+)$/);
    if(!match) throw new Error('Unexpected Workday job URL');
    const board=workdayBoard(url.origin+'/'+match[1]);
    const endpoint=board.api.replace(/\/jobs$/,'')+match[2];
    const path=cacheDir ? join(cacheDir,'workday-detail-'+createHash('sha256').update(endpoint).digest('hex')+'.json') : null;
    let info;
    if(path) try {
      const saved=JSON.parse(readFileSync(path,'utf8'));
      if(Date.now()-saved.at>=0 && Date.now()-saved.at<6*3600000 && typeof saved.info?.jobDescription==='string') {info=saved.info;report.cached++;}
    } catch { /* Fetch a missing or stale detail. */ }
    if(!info) {
      const cooldown=cacheDir ? join(cacheDir,'workday-cooldown-'+url.hostname+'.json') : null;
      if(cooldown) try {if(JSON.parse(readFileSync(cooldown,'utf8')).until>Date.now()) paused.add(url.hostname);} catch {}
      if(paused.has(url.hostname)) {report.failed++;report.rateLimited=true;return;}
      const remaining=budgetMs-(Date.now()-started);
      if(remaining<=0) {report.failed++;return;}
      const result=await request(endpoint,{redirect:'error',headers:{Accept:'application/json','Accept-Language':'en-US'},signal:AbortSignal.timeout(Math.min(15000,remaining))});
      if(result.status===429) {
        paused.add(url.hostname);report.rateLimited=true;
        const retry=result.headers?.get?.('retry-after');
        const delay=/^\d+$/.test(retry||'') ? Number(retry)*1000 : Date.parse(retry||'')-Date.now();
        const until=Date.now()+Math.max(15*60000,Number.isFinite(delay)?delay:0);
        if(cooldown) try {mkdirSync(cacheDir,{recursive:true});writeFileSync(cooldown,JSON.stringify({until}),{mode:0o600});} catch {}
      }
      if(!result.ok) throw new Error('HTTP '+result.status);
      info=(await result.json()).jobPostingInfo;
      if(!info || typeof info.jobDescription!=='string' || !info.jobDescription.trim()) throw new Error('Workday description missing');
      if(path) {
        const temp=path+'.'+randomUUID()+'.tmp';
        try {mkdirSync(cacheDir,{recursive:true});writeFileSync(temp,JSON.stringify({at:Date.now(),info}),{mode:0o600});renameSync(temp,path);}
        catch {try{unlinkSync(temp);}catch{} }
      }
    }
    job.description=info.jobDescription;
    const locations=[info.location,...(Array.isArray(info.additionalLocations)?info.additionalLocations:[])].filter(x=>typeof x==='string' && x.trim());
    if(locations.length) job.locations=[...new Set(locations)];
    if(/^\d{4}-\d{2}-\d{2}$/.test(info.startDate||'')) job.posted=info.startDate;
    if(info.canApply===false || info.posted===false) job.active=false;
    job.descriptionStatus='available';report.count++;
  }
  await Promise.all(Array.from({length:Math.max(1,Math.min(8,concurrency))},async()=>{
    while(index<pending.length) {
      const job=pending[index++];
      try {await one(job);} catch(error) {report.failed++;report.lastError=String(error.message);}
      if(!job.description) job.descriptionStatus='unavailable';
    }
  }));
  report.ok=report.count===report.total;report.partial=!report.ok && report.count>0;
  if(!report.ok) report.error=`${report.total-report.count} Workday descriptions unavailable; refresh retries missing details`;
  return jobs;
}
