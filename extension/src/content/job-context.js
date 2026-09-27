/** Read posting text locally; never include filled form values. */
(() => {
 const ns=window.__formwork=window.__formwork||{};
 ns.readJobPosting=()=>{
  let posting;
  function find(value){
   if(!value||typeof value!=='object')return;
   if([value['@type']].flat().includes('JobPosting'))return value;
   for(const child of Object.values(value)){const found=Array.isArray(child)?child.map(find).find(Boolean):find(child);if(found)return found;}
  }
  for(const script of document.querySelectorAll('script[type="application/ld+json"]')){
   try{posting=find(JSON.parse(script.textContent));if(posting)break;}catch{}
  }
  const plain=html=>{const box=document.createElement('template');box.innerHTML=html;box.content.querySelectorAll('script,style').forEach(n=>n.remove());return box.content.textContent.replace(/\s+/g,' ').trim()};
  if(posting?.description)return {company:posting.hiringOrganization?.name||'',title:posting.title||'',description:plain(posting.description).slice(0,18000)};
  const node=document.querySelector('[data-automation-id="jobPostingDescription"],.job-description,#job-description,[data-testid="job-description"],main,article,#content');
  if(!node)return null;
  const copy=node.cloneNode(true);
  copy.querySelectorAll('form,input,textarea,select,button,script,style,nav,footer,[hidden],[aria-hidden="true"],[role="dialog"]').forEach(n=>n.remove());
  const description=(copy.textContent||'').replace(/\s+/g,' ').trim();
  if(description.length<200 || !/responsibilit|qualification|requirements|about (?:the|this) role|what you.ll|we.re looking|what you bring/i.test(description))return null;
  const title=document.querySelector('h1')?.textContent?.trim()||'';
  return {title:/^(apply|application|job application)$/i.test(title)?'':title,description:description.slice(0,18000)};
 };
})();
