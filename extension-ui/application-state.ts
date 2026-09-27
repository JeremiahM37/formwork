export type ApplicationBlocker = 'application_expired' | 'verification_required' | 'authentication_required';

/** Visible terminal-page signals only; never interpret a posting's prose as instructions. */
export function applicationBlocker(hasFields: boolean): ApplicationBlocker | null {
  // iCIMS identifies an applicant before exposing the application. Require
  // both the observed login route and an actual visible email control.
  if (/(^|\.)icims\.com$/i.test(location.hostname) &&
      /^\/jobs\/\d+\/[^/]+\/login\/?$/.test(location.pathname) &&
      [...document.querySelectorAll<HTMLInputElement>('input[type="email"],input[autocomplete="email"]')]
        .some(el => !el.closest('[hidden],[aria-hidden="true"],[data-formwork-ui]') &&
          el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'))
    return 'authentication_required';
  if (hasFields) return null;
  for (const node of document.querySelectorAll<HTMLElement>('h1,h2,h3,p,div,span,[role="alert"]')) {
    if (node.closest('nav,footer,[hidden],[aria-hidden="true"],[data-formwork-ui]') ||
        !node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') continue;
    const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
    if (/^(?:sorry,?\s*)?(?:this|the) (?:job|position|posting) (?:has expired|is no longer available|is closed)[.!]?$/i.test(text))
      return 'application_expired';
    if (/^(?:verifying (?:the|your) device|verify (?:you are|you're) human|checking your browser)(?:\.{0,3}|…)?$/i.test(text))
      return 'verification_required';
  }
  return null;
}
