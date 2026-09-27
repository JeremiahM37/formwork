"use strict";
async function renderCalendar(root, applications) {
  const box=el("details", {className:"card"},el("summary",{textContent:"Google Calendar"}));root.append(box);
  try {
    const data=await api('/api/calendar/google');
    if (!box.isConnected) return;
    if (!data.connected) {
      box.append(el('p',{textContent:'Connect Google in Settings, then grant calendar access here.'}),workspaceButton('Connect calendar',async()=>{
        const result=await api('/api/connections/google/authorize?calendar=true',{method:'POST'});location.assign(result.url);
      }));return;
    }
    box.append(workspaceButton(data.pending?'Read next calendar batch':'Sync Google Calendar',async()=>{
      await api('/api/calendar/google/sync',{method:'POST'});await renderWorkspace();
    }),el('p',{className:'muted',textContent:data.error || (data.lastSync?'Last sync: '+new Date(data.lastSync*1000).toLocaleString():'No calendar sync yet.')}));
    const renderEvent=(item, parent)=>{
      const select=el('select',{ariaLabel:'Application for '+(item.summary||item.id)},el('option',{value:'',textContent:'Choose application'}),
        ...applications.map(a=>el('option',{value:String(a.id),textContent:a.company+' · '+a.title})));
      const when=item.start?.dateTime || item.start?.date || item.originalStartTime?.dateTime || '';
      const row=el('div',{className:'card'},el('strong',{textContent:item.summary||'Cancelled event'}),
        el('p',{textContent:when+' · '+(item.status||'confirmed')}));
      if (item.recurrence) {
        const dateString=date=>date.toISOString().slice(0,10);
        const from=workspaceField('Occurrences from','date',dateString(new Date()));
        const until=workspaceField('Occurrences until','date',dateString(new Date(Date.now()+90*86400000)));
        const results=el('div');let next='',range='';
        const load=async(more=false)=>{
          const params=new URLSearchParams({start:String(new Date(from.input.value+'T00:00:00').getTime()/1000),
            end:String(new Date(until.input.value+'T00:00:00').getTime()/1000)});
          if (more && range===params.toString()) params.set('page',next);
          else {results.replaceChildren();next='';range=params.toString();}
          const batch=await api('/api/calendar/google/events/'+encodeURIComponent(item.id)+'/instances?'+params);
          for (const occurrence of batch.events) renderEvent(occurrence,results);
          next=batch.page;moreButton.hidden=!next;
          if (!batch.events.length && !next) results.append(el('p',{textContent:'No occurrences in this range.'}));
        };
        const moreButton=workspaceButton('More occurrences',()=>load(true));moreButton.hidden=true;
        row.append(from.node,until.node,workspaceButton('Show occurrences',()=>load()),results,moreButton);
      }
      else if (item.start?.date && item.status!=='cancelled') row.append(el('p',{textContent:'All-day event: schedule a timed interview before importing.'}));
      else row.append(select,workspaceButton('Import reviewed schedule',async()=>{
        if (!select.value) throw new Error('Choose an application first');
        await api('/api/calendar/google/events/'+encodeURIComponent(item.id)+'/import',{method:'POST',body:{applicationId:Number(select.value),etag:item.etag}});
        await renderWorkspace();toast('Interview schedule imported.');
      }));
      parent.append(row);
    };
    for (const item of data.events) renderEvent(item,box);
  } catch(error) {box.append(el('p',{textContent:error.message}));}
}
