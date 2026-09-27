"use strict";
const status = document.getElementById("status");
const button = document.getElementById("connect");
let baseUrl;
try {
  const parsed = new URL(new URLSearchParams(location.search).get("base"));
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("Use an HTTP or HTTPS dashboard address without credentials, a query or a fragment.");
  baseUrl = parsed.href.replace(/\/+$/, "");
  document.getElementById("address").textContent = baseUrl;
} catch(err) {status.textContent=err.message;button.disabled=true;}

window.connectDashboard = async ({requestPermission=false,testOnly=false}={}) => {
  if (!baseUrl) throw new Error("No valid dashboard address was provided.");
  const origins = [`${new URL(baseUrl).origin}/*`];
  let allowed = await chrome.permissions.contains({origins});
  if (!allowed && requestPermission) allowed = await chrome.permissions.request({origins});
  if (!allowed) return {ok:false,needsPermission:true,message:"In the Browser tab, click Allow access and connect, then approve Chrome's host-access prompt."};
  const response = await fetch(`${baseUrl}/api/jobfill/complete`, {
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({messages:[{role:"user",content:"Reply with the word ready."}],json:false}),
    signal:AbortSignal.timeout(45000)});
  if (!response.ok) throw new Error(`The dashboard model returned HTTP ${response.status}. Test or update the saved model in Settings.`);
  let reply;
  try {reply=(await response.json()).content;} catch {throw new Error("The address returned a login page or invalid response. Use a dashboard address the browser can reach directly.");}
  if (typeof reply !== "string" || !reply.trim()) throw new Error("The model returned no text.");
  if (!testOnly) {
    const {settings={}} = await chrome.storage.local.get("settings");
    const next = {...settings,dashboardUrl:baseUrl,provider:"homelab",homelab:{baseUrl}};
    await chrome.storage.local.set({settings:next});
    const saved = (await chrome.storage.local.get("settings")).settings;
    if (saved.provider !== "homelab" || saved.homelab?.baseUrl !== baseUrl)
      throw new Error("The browser did not retain its model settings.");
  }
  return {ok:true,baseUrl,reply:reply.slice(0,200),message:testOnly ? "Extension reached the saved dashboard model." : "Connected. Form answers now use the dashboard's saved model."};
};
button.onclick = async () => {
  button.disabled=true;status.textContent="Connecting and testing the model…";
  try {status.textContent=(await window.connectDashboard({requestPermission:true})).message;}
  catch(err) {status.textContent=err.message;}
  finally {button.disabled=false;}
};
