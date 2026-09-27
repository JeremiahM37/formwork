"use strict";
let inboxOffset=0;
let inboxGeneration=0;
async function renderGoogleSettings() {
  const connection=await api('/api/connections/google');
  const root=$('googleSettings');root.replaceChildren(el('h2',{textContent:'Gmail connection'}));
  root.append(el('p',{className:'small muted',textContent:'Read job-related messages and review suggested application updates and sender contacts. Formwork requests read-only Gmail access; it cannot send mail.'}));
  root.append(el('p',{textContent:connection.connected?`Connected: ${connection.account}`:'Google is not connected.'}));
  if(connection.lastError)root.append(el('p',{role:'status',className:'small',style:'color:var(--bad)',textContent:connection.lastError}));
  const client=workspaceField('Google OAuth client ID','text',connection.clientId);
  const secret=workspaceField('Google OAuth client secret','password');secret.input.autocomplete='new-password';
  const redirect=workspaceField('Google OAuth callback URL','url',connection.redirectUri || (/\.(internal|local)$/.test(location.hostname)?connection.localCallbackUri:location.origin+'/api/connections/google/callback'));
  if(new URL(redirect.input.value).host!==location.host)root.append(el('p',{className:'small',textContent:`Open ${new URL(redirect.input.value).origin} in the Browser tab to finish setup and connect. Google does not accept private .internal callback names.`}));
  root.append(el('details',{},el('summary',{textContent:'Google OAuth setup'}),
    el('p',{className:'small',textContent:'Create a Web application OAuth client in Google Cloud, enable Gmail API, and register this exact callback URL. For a personal testing app, add your Google account as a test user. Open Formwork at the callback’s host before connecting.'}),
    el('a',{href:'https://console.cloud.google.com/apis/credentials',target:'_blank',rel:'noopener noreferrer',textContent:'Open Google Cloud credentials'}),
    client.node,secret.node,redirect.node,
    el('p',{className:'small muted',textContent:connection.hasClientSecret?'A client secret is saved. Leave the field blank to retain it.':'A client secret has not been saved.'}),
    workspaceButton('Save Google setup',async()=>{
      await api('/api/connections/google/config',{method:'POST',body:{clientId:client.input.value,clientSecret:secret.input.value,redirectUri:redirect.input.value}});
      secret.input.value='';await renderGoogleSettings();
    })));
  root.append(workspaceButton(connection.connected?'Reconnect Google':'Connect Google',async()=>{
    const {url}=await api('/api/connections/google/authorize',{method:'POST'});location.assign(url);
  }));
  if(connection.connected)root.append(workspaceButton('Disconnect Google',async()=>{
    if(!confirm('Disconnect Google and remove cached inbox messages? Reviewed application history and imported contacts will stay.'))return;
    await api('/api/connections/google/disconnect',{method:'POST'});await renderGoogleSettings();
  }));
  const automatic=workspaceField('Sync Gmail automatically every 15 minutes','checkbox');automatic.input.checked=connection.autoSync;
  automatic.input.onchange=()=>api('/api/connections/google/sync-settings',{method:'POST',body:{enabled:automatic.input.checked}}).catch(err=>{automatic.input.checked=!automatic.input.checked;toast(err.message,'bad');});
  root.append(automatic.node,el('a',{href:'#workspace',textContent:'Review job-search inbox'}));
}

async function renderInbox(root,applications) {
  const generation=++inboxGeneration;
  const data=await api(`/api/inbox?offset=${inboxOffset}`);
  if(!root.isConnected || generation!==inboxGeneration)return;
  const section=el('details',{className:'card'},el('summary',{textContent:`Job-search inbox (${data.count} to review)`}));root.append(section);
  if(!data.connection.connected) {
    section.append(el('p',{textContent:'Connect Gmail in Settings to synchronize messages.'}),el('a',{href:'#settings',textContent:'Google connection settings'}));return;
  }
  section.append(el('p',{className:'small muted',textContent:'Company and status matches are suggestions. Choose the application and any status change yourself. Sender details come from email headers.'}));
  if(data.connection.lastError)section.append(el('p',{role:'status',textContent:data.connection.lastError}));
  section.append(workspaceButton(data.connection.syncPending?'Sync next batch':'Sync Gmail now',async()=>{
    const result=await api('/api/inbox/sync',{method:'POST'});toast(result.pending?'Batch synchronized; more messages remain.':'Gmail synchronized.');await renderWorkspace();
  }));
  for(const message of data.messages) {
    const card=el('div',{className:'card'},el('h3',{textContent:message.subject || '(No subject)'}),
      el('p',{className:'small muted',textContent:`${message.senderName} <${message.senderEmail}> · ${new Date(message.receivedAt*1000).toLocaleString()}`}),
      el('p',{textContent:message.snippet}));
    const url=`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(data.connection.account)}#all/${encodeURIComponent(message.id)}`;
    card.append(el('a',{href:url,target:'_blank',rel:'noopener noreferrer',textContent:'Open original in Gmail'}));
    const application=el('select',{ariaLabel:`Application for ${message.subject}`},el('option',{value:'',textContent:'Choose an application…'}));
    const suggested=new Set(message.candidates.map(candidate=>candidate.id));
    for(const item of [...applications].sort((a,b)=>Number(suggested.has(b.id))-Number(suggested.has(a.id))))
      application.append(el('option',{value:item.id,textContent:`${suggested.has(item.id)?'Possible match: ':''}${item.company} · ${item.title}`}));
    const stage=el('select',{ariaLabel:`Status for ${message.subject}`},...['','submitted','screening','interview','offer','rejected','withdrawn','ghosted'].map(value=>el('option',{value,textContent:value || 'Keep current status'})));
    if(message.suggestedStatus)card.append(el('p',{className:'small muted',textContent:`Message wording suggests: ${message.suggestedStatus}. This has not changed your application.`}));
    card.append(application,stage,el('div',{className:'row wrap'},
      workspaceButton('Link reviewed message',async()=>{
        if(!application.value)throw new Error('Choose an application first');
        await api(`/api/inbox/${encodeURIComponent(message.id)}/review`,{method:'POST',body:{action:'link',applicationId:Number(application.value),status:stage.value}});await renderWorkspace();
      }),workspaceButton('Dismiss message',async()=>{
        await api(`/api/inbox/${encodeURIComponent(message.id)}/review`,{method:'POST',body:{action:'dismiss'}});await renderWorkspace();
      }),workspaceButton('Import sender contact',async()=>{
        const result=await api(`/api/inbox/${encodeURIComponent(message.id)}/contact`,{method:'POST'});toast(result.existing?'This contact already exists.':'Sender imported with message provenance.');
      })));
    section.append(card);
  }
  const navigation=el('div',{className:'row'});
  if(inboxOffset>0)navigation.append(workspaceButton('Previous messages',async()=>{inboxOffset=Math.max(0,inboxOffset-50);await renderWorkspace();}));
  if(inboxOffset+data.messages.length<data.count)navigation.append(workspaceButton('More messages',async()=>{inboxOffset+=50;await renderWorkspace();}));
  section.append(navigation);
}
