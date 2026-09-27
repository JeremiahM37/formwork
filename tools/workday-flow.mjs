/** Shared Workday navigation inspection for the CLI and dashboard. */
export function inspectWorkdayStep() {
  const visible = el => {
    const r=el.getBoundingClientRect();
    return r.width>0 && r.height>0 && getComputedStyle(el).visibility!=='hidden';
  };
  const controls=[...document.querySelectorAll('button,a[role="button"],input[type="submit"]')].filter(el=>visible(el) && !el.closest('#formwork-panel'));
  const id=el=>el.getAttribute('data-automation-id') || '';
  const label=el=>(el.innerText || el.value || '').trim();
  const submit=controls.find(el=>/^(wd-)?submit$|^submitButton$|submitApplication|applicationSubmit/i.test(id(el)) || /^(submit( application)?|send application|complete application|finish)$/i.test(label(el)));
  const login=controls.some(el=>/SignInWithEmailButton|signInSubmitButton|createAccountSubmitButton/i.test(id(el)) || /^sign in with (email|google|linkedin)$/i.test(label(el))) ||
    [...document.querySelectorAll('input[type=password]')].some(visible);
  const errors=[...document.querySelectorAll('[role="alert"],[data-automation-id*="error" i]')].filter(el=>visible(el) && !el.closest('#formwork-panel')).map(el=>el.textContent.trim()).filter(Boolean);
  const heading=document.querySelector('[data-automation-id="pageHeaderTitle"], [aria-current="step"]')?.textContent.trim() || '';
  const fields=[...document.querySelectorAll('input,select,textarea,[role="combobox"]')].filter(visible).filter(el=>!el.closest('#formwork-panel'));
  const fingerprint=location.pathname+'|'+heading+'|'+fields.map(el=>el.id || el.name || el.getAttribute('aria-label') || el.type).join('|');
  const base={heading,fingerprint,errors};
  for(const el of document.querySelectorAll('[data-formwork-next]')) el.removeAttribute('data-formwork-next');
  if(login) return {...base,kind:'login',message:'Sign in to Workday in the Browser tab, then resume this application.'};
  // A final submission control takes precedence even if a tenant also renders Next.
  if(submit) return {...base,kind:'review',label:label(submit),message:'Workday final review reached. Review every step before submitting.'};
  const footer=controls.filter(el=>/^(bottom-navigation-next-button|pageFooterNext|wd-Next)$/i.test(id(el)));
  const nexts=footer.length?footer:controls.filter(el=>/^(save and continue|continue|next)$/i.test(label(el)));
  if(nexts.length>1) return {...base,kind:'unknown',message:'Multiple continuation controls are visible. Open the intended step in the Browser tab and re-read it.'};
  const next=nexts[0];
  if(next) {
    next.setAttribute('data-formwork-next','1');
    return {...base,kind:'next',label:label(next),disabled:next.disabled || next.getAttribute('aria-disabled')==='true',message:'Review this page, then save and continue to the next Workday step.'};
  }
  return {...base,kind:'unknown',message:'Workday has not exposed an application step. Inspect the Browser tab and resume when it is ready.'};
}

export function isWorkday(url) {
  try {return /^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/i.test(new URL(url).hostname);} catch {return false;}
}

export async function enterWorkday(page) {
  if(!isWorkday(page.url())) return null;
  if(!/\/apply(?:\/|$)/.test(new URL(page.url()).pathname)) {
    const entry=page.locator('[data-automation-id="adventureButton"], [data-automation-id="continueButton"]').first();
    await entry.waitFor({state:'visible',timeout:20000});
    await entry.click();
    const manual=page.locator('[data-automation-id="applyManually"]').first();
    await Promise.race([manual.waitFor({state:'visible',timeout:15000}),page.waitForURL(/\/apply(?:\/|$)/,{timeout:15000})]);
  }
  // Direct /apply links can still show the entry chooser. URL shape alone
  // does not establish that Apply Manually has run (observed on a live tenant).
  await page.waitForFunction(()=>document.querySelector('[data-automation-id="applyManually"], [data-automation-id="SignInWithEmailButton"], [data-automation-id="signInSubmitButton"], [data-automation-id="pageHeaderTitle"], [data-automation-id="bottom-navigation-next-button"], [data-automation-id="wd-Submit"], input[type="password"]'),{},{timeout:20000}).catch(()=>{});
  const manual=page.locator('[data-automation-id="applyManually"]');
  if(await manual.count() === 1 && await manual.isVisible()) await manual.click();
  await page.waitForFunction(()=>document.querySelector('[data-automation-id="SignInWithEmailButton"], [data-automation-id="signInSubmitButton"], [data-automation-id="pageHeaderTitle"], [data-automation-id="bottom-navigation-next-button"], [data-automation-id="wd-Submit"], input[type="password"]'),{},{timeout:20000}).catch(()=>{});
  return page.evaluate(inspectWorkdayStep);
}

export async function advanceWorkday(page,expectedFingerprint) {
  const before=await page.evaluate(inspectWorkdayStep);
  if(before.kind!=='next') throw new Error('Only a Workday intermediate step can be advanced; submission is a separate action.');
  if(before.disabled) throw new Error('Workday has disabled Save and Continue. Complete the required fields first.');
  if(!expectedFingerprint || before.fingerprint!==expectedFingerprint) throw new Error('The Workday page changed. Re-read it before continuing.');
  await page.locator('[data-formwork-next="1"]').click();
  const deadline=Date.now()+20000;
  let after=before;
  while(Date.now()<deadline) {
    await page.waitForTimeout(300);
    after=await page.evaluate(inspectWorkdayStep);
    if(after.fingerprint!==before.fingerprint && after.kind!=='unknown') return {advanced:true,flow:after};
    if(after.errors.length) return {advanced:false,flow:after};
  }
  return {advanced:false,flow:{...after,message:'Workday did not advance. Check validation messages in the Browser tab.'}};
}
