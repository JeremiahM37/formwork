/** Real input for already-validated answers. No fuzzy options or inferred dates. */
export function markTrustedField({id,token}) {
  const ns=window.__formwork;
  const schema=ns?._last?.scraped?.schema || window.__wdSchema;
  const registry=ns?._last?.scraped?.registry || window.__wdRegistry;
  const index=schema?.fields.findIndex(field=>field.id===id);
  const field=schema?.fields[index], elements=registry?.[index];
  if(!field || !elements?.length || elements.some(el=>!el.isConnected)) return null;
  return {id,type:field.type,parts:field.parts || [],members:elements.map((el,i)=>{
    el.setAttribute('data-formwork-trusted',`${token}-${i}`);
    return {selector:`[data-formwork-trusted="${token}-${i}"]`,label:ns.labelFor(el),
      part:el.getAttribute('aria-label') || field.parts?.[i] || '',type:el.type,
      value:el.value,checked:el.checked};
  })};
}

/** Full numeric dates are decoded without Date.parse's UTC/local-day shift. */
export function dateParts(value) {
  const text=String(value).trim();
  if(/^\d{4}$/.test(text)) return {year:text};
  let year,month,day,match;
  if((match=/^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text))) [,year,month,day]=match;
  else if((match=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text))) [,month,day,year]=match;
  else return null;
  const date=new Date(Date.UTC(Number(year),Number(month)-1,Number(day)));
  if(date.getUTCFullYear()!==Number(year) || date.getUTCMonth()+1!==Number(month) || date.getUTCDate()!==Number(day)) return null;
  return {year,month:month.padStart(2,'0'),day:day.padStart(2,'0')};
}

export async function trustedInput(page,target,value) {
  if(!target || value==null || !String(value).trim()) return {ok:false,reason:'No exact validated target or answer'};
  const norm=text=>String(text).trim().replace(/\s+/g,' ').toLowerCase();
  const members=target.members;
  try {
    if(target.type==='date') {
      const parts=dateParts(value);
      const values=members.map(member=>{
        const key=['year','month','day'].find(key=>new RegExp(`\\b${key}\\b`,'i').test(member.part));
        return parts?.[key];
      });
      if(values.some(v=>v==null)) return {ok:false,reason:'Date does not establish every named segment'};
      for(let i=0;i<members.length;i++) {
        const input=page.locator(members[i].selector);
        await input.focus({timeout:2000});
        await page.keyboard.press('Control+A');
        await page.keyboard.type(values[i],{delay:60});
      }
      await page.keyboard.press('Tab');
      await page.waitForTimeout(400);
      const settled=await Promise.all(members.map(member=>page.locator(member.selector).inputValue({timeout:2000})));
      return {ok:settled.every((v,i)=>Number(v)===Number(values[i]) && v.trim()!=='')};
    }
    if(target.type==='radio' || target.type==='checkbox-group') {
      const matches=members.filter(member=>norm(member.label)===norm(value) || norm(member.value)===norm(value));
      if(matches.length!==1) return {ok:false,reason:'No unique exact choice in this field'};
      const input=page.locator(matches[0].selector);
      if(await input.isChecked()) return {ok:true};
      const elementId=await input.getAttribute('id');
      const labels=input.locator('xpath=ancestor::label[1]');
      // Workday hides native radios behind labels; use only this input's own label.
      const label=elementId ? page.locator(`label[for=${JSON.stringify(elementId)}]`) : labels;
      if(label && await label.count()===1) await label.click({timeout:2000});
      else await input.click({timeout:2000});
      await page.waitForTimeout(300);
      return {ok:await input.isChecked()};
    }
    if(target.type!=='combobox' || members.length!==1) return {ok:false,reason:'Unsupported trusted-input field'};
    const input=page.locator(members[0].selector);
    await input.scrollIntoViewIfNeeded({timeout:2000});
    const box=await input.boundingBox();
    if(!box) return {ok:false,reason:'The field is no longer visible'};
    await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
    await page.waitForTimeout(350);
    const owner=await input.getAttribute('aria-controls') || await input.getAttribute('aria-owns');
    const menus=owner ? page.locator(`[id=${JSON.stringify(owner)}]:visible`) : page.locator('[role="listbox"]:visible');
    if(await menus.count()!==1) return {ok:false,reason:'No unambiguous menu for this field'};
    const options=menus.locator('[role="option"]');
    const matches=[];
    for(let i=0;i<await options.count();i++) if(norm(await options.nth(i).innerText())===norm(value)) matches.push(i);
    if(matches.length!==1) return {ok:false,reason:'No unique exact option; no alternative was selected'};
    await options.nth(matches[0]).click({timeout:2000});
    await page.waitForTimeout(400);
    // The caller verifies committed selection in the extension's isolated world.
    return {ok:true};
  } catch(err) {return {ok:false,reason:String(err.message).slice(0,180)};}
  finally {await page.keyboard.press('Escape').catch(()=>{});}
}

export function verifyTrustedField({id,value,parts}) {
  const ns=window.__formwork;
  const schema=ns?._last?.scraped?.schema || window.__wdSchema;
  const registry=ns?._last?.scraped?.registry || window.__wdRegistry;
  const index=schema?.fields.findIndex(field=>field.id===id), field=schema?.fields[index], elements=registry?.[index];
  if(!field || !elements?.length || elements.some(el=>!el.isConnected)) return false;
  if(!ns.verifyValue(elements,field,value)) return false;
  const norm=text=>String(text).trim().replace(/\s+/g,' ').toLowerCase();
  let ok=false;
  if(field.type==='combobox') ok=norm(ns.readComboboxValue(elements[0]))===norm(value);
  if(field.type==='radio' || field.type==='checkbox-group') {
    const checked=elements.filter(el=>el.checked);
    ok=checked.length===1 && (norm(ns.labelFor(checked[0]))===norm(value) || norm(checked[0].value)===norm(value));
  }
  if(field.type==='date') ok=elements.every((el,i)=>{
    const label=el.getAttribute('aria-label') || field.parts?.[i] || '';
    const key=['year','month','day'].find(key=>new RegExp(`\\b${key}\\b`,'i').test(label));
    return parts?.[key]!=null && el.value.trim()!=='' && Number(el.value)===Number(parts[key]);
  });
  if(ok && ns._last?.report) {
    ns._last.report.failed=(ns._last.report.failed || []).filter(f=>(f.id || f)!==id);
    if(!ns._last.report.filled.includes(id)) ns._last.report.filled.push(id);
    ns.markField?.(elements[0],'filled');
    ns.refreshLocalReport?.();
  }
  return ok;
}
