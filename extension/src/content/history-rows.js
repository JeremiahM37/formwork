/** Add saved resume records to explicitly identified inline history editors.
 * Only editor-local Update buttons are used. Never clicks a form submission.
 */
(function () {
  'use strict';
  const ns = window.__formwork = window.__formwork || {};
  // Preserve unresolved UI actions across reinjection in this document.
  const pendingWorkdayRows = ns._pendingWorkdayRows ||= new Map();
  const norm = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const waitFor = async predicate => {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const found = predicate();
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return null;
  };
  const kinds = [
    { kind: 'education', button: 'Add Education', keys: ['school', 'degree'], required: ['school'] },
    { kind: 'experience', button: 'Add Experience', keys: ['employer', 'title'], required: ['employer', 'title'] },
  ];
  const nameFor = key => key === 'employer' ? 'company' : key;
  const rowsIn = root => [...root.querySelectorAll('li > [data-ui="group"]')];
  const matches = (row, record, keys) => keys.every(key =>
    norm(row.querySelector(`[data-ui="${nameFor(key)}"]`)?.textContent) === norm(record[key]));
  const hasEdits = editor => [...editor.querySelectorAll('input, textarea, select')].some(input => {
    if (input.type === 'hidden' || input.disabled) return false;
    if (['checkbox', 'radio'].includes(input.type)) return input.checked;
    return Boolean(String(input.value || '').trim());
  });

  async function openWorkdayRows(send) {
    if(!document.querySelector('[data-automation-id="workExperienceSection"], [data-automation-id="educationSection"], [data-automation-id="languagesSection"], [data-automation-id="company"]'))return [];
    const records=await send('historyRecords',{});
    if(!records||records.error)return [records?.error||'Could not read saved history.'];
    const issues=[];
    for(const [kind,section,identity,heading] of [
      ['experience','workExperienceSection','company','Work Experience'],
      ['education','educationSection','school','Education'],
      ['languages','languagesSection','language','Languages']]) {
      let root=document.querySelector(`[data-automation-id="${section}"]`);
      if(!root){
        const title=[...document.querySelectorAll('h2,h3,h4')].find(n=>norm(n.textContent)===norm(heading));
        for(let node=title?.parentElement;node&&!/^(FORM|MAIN|BODY|HTML)$/.test(node.tagName);node=node.parentElement){
          if([...node.querySelectorAll('button')].some(b=>/^add(?: another)?$/i.test(b.textContent.trim()))){root=node;break;}
        }
      }
      if(!root)continue;
      const entries=records[kind]||[];
      if(kind==='languages'&&!entries.length)issues.push('Languages: save your spoken languages and proficiency levels in your profile; programming skills are not spoken languages.');
      const count=()=>[...root.querySelectorAll(`[data-automation-id="${identity}"]`)].filter(n=>n.matches('input,button,select,[role="combobox"]')).length;
      const pending=pendingWorkdayRows.get(kind);
      if(pending) {
        if(count()<=pending.before) {
          issues.push(`${heading}: the earlier Add action is still unconfirmed. Wait for the entry or reload the page before retrying.`);
          continue;
        }
        pendingWorkdayRows.delete(kind);
      }
      for(let n=count();n<entries.length;n++){
        const buttons=[...root.querySelectorAll('button')].filter(b=>b.type==='button'&&!b.disabled&&/^add(?: another)?$/i.test(b.textContent.trim()));
        if(buttons.length!==1){issues.push(`${heading}: open an entry with Add, then retry filling.`);break;}
        pendingWorkdayRows.set(kind,{before:n});
        buttons[0].click();
        if(!await waitFor(()=>root.isConnected && count()>n)){issues.push(`${heading}: the new entry was not confirmed. Wait for it or reload before retrying.`);break;}
        pendingWorkdayRows.delete(kind);
      }
    }
    return issues;
  }

  ns.fillHistory = async send => {
    const report = { saved: 0, existing: 0, issues: [] };
    if (ns._historyRunning) return { ...report, issues: ['History filling is already running.'] };
    // Claim ownership before the first profile read or Workday Add click.
    // Two callers can otherwise both see a missing row while it is mounting.
    ns._historyRunning = true;
    try {
      const protectedEditors = new WeakSet();
      ns.historyEditorProtected = element => protectedEditors.has(element?.closest('[data-ui="editor"]'));
      const supported = kinds.map(spec => ({ ...spec, roots: [...document.querySelectorAll(`[data-ui="${spec.kind}"]`)]
        .filter(root => root.querySelector(`button[type="button"][data-ui="add-section"][aria-label="${spec.button}"]`)) }))
        .filter(spec => spec.roots.length === 1);
      report.issues.push(...await openWorkdayRows(send));
      if (!supported.length) return report;
      const records = await send('historyRecords', {});
      if (!records || records.error) return { ...report, issues: [records?.error || 'Could not read saved history.'] };
      for (const spec of supported) {
        const root = spec.roots[0], entries = records[spec.kind] || [];
        for (const record of entries) {
          const title = spec.keys.map(key => record[key]).filter(Boolean).join(' — ') || spec.kind;
          if (spec.required.some(key => !norm(record[key]))) {
            report.issues.push(`${title}: saved history needs ${spec.required.join(' and ')}.`);
            continue;
          }
          if (entries.filter(other => spec.keys.every(key => norm(other[key]) === norm(record[key]))).length !== 1) {
            report.issues.push(`${title}: multiple saved records share this identity; add these entries manually.`);
            continue;
          }
          const existing = rowsIn(root).filter(row => matches(row, record, spec.keys));
          if (existing.length) {
            report.existing++;
            if (existing.length > 1) report.issues.push(`${title}: the form already contains multiple matching entries.`);
            continue;
          }
          if (!root.isConnected) { report.issues.push('The page replaced its history section.'); break; }
          let editor = root.querySelector('[data-ui="editor"]');
          if (editor && hasEdits(editor)) {
            protectedEditors.add(editor);
            report.issues.push(`${spec.kind}: finish or cancel the open edit before adding more records.`);
            break;
          }
          if (!editor) {
            const add = root.querySelector(`button[type="button"][data-ui="add-section"][aria-label="${spec.button}"]`);
            if (!add || add.disabled) { report.issues.push(`${title}: the add-entry control is unavailable.`); break; }
            add.click();
            editor = await waitFor(() => root.querySelector('[data-ui="editor"]'));
          }
          if (!editor) { report.issues.push(`${title}: the history editor did not open.`); break; }
          // Keep incomplete or rejected history out of the later general AI fill.
          protectedEditors.add(editor);
          const scraped = ns.scrape();
          const indexes = scraped.schema.fields.map((field, index) => ({ field, index }))
            .filter(({ field, index }) => field.history?.kind === spec.kind && editor.contains(scraped.registry[index]?.[0]));
          const schema = { ...scraped.schema, fields: indexes.map(({ field }) => ({ ...field,
            history: { ...field.history, index: record.index } })) };
          const registry = indexes.map(({ index }) => scraped.registry[index]);
          if (!schema.fields.length) { report.issues.push(`${title}: unrecognized history editor.`); break; }
          const plan = await send('historyPlan', { schema });
          if (!plan || plan.error) { report.issues.push(`${title}: ${plan?.error || 'could not read history values'}`); break; }
          for (const field of schema.fields) {
            const key = field.history.key;
            if (['start', 'end'].includes(key) && record[key] &&
                !(key === 'end' && record.current === true) && !plan.fills[field.id]) {
              report.issues.push(`${title} — ${field.label}: saved date cannot be transcribed at the precision this control requires.`);
            }
          }
          const result = await ns.fill(plan.fills, schema, registry, { keepExisting: true });
          const missing = (plan.missingRequired || []).filter(field => !result.filled.includes(field.id));
          if (result.failed.length || missing.length || editor.querySelector('[aria-invalid="true"]')) {
            report.issues.push(`${title}: some fields need attention; the open entry was not saved.`);
            break;
          }
          const save = editor.querySelector('button[type="button"][data-ui="save-section"]');
          if (!save || save.disabled) { report.issues.push(`${title}: the entry Update control is unavailable.`); break; }
          save.click();
          const saved = await waitFor(() => root.isConnected && !editor.isConnected &&
            rowsIn(root).find(row => matches(row, record, spec.keys)));
          if (!saved) { report.issues.push(`${title}: the page did not confirm the saved entry.`); break; }
          report.saved++;
          for (const item of plan.review || []) report.issues.push(`${title} — ${item.label}: ${item.reason}`);
        }
      }
      return report;
    } catch (error) {
      report.issues.push(String(error.message || error));
      return report;
    } finally {
      ns._historyRunning = false;
    }
  };
})();
