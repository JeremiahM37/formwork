/** Local-only application detection. Never sends field values or calls a model. */
(() => {
  if (document.documentElement.hasAttribute("data-formwork-dashboard")) return;
  if (window.__formworkDetector) return;
  window.__formworkDetector = true;
  let notified = false, scheduled = false, lastPosting = "";
  const application = /\b(job application|apply for (?:this|the) (?:job|role|position)|submit (?:your )?application|application form|candidate information)\b/i;
  const resume = /\b(resum[eé]|curriculum vitae|cv)\b/i;
  const visible = el => Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  function detect() {
    scheduled = false;
    if (!document.body) return;
    if (window.top === window) {
      const posting=window.__formwork?.readJobPosting?.();
      if(posting && location.href+JSON.stringify(posting)!==lastPosting){
        lastPosting=location.href+JSON.stringify(posting);
        chrome.runtime.sendMessage({type:'saveJobContext',payload:{...posting,automatic:true}}).catch(()=>{});
      }
    }
    if (notified) return;
    const controls = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select')]
      .filter(el => !el.closest('nav,footer,[role=navigation]') && !el.disabled && visible(el));
    if (controls.length < 2) return;
    const contact = controls.some(el => el.type === 'email' || /email|e-mail/i.test(`${el.name} ${el.id} ${el.autocomplete} ${el.getAttribute('aria-label')}`));
    if (!contact) return;
    // Prefer the actual form's text. A site's general careers/footer links do
    // not turn its newsletter or checkout form into a job application.
    const email = controls.find(el => el.type === 'email' || /email|e-mail/i.test(`${el.name} ${el.id}`));
    const scope = email?.closest('form') || document.querySelector('main') || document.body;
    const text = (scope.innerText || '').slice(0,30000);
    const upload = [...scope.querySelectorAll('input[type=file]')].some(el =>
      !el.closest('[hidden],[aria-hidden=true]') && resume.test(`${el.name} ${el.id} ${el.getAttribute('aria-label')} ${el.parentElement?.textContent}`));
    const heading = [...document.querySelectorAll('h1,h2')].map(el=>el.textContent).join(' ').slice(0,1500);
    const known = /(^|\.)(greenhouse\.io|lever\.co|myworkdayjobs\.com|ashbyhq\.com|bamboohr\.com|workable\.com|jobvite\.com|smartrecruiters\.com|icims\.com|rippling\.com|teamtailor\.com|recruitee\.com|applytojob\.com|breezy\.hr)$/.test(location.hostname);
    const applicationPath = /\/(apply|applications?)(\/|$)/i.test(location.pathname);
    if (!(upload || application.test(text) || application.test(heading) || (known && applicationPath))) return;
    notified = true;
    observer.disconnect();
    chrome.runtime.sendMessage({type:'applicationDetected'}).catch(()=>{});
  }
  const observer = new MutationObserver(() => {
    if (!notified && !scheduled) { scheduled = true; setTimeout(detect, 500); }
  });
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','aria-hidden','class','style']});
  detect();
})();
