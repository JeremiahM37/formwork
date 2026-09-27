/** Read-only evidence. A generic thank-you message is not a submission receipt. */
export function confirmationOnPage() {
  const text = document.body?.innerText || '';
  const match = text.match(/\b(?:your\s+)?application\s+(?:(?:has been|was|is)\s+)?(?:successfully\s+)?(?:submitted|received)\b|\bwe(?:['’]ve| have) received your application\b|\bthank you for (?:applying|your application)\b/i);
  return {confirmation: !!match, evidence: match?.[0] || ''};
}

/** Only selected documents and upload/review regions count, never a résumé library. */
export async function resumeOnPage(expected) {
  const visible = el => !!el && !!(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const files = [];
  for (const input of document.querySelectorAll('input[type="file"]')) {
    const label = [input.name, input.id, input.getAttribute('aria-label'), ...Array.from(input.labels || [], l=>l.textContent)].join(' ');
    if (!/resume|résumé|cv\b/i.test(label)) continue;
    for (const file of input.files || []) {
      const bytes = await file.arrayBuffer();
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b=>b.toString(16).padStart(2,'0')).join('');
      files.push({filename:file.name, sha256, source:'upload control'});
    }
  }
  const regions = [...document.querySelectorAll('input[type="radio"]:checked, [role="radio"][aria-checked="true"]')]
    .map(el => el.closest('label') || el.closest('[class*="resume"]') || el.parentElement);
  for (const el of document.querySelectorAll('section, fieldset, [data-testid], [data-automation-id]')) {
    const heading = el.querySelector('h1,h2,h3,h4,legend');
    if (/^(?:your |uploaded |attached )?(?:resume|résumé|cv)\b/i.test(heading?.textContent?.trim() || '') && !el.querySelector('input[type="radio"], [role="radio"]')) regions.push(el);
  }
  // Indeed's application preview is a separate document. Read just the résumé section.
  const inPreview = window.frameElement?.getAttribute('title') === 'Application preview';
  if (inPreview) {
    for (const heading of document.querySelectorAll('h1,h2,h3,h4')) {
      if (/^(resume|résumé|cv)$/i.test(heading.textContent.trim())) regions.push(heading.parentElement);
    }
  }
  const names = new Set();
  for (const region of regions.filter(visible)) {
    const text = [region.innerText || '', region.getAttribute('aria-label') || '', ...Array.from(region.querySelectorAll('[aria-label]'), el=>el.getAttribute('aria-label'))].join('\n');
    for (const line of text.split('\n').map(s=>s.trim())) {
      if (/\.(pdf|docx?)$/i.test(line)) names.add(line);
    }
    for (const link of region.querySelectorAll('a[download]')) if (link.download) names.add(link.download);
  }
  for (const filename of names) files.push({filename, source:inPreview?'employer preview':'selected document'});
  if (!expected) return {status:'unknown', files};
  const different = files.some(f => f.filename !== expected.filename || (f.sha256 && expected.sha256 && f.sha256 !== expected.sha256));
  const matching = files.some(f => f.filename === expected.filename && (!f.sha256 || !expected.sha256 || f.sha256 === expected.sha256));
  return {status:different?'mismatch':matching?'matched':'unknown', files,
    reason:different?'The selected résumé differs from the prepared document.':matching?'Selected résumé matches; server previews verify the filename only.':'The selected résumé could not be verified. Open the résumé section or attach it again.'};
}

export async function inspectResume(page, expected) {
  const results = [];
  for (const frame of page.frames()) {
    try { results.push(await frame.evaluate(resumeOnPage, expected)); } catch { /* navigated/detached frame cannot prove an attachment */ }
  }
  const files = results.flatMap(r=>r.files);
  const status = results.some(r=>r.status==='mismatch')?'mismatch':results.some(r=>r.status==='matched')?'matched':'unknown';
  return {status, expected, files, checkedAt:Date.now(), reason:results.find(r=>r.status===status)?.reason || 'No readable résumé evidence.'};
}

export async function reviewText(page) {
  const texts = [];
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame()) {
      const element = await frame.frameElement().catch(()=>null);
      if (!element || await element.getAttribute('title') !== 'Application preview') continue;
    }
    texts.push((await frame.locator('body').innerText().catch(()=>'' )).slice(0,30000));
  }
  return texts.join('\n').slice(0,60000);
}
