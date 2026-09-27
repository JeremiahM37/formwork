/** Optional private deployment pairing. The package contains only a server URL. */
async function pairDashboard() {
  try {
    const {profile, settings = {}} = await chrome.storage.local.get(['profile', 'settings']);
    const config = await (await fetch(chrome.runtime.getURL('dashboard.json'))).json();
    // Repair a missing address in an explicitly paired package on upgrade.
    // Keep the applicant's data and any deliberately configured provider.
    if (profile) {
      if ((!settings.provider || settings.provider === 'homelab') && !settings.homelab?.baseUrl?.trim()) {
        await chrome.storage.local.set({settings:{...settings, provider:'homelab',
          dashboardUrl:settings.dashboardUrl || config.origin,
          homelab:{...settings.homelab, baseUrl:config.origin}}});
      }
      return;
    }
    const response = await fetch(`${config.origin}/api/profile`, {signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error(`Profile server returned HTTP ${response.status}`);
    const data = await response.json();
    if (!data.profile?.identity) throw new Error('The dashboard has no saved applicant profile.');
    await chrome.storage.local.set({
      profile:data.profile, about:data.about || '', setupComplete:true,
      settings:{provider:'homelab',dashboardUrl:config.origin,homelab:{baseUrl:config.origin},autoApprove:false,autoFillOnLoad:false},
      pairingStatus:'Connected to dashboard',
    });
  } catch(error) {
    await chrome.storage.local.set({pairingStatus:`Dashboard connection failed: ${error.message}`});
  }
}
chrome.runtime.onInstalled.addListener(pairDashboard);
chrome.runtime.onStartup.addListener(pairDashboard);
