/** Workday's React search lifecycle, executed in the page world by scripting.
 * Only the requested search input/value enter the page; no profile or secrets.
 * See docs/workday-investigation.md for implementation research and evidence.
 */
(function(root){
 async function workdaySelect(id,value){
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const normalized=v=>String(v||'').trim().toLowerCase().replace(/\s+/g,' ');
  const getInput=()=>document.getElementById(id);
  let input=getInput();
  if(!input?.matches('input[data-uxi-widget-type="selectinput"]') || !input.closest('[data-automation-id^="formField"]'))return {ok:false,reason:'Not a Workday search control'};
  const scope=()=>getInput()?.closest('[data-automation-id^="formField"]');
  const selected=()=>[...(scope()?.querySelectorAll('[data-automation-id="selectedItem"], [data-automation-id="selectedItemList"] li, [data-automation-id="selectedItemList"] [role="option"]')||[])].map(n=>{
   const copy=n.cloneNode(true);copy.querySelectorAll('button,[aria-hidden="true"]').forEach(n=>n.remove());return normalized(copy.getAttribute('data-automation-label')||copy.textContent);
  });
  const confirmed=()=>selected().includes(normalized(value));
  if(confirmed())return {ok:true,alreadySelected:true};
  const props=node=>{if(!node)return null;const key=Object.keys(node).find(k=>k.startsWith('__reactProps$')||k.startsWith('__reactEventHandlers$'));return key?node[key]:null;};
  const event=(node,extra={})=>({target:node,currentTarget:node,bubbles:true,cancelable:true,preventDefault(){},stopPropagation(){},persist(){},isDefaultPrevented:()=>false,isPropagationStopped:()=>false,...extra});
  const widget=()=>getInput()?.getAttribute('data-uxi-multiselect-id');
  const options=()=>[...document.querySelectorAll('[data-automation-id="promptLeafNode"]')].filter(n=>n.getClientRects().length && (!widget()||n.getAttribute('data-uxi-multiselect-id')===widget()));
  const label=node=>node.querySelector('[data-automation-id="promptOption"]')?.getAttribute('data-automation-label')||node.querySelector('[data-automation-id="promptOption"]')?.textContent||node.textContent;
  input.focus();input.click();await wait(80);input=getInput();
  if(!input)return {ok:false,reason:'Workday replaced the search field'};
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
  input._valueTracker?.setValue('');
  input.dispatchEvent(new InputEvent('input',{bubbles:true,data:value,inputType:'insertText'}));
  const handlers=props(input);
  if(!handlers?.onKeyDown||!handlers?.onKeyUp)return {ok:false,reason:'Workday search handler unavailable'};
  handlers.onChange?.(event(input,{type:'change',nativeEvent:new Event('input')}));
  // Workday opens multiple search results only for Enter. Tab is a blur
  // search: it may close the popup, skip responsive controls, or auto-select
  // one result. Call the component's key handlers, never dispatch a DOM Enter
  // that could submit the application form.
  await wait(150);input=getInput();
  if(!input)return {ok:false,reason:'Workday replaced the search field'};
  const searchHandlers=props(input);
  if(!searchHandlers?.onKeyDown||!searchHandlers?.onKeyUp)return {ok:false,reason:'Workday search handler unavailable'};
  for(const type of ['keydown','keyup']) {
   const handler=type==='keydown'?searchHandlers.onKeyDown:searchHandlers.onKeyUp;
   handler(event(input,{target:{value},type,key:'Enter',code:'Enter',keyCode:13,which:13,nativeEvent:new KeyboardEvent(type,{key:'Enter',code:'Enter',keyCode:13})}));
  }
  let matches=[],observed=[];
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){
   // A unique result can be committed by Workday without rendering a menu.
   if(confirmed()){getInput()?.blur();return {ok:true,selected:value};}
   observed=options();
   matches=observed.filter(n=>normalized(label(n))===normalized(value));
   if(matches.length===1)break;
   matches=[];await wait(120);
  }
  if(matches.length!==1)return {ok:false,reason:'No unique Workday suggestion',options:observed.map(label).slice(0,15),visibleOptions:[...document.querySelectorAll('[data-automation-id="promptOption"]')].filter(n=>n.getClientRects().length).map(n=>n.textContent).slice(0,15)};
  const target=matches[0],option=target.querySelector('[data-automation-id="promptOption"]')||target;
  option.click();await wait(250);
  if(!confirmed()){
   // Call ONE owner handler if the ordinary click was ignored. Never call
   // every ancestor: checkbox-like entries toggle back off on a second click.
   let handlerNode=option;
   while(handlerNode && handlerNode!==target.parentElement && !props(handlerNode)?.onClick)handlerNode=handlerNode.parentElement;
   props(handlerNode||target)?.onClick?.(event(handlerNode||target,{type:'click',nativeEvent:new MouseEvent('click')}));
  }
  const commitDeadline=Date.now()+1800;
  while(Date.now()<commitDeadline&&!confirmed())await wait(100);
  if(!confirmed())return {ok:false,reason:'Workday did not retain the selected chip'};
  getInput()?.blur();
  return {ok:true,selected:value};
 }
 if(typeof module==='object'&&module.exports)module.exports={workdaySelect};
 else (root.__formwork=root.__formwork||{}).workdaySelect=workdaySelect;
})(typeof globalThis!=='undefined'?globalThis:this);
