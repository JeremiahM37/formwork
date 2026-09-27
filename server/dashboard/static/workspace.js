/* The job-search workspace. All writes are explicit user actions; no sending. */
"use strict";
let workspaceFilter = {search: "", stage: ""};
let workspaceGeneration = 0;
let pipelineMode = localStorage.getItem("formworkPipelineMode") || "list";
const comparisonIds = new Set();

function workspaceField(label, type = "text", value = "") {
  const input = el(type === "textarea" ? "textarea" : "input", {value, ...(type === "textarea" ? {rows: 3} : {type})});
  const node = el("label", {className: "field"}, el("span", {textContent: label}), input);
  return {input, node};
}

function workspaceButton(label, fn) {
  return el("button", {className: "sm", textContent: label,
    onclick: event => busy(event.currentTarget, "saving…", fn)});
}

function workspaceForm(title, fields, action, fn) {
  const form = el("form", {className: "card"}, el("h3", {textContent: title}), ...fields.map(f => f.node));
  const submit = el("button", {type: "submit", textContent: action, className: "primary sm"});
  form.append(submit);
  form.onsubmit = event => {event.preventDefault(); busy(submit, "saving…", fn);};
  return form;
}

async function renderWorkspace() {
  const generation = ++workspaceGeneration;
  const [pipeline, tracked, analytics, network, saved, compensation] = await Promise.all([
    api("/api/applications"), api("/api/tracking"), api("/api/analytics"), api("/api/contacts"), api("/api/views"), api("/api/offers")]);
  if (generation !== workspaceGeneration) return;
  const root = $("workspaceBody");
  root.replaceChildren();
  renderInbox(root,pipeline.applications).catch(err=>toast(err.message,"bad"));
  root.append(el("div", {className: "stats"},
    stat(analytics.submitted, "sent"), stat(analytics.responses, "responses"),
    stat(analytics.responseRate == null ? "—" : `${analytics.responseRate}%`, "recorded response rate"),
    stat(analytics.overdue, "follow-ups due", analytics.overdue ? "warn" : "")));
  root.append(el("p", {className: "small muted", textContent: analytics.note}));
  const insights=el("details",{},el("summary",{textContent:"Pipeline insights"}));
  insights.append(el("p",{textContent:analytics.medianResponseDays == null ? "Response timing: not enough recorded dates" : `Median recorded response: ${analytics.medianResponseDays} days (${analytics.timedResponses} timed responses)`}));
  for (const [heading,items] of [["Current stages",Object.entries(analytics.stages).filter(([,n])=>n).map(([name,n])=>`${name}: ${n}`)],
      ["Sources",(analytics.sources||[]).map(v=>`${v.source}: ${v.saved} saved · ${v.submitted} sent · ${v.responses} responses`)],
      ["Monthly application cohorts",(analytics.cohorts||[]).map(v=>`${v.month}: ${v.submitted} sent · ${v.responses} responses`)],
      ["Recorded stage changes",(analytics.transitions||[]).map(v=>`${v.from} → ${v.to}: ${v.count}`)]]) {
    insights.append(el("h3",{textContent:heading}),el("ul",{},...items.map(text=>el("li",{textContent:text}))));
  }
  root.append(insights);
  const digestOutput=el("textarea",{readOnly:true,rows:9,ariaLabel:"Search digest",hidden:true});
  root.append(workspaceButton("Prepare weekly digest",async()=>{
    digestOutput.value=(await api("/api/digest")).text;digestOutput.hidden=false;
    digestOutput.focus();digestOutput.select();
  }),digestOutput);

  root.append(el("div", {className: "row wrap"},
    el("a", {href: "/api/export/applications.csv", textContent: "Export applications (CSV)"}),
    el("a", {href: "/api/calendar.ics", textContent: "Export interview calendar"})));

  const url = workspaceField("Posting URL", "url"), company = workspaceField("Company"),
    title = workspaceField("Job title"), description = workspaceField("Paste job description", "textarea");
  url.input.required = true;
  root.append(el("details", {}, el("summary", {textContent: "Add a job from its URL"}),
    workspaceForm("Save a posting", [url, company, title, description], "Save job", async () => {
      await api("/api/applications", {method: "POST", body: {url: url.input.value, company: company.input.value,
        title: title.input.value, description: description.input.value, source: "manual"}});
      await renderWorkspace(); await refreshState(); toast("Job saved.");
    })));

  root.append(el("h2", {textContent: "Pipeline"}));
  const search = workspaceField("Search applications", "search", workspaceFilter.search);
  const stage = el("select", {ariaLabel: "Filter by stage"}, el("option", {value: "", textContent: "All stages"}),
    ...tracked.stages.map(s => el("option", {value: s, textContent: s, selected: s === workspaceFilter.stage})));
  const list = el("div", {id: "pipelineList"});
  const detail = el("div", {id: "pipelineDetail"});
  function draw() {
    workspaceFilter = {search: search.input.value, stage: stage.value};
    const needle = search.input.value.toLowerCase();
    list.replaceChildren();
    list.className=pipelineMode === "board" ? "pipeline-board" : "";
    const columns={};
    if(pipelineMode === "board") for(const name of tracked.stages.filter(s=>!stage.value || s===stage.value)) {
      const column=el("section",{className:"pipeline-column",ariaLabel:`${name} stage`},el("h3",{textContent:name}));
      columns[name]=column;list.append(column);
      if(name!=="filling") {
        column.ondragover=e=>e.preventDefault();
        column.ondrop=async e=>{
          e.preventDefault();const id=Number(e.dataTransfer.getData("application/x-formwork-id"));
          const record=pipeline.applications.find(r=>r.id===id);
          if(!record || record.status==="filling" || record.status===name)return;
          try {await api(`/api/applications/${id}/status`,{method:"POST",body:{status:name,note:record.note}});await renderWorkspace();await refreshState();}
          catch(err){toast(err.message,"bad");}
        };
      }
    }
    for (const record of pipeline.applications.filter(a => (!stage.value || a.status === stage.value) &&
      `${a.company} ${a.title} ${a.note}`.toLowerCase().includes(needle))) {
      const compare = el("input", {type: "checkbox", checked: comparisonIds.has(record.id), ariaLabel: `Compare ${record.company} ${record.title}`});
      compare.onchange = () => {
        if (compare.checked && comparisonIds.size >= 20) {compare.checked = false; toast("Select up to twenty jobs at a time."); return;}
        if (compare.checked) comparisonIds.add(record.id); else comparisonIds.delete(record.id);
      };
      const row=el("div", {className: "card row wrap",draggable:record.status!=="filling"}, compare,
        el("div", {className: "grow", textContent: `${record.company} · ${record.title || record.url}`}),
        el("span", {className: "chip", textContent: record.status}),
        workspaceButton("Details", () => renderApplicationDetails(record.id, detail, tracked.stages)));
      row.ondragstart=e=>e.dataTransfer.setData("application/x-formwork-id",String(record.id));
      (columns[record.status] || list).append(row);
    }
    if (!list.childNodes.length) list.append(el("p", {className: "muted", textContent: "No applications match these filters."}));
  }
  search.input.oninput = draw; stage.onchange = draw;
  const viewSelect = el("select", {ariaLabel: "Saved views"}, el("option", {value: "", textContent: "Saved views…"}),
    ...saved.views.map(v => el("option", {value: v.id, textContent: v.name})));
  viewSelect.onchange = () => {
    const view = saved.views.find(v => String(v.id) === viewSelect.value);
    if (view) {search.input.value = view.filters.search || ""; stage.value = view.filters.stage || ""; draw();}
  };
  const viewName = workspaceField("View name");
  const mode=el("select",{ariaLabel:"Pipeline layout"},...[["list","List"],["board","Board"]].map(([value,textContent])=>el("option",{value,textContent,selected:pipelineMode===value})));
  mode.onchange=()=>{pipelineMode=mode.value;localStorage.setItem("formworkPipelineMode",pipelineMode);draw();};
  root.append(el("div", {className: "pipeline-filters"}, search.node, stage, viewSelect,mode,
    workspaceButton("Compare selected jobs", async () => {
      if (comparisonIds.size < 2 || comparisonIds.size > 3) {toast("Select two or three jobs to compare."); return;}
      const selected = await Promise.all([...comparisonIds].map(id => api(`/api/applications/${id}`)));
      detail.replaceChildren(el("h2", {textContent: "Job comparison"}),
        ...selected.map(a => el("div", {className: "card"}, el("h3", {textContent: `${a.company} · ${a.title}`}),
          el("p", {textContent: `Stage: ${a.status}. Recognized skill coverage: ${a.fit.coverage == null ? 'unknown' : a.fit.coverage + '%'}.`}),
          el("p", {textContent: `Evidenced: ${a.fit.matched.map(m => m.skill).join(', ') || 'none found'}`}),
          el("p", {textContent: `Not evidenced: ${a.fit.missing.map(m => m.skill).join(', ') || 'none recognized'}`}))));
      detail.scrollIntoView({block: "start"});
    }), workspaceButton("Prepare selected jobs", async () => {
      if (!comparisonIds.size) {toast("Select queued or failed jobs to prepare."); return;}
      const result = await api("/api/prepare-batch", {method:"POST", body:{ids:[...comparisonIds]}});
      comparisonIds.clear(); await refreshState(); await renderWorkspace();
      toast(`${result.started.length} applications queued for preparation. Review each before submitting.`);
    })),
    el("details", {}, el("summary", {textContent: "Save these filters"}), viewName.node,
      workspaceButton("Save view", async () => {await api("/api/views", {method: "POST", body: {name: viewName.input.value, filters: workspaceFilter}}); await renderWorkspace();})), list, detail);
  draw();

  root.append(el("h2", {textContent: "Follow-ups"}));
  const reminders = tracked.reminders.filter(r => !r.done);
  if (!reminders.length) root.append(el("p", {className: "muted", textContent: "No pending reminders. Add one from an application's details."}));
  for (const item of reminders) root.append(el("div", {className: "card row wrap"},
    el("div", {className: "grow", textContent: `${item.company}: ${item.text} · ${new Date(item.due_at * 1000).toLocaleString()}`}),
    workspaceButton("Complete reminder", async () => {await api(`/api/reminders/${item.id}/complete`, {method: "POST"}); await renderWorkspace();})));

  root.append(el("h2", {textContent: "Interview agenda"}));
  renderCalendar(root, pipeline.applications);
  if (!tracked.interviews.length) root.append(el("p", {className: "muted", textContent: "No interviews recorded. Schedule one from an application's details."}));
  for (const item of tracked.interviews) {
    const outcome = el("select", {ariaLabel: `Outcome for ${item.company} ${item.kind}`},
      ...["scheduled", "completed", "passed", "rejected", "cancelled"].map(s => el("option", {value: s, textContent: s, selected: s === item.outcome})));
    root.append(el("div", {className: "card"},
      el("div", {textContent: `${new Date(item.starts_at * 1000).toLocaleString()} · ${item.company} · ${item.kind}`}),
      el("p", {className: "small muted", textContent: `${item.minutes} minutes · ${item.interviewer} · ${item.location}`}),
      el("div", {className: "row wrap"}, outcome, workspaceButton("Save outcome", async () => {
        await api(`/api/interviews/${item.id}`, {method: "PUT", body: {...item, outcome: outcome.value}});
        await renderWorkspace(); toast("Interview outcome saved.");
      }), workspaceButton("Export to Google Calendar", async () => {
        if (!confirm("Create or update your personal Google Calendar event for this interview?")) return;
        await api(`/api/calendar/google/interviews/${item.id}/export`, {method:"POST"});
        toast("Interview exported to Google Calendar.");
      }))));
  }

  root.append(el("h2", {textContent: "Contacts & referrals"}));
  const name = workspaceField("Contact name"), org = workspaceField("Contact company"), email = workspaceField("Contact email", "email"),
    role = workspaceField("Contact role"), notes = workspaceField("Contact notes", "textarea");
  name.input.required = true;
  root.append(el("details", {}, el("summary", {textContent: "Add a contact"}),
    workspaceForm("Contact", [name, org, email, role, notes], "Save contact", async () => {
      await api("/api/contacts", {method: "POST", body: {name: name.input.value, company: org.input.value,
        email: email.input.value, role: role.input.value, notes: notes.input.value}});
      await renderWorkspace();
    })));
  for (const person of network.contacts) {
    const interaction = workspaceField(`Interaction with ${person.name}`, "textarea");
    const linked = el("select", {ariaLabel: "Link interaction to application"}, el("option", {value: "", textContent: "No linked application"}),
      ...pipeline.applications.map(a => el("option", {value: a.id, textContent: `${a.company} · ${a.title}`})));
    root.append(el("details", {className: "card"}, el("summary", {textContent: `${person.name} · ${person.company}`}),
      el("p", {textContent: `${person.role} · ${person.email}`}), el("p", {textContent: person.notes}),
      ...network.interactions.filter(i => i.contact_id === person.id).map(i => el("p", {className: "small", textContent: `${new Date(i.created_at * 1000).toLocaleDateString()}: ${i.text}`})),
      interaction.node, linked, workspaceButton("Log interaction", async () => {
        await api(`/api/contacts/${person.id}/interactions`, {method: "POST", body: {text: interaction.input.value,
          application_id: linked.value ? Number(linked.value) : null}}); await renderWorkspace();
      })));
  }
  root.append(el("h2", {textContent: "Offer comparison"}), el("p", {className: "small muted", textContent: compensation.note}));
  if (!compensation.offers.length) root.append(el("p", {textContent: "Add offer amounts from an application's details."}));
  for (const offer of compensation.offers) root.append(el("div", {className: "card"},
    el("h3", {textContent: offer.company}), el("p", {textContent: `${offer.currency} ${offer.recurring.toLocaleString()} recurring · ${offer.first_year.toLocaleString()} first year`}),
    el("p", {className: "small muted", textContent: `Base ${offer.base.toLocaleString()} + bonus ${offer.bonus.toLocaleString()} + annual equity ${offer.equity.toLocaleString()} + benefits ${offer.benefits.toLocaleString()} − costs ${offer.annual_costs.toLocaleString()}. ${offer.notes}`})));
}

async function renderApplicationDetails(id, holder, stages) {
  const [record, timeline] = await Promise.all([api(`/api/applications/${id}`), api(`/api/applications/${id}/timeline`)]);
  holder.replaceChildren();
  const card = el("div", {className: "card", tabIndex: -1}, el("h2", {textContent: `${record.company} · ${record.title}`}));
  const stage = el("select", {ariaLabel: "Application stage"},
    ...stages.filter(s => s !== "filling").map(s => el("option", {value: s, textContent: s, selected: s === record.status})));
  card.append(el("div", {className: "row wrap"}, stage, workspaceButton("Update stage", async () => {
    await api(`/api/applications/${id}/status`, {method: "POST", body: {status: stage.value, note: record.note}});
    await renderWorkspace(); await refreshState();
  }), workspaceButton("Open form review", () => openReview(id))));
  card.append(el("a",{href:`/api/applications/${id}/handoff.md`,textContent:"Download preparation handoff"}));
  const resumes = (await api("/api/resumes")).versions;
  if (resumes.length) {
    const select = el("select", {ariaLabel: "Resume for this application"}, el("option", {value: "", textContent: "Choose a resume version…"}),
      ...resumes.map(r => el("option", {value: r.id, textContent: r.name, selected: r.id === record.snapshot.resumeVersion})));
    card.append(el("div", {className: "row wrap"}, select, workspaceButton("Use resume on next preparation", async () => {
      const result = await api(`/api/applications/${id}/resume-version`, {method: "POST", body: {version_id: Number(select.value)}});
      toast(result.note);
    })));
  }
  if (resumes.length >= 2) {
    const choices=el("div",{className:"row wrap"});
    const selected=new Set();
    for (const version of resumes) {
      const input=el("input",{type:"checkbox",ariaLabel:`Compare resume ${version.name}`});
      input.onchange=()=>input.checked ? selected.add(version.id) : selected.delete(version.id);
      choices.append(el("label",{},input,document.createTextNode(version.name)));
    }
    const output=el("div",{role:"status"});
    card.append(el("details",{},el("summary",{textContent:"Compare saved resumes for this job"}),choices,
      workspaceButton("Compare resume evidence",async()=>{
        if(selected.size<2 || selected.size>10) {toast("Choose between two and ten resume versions.");return;}
        const result=await api(`/api/applications/${id}/compare-resumes`,{method:"POST",body:{version_ids:[...selected]}});
        output.replaceChildren(el("p",{className:"small muted",textContent:result.note}),...result.versions.map(v=>el("div",{className:"card"},
          el("h4",{textContent:`${v.name}: ${v.fit.coverage == null ? "unknown" : v.fit.coverage+"%"}`}),
          el("p",{textContent:`Evidenced: ${v.fit.matched.map(m=>m.skill).join(", ") || "none recognized"}`}),
          el("p",{textContent:`Not evidenced: ${v.fit.missing.map(m=>m.skill).join(", ") || "none recognized"}`}))));
      }),output));
  }
  const fit = record.fit;
  card.append(el("h3", {textContent: fit.coverage == null ? "Skill coverage unknown" : `${fit.coverage}% of recognized skills evidenced`}),
    el("p", {className: "small muted", textContent: fit.explanation}));
  for (const match of fit.matched) card.append(el("details", {}, el("summary", {textContent: `Evidenced: ${match.skill}`}),
    el("p", {textContent: match.evidence}), el("p", {className: "small muted", textContent: `Posting: ${match.posting}`})));
  for (const missing of fit.missing) card.append(el("details", {}, el("summary", {textContent: `Not evidenced: ${missing.skill}`}),
    el("p", {textContent: missing.posting})));
  const analysis = el("div");
  const renderAnalysis = result => {
    analysis.replaceChildren(el("p", {className:"small muted", textContent:result.note}),
      ...result.requirements.map(r => el("details", {}, el("summary", {textContent:`${r.assessment} · ${r.importance}: ${r.requirement}`}),
        el("p", {textContent:r.evidence || "No verified candidate evidence returned."}))));
  };
  if (record.snapshot.fitAnalysis) renderAnalysis(record.snapshot.fitAnalysis);
  card.append(workspaceButton("Analyze role requirements", async () => {
    renderAnalysis(await api(`/api/applications/${id}/analyze-fit`, {method:"POST"}));
  }), analysis);
  card.append(await careerPanel(id));
  const currency = workspaceField("Offer currency", "text", "USD");
  const offerInputs = [["base", "Annual base salary"], ["bonus", "Expected annual bonus"], ["equity", "Estimated annual vested equity"],
    ["benefits", "Annual benefits value"], ["annual_costs", "Annual additional costs"], ["signing", "One-time signing bonus"]].map(([key, label]) => ({key, ...workspaceField(label, "number", "0")}));
  for (const f of offerInputs) {f.input.min = 0; f.input.step = "any";}
  card.append(el("details", {}, el("summary", {textContent: "Record offer amounts"}),
    workspaceForm("Offer", [currency, ...offerInputs], "Save offer", async () => {
      await api(`/api/applications/${id}/offer`, {method: "PUT", body: {currency: currency.input.value.toUpperCase(),
        ...Object.fromEntries(offerInputs.map(f => [f.key, Number(f.input.value)]))}}); await renderWorkspace();
    })));
  const note = workspaceField("Timeline note", "textarea");
  card.append(workspaceForm("Add note", [note], "Save note", async () => {
    await api(`/api/applications/${id}/notes`, {method: "POST", body: {text: note.input.value}});
    await renderApplicationDetails(id, holder, stages);
  }));
  const due = workspaceField("Remind me at", "datetime-local"), reminder = workspaceField("Follow-up reminder");
  due.input.required = true; reminder.input.required = true;
  card.append(el("details", {}, el("summary", {textContent: "Set follow-up reminder"}),
    workspaceForm("Reminder", [due, reminder], "Add reminder", async () => {
      await api(`/api/applications/${id}/reminders`, {method: "POST", body: {due_at: new Date(due.input.value).getTime()/1000, text: reminder.input.value}});
      await renderWorkspace();
    })));
  const date = workspaceField("Interview date and time", "datetime-local"), kind = workspaceField("Interview round", "text", "Technical interview"),
    duration = workspaceField("Duration in minutes", "number", "60"), person = workspaceField("Interviewer"), location = workspaceField("Meeting location or URL");
  date.input.required = true; duration.input.min = 5; duration.input.max = 1440;
  card.append(el("details", {}, el("summary", {textContent: "Schedule interview"}),
    workspaceForm("Interview", [date, kind, duration, person, location], "Add interview", async () => {
      await api(`/api/applications/${id}/interviews`, {method: "POST", body: {starts_at: new Date(date.input.value).getTime()/1000,
        kind: kind.input.value, minutes: Number(duration.input.value), interviewer: person.input.value, location: location.input.value}});
      await renderWorkspace();
    })));
  card.append(el("h3", {textContent: "Timeline"}), ...timeline.events.map(e => el("p", {className: "small",
    textContent: `${new Date(e.created_at * 1000).toLocaleString()} · ${e.text}`})));
  holder.append(card); card.focus();
}

async function careerPanel(id) {
  const saved = await api(`/api/applications/${id}/drafts`);
  const task = el("select", {ariaLabel: "Writing task"},
    ...[["interview", "Interview preparation"], ["feedback", "Practice answer feedback"], ["career", "Career next steps"],
      ["followup", "Follow-up message"], ["outreach", "Networking message"]].map(([value, textContent]) => el("option", {value, textContent})));
  const instruction = workspaceField("What should the draft focus on?", "textarea");
  const answer = workspaceField("Your practice answer (for feedback)", "textarea");
  const output = el("textarea", {rows: 10, ariaLabel: "Prepared draft"});
  const status = el("p", {className: "small muted", textContent: "Drafts use your saved profile, posting and timeline. Review the wording; nothing is sent."});
  const versions = el("select", {ariaLabel: "Saved draft versions"}, el("option", {value: "", textContent: "Earlier drafts…"}),
    ...saved.drafts.map(d => el("option", {value: d.id, textContent: `${d.kind} · ${new Date(d.created_at * 1000).toLocaleString()}`})));
  let history = saved.drafts;
  versions.onchange = () => {const draft = history.find(d => String(d.id) === versions.value); if (draft) output.value = draft.text;};
  const generate = workspaceButton("Prepare draft", async () => {
    const result = await api(`/api/applications/${id}/drafts`, {method: "POST", body: {
      kind: task.value, instruction: instruction.input.value, answer: answer.input.value, previous: output.value}});
    output.value = result.text;
    status.textContent = [`Review before using.`, result.unsupported.length ? `Check names/numbers: ${result.unsupported.join(", ")}.` : "",
      result.tells.length ? `Style flags: ${result.tells.map(t => t.name).join(", ")}.` : "",
      result.lost.length ? `Details removed: ${result.lost.join(", ")}.` : ""].filter(Boolean).join(" ");
    history = (await api(`/api/applications/${id}/drafts`)).drafts;
    versions.replaceChildren(el("option", {value: "", textContent: "Earlier drafts…"}),
      ...history.map(d => el("option", {value: d.id, textContent: `${d.kind} · ${new Date(d.created_at * 1000).toLocaleString()}`})));
  });
  return el("details", {}, el("summary", {textContent: "Interview prep & correspondence"}),
    el("div", {className: "card"}, task, instruction.node, answer.node,
      el("div", {className: "row wrap"}, generate, versions), status, output,
      workspaceButton("Copy draft", async () => {
        try {await navigator.clipboard.writeText(output.value); toast("Draft copied.");}
        catch {output.focus(); output.select(); toast("Draft selected; use Copy in your browser.");}
      })));
}

async function renderResumeStudio() {
  const result = await api("/api/resumes");
  const holder = $("resumeStudio"); holder.replaceChildren();
  const name = workspaceField("Resume version name");
  const content = workspaceField("Resume version text", "textarea"); content.input.rows = 14;
  const format = el("select", {ariaLabel: "Resume source format"}, el("option", {value: "text", textContent: "Plain text"}),
    el("option", {value: "tex", textContent: "LaTeX"}));
  const upload = el("input", {type: "file", accept: ".pdf,.docx,.txt,.md,.tex", ariaLabel: "Import resume document"});
  const note = el("p", {className: "small muted", textContent: "Import PDF, DOCX, text or LaTeX; review the extracted text, then save a version. Each saved version is kept separately."});
  upload.onchange = async () => {
    const file = upload.files[0]; if (!file) return;
    if (file.size > 10 * 1024 * 1024) {toast("Use a file smaller than 10 MB.", "bad"); return;}
    try {
      note.textContent = "Reading document…";
      const data = await new Promise((resolve, reject) => {const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file);});
      const imported = await api("/api/resumes/import", {method: "POST", body: {name: file.name, data}});
      content.input.value = imported.text; name.input.value = file.name; format.value = imported.format; note.textContent = imported.note;
    } catch (err) {note.textContent = err.message; toast(err.message, "bad");}
  };
  const versions = el("div");
  const extraction = el("div");
  const extractButton = workspaceButton("Extract career fields for autofill", async () => {
    const proposed = await api("/api/resumes/extract-profile", {method:"POST", body:{text:content.input.value, format:format.value}});
    const candidate = (await api("/api/profile")).profile;
    extraction.replaceChildren(el("p", {textContent:proposed.note}));
    const selections = [];
    for (const [section, value] of Object.entries(proposed.sections)) {
      const choose = el("input", {type:"checkbox", ariaLabel:`Replace ${section} from resume`});
      const edited = workspaceField(`Proposed ${section} JSON`, "textarea", JSON.stringify(value,null,2));
      edited.input.rows = 10;
      selections.push({section, choose, edited});
      extraction.append(el("div", {className:"card"},
        el("label", {className:"row"}, choose, el("span", {textContent:`Replace ${section} with these reviewed fields`})),
        el("details", {}, el("summary", {textContent:`Current ${section}`}), el("pre", {textContent:JSON.stringify(candidate[section] || [],null,2)})),
        el("details", {}, el("summary", {textContent:`Source for ${section}`}), el("pre", {textContent:proposed.evidence[section].join("\n\n")})), edited.node));
    }
    if (proposed.rejected.length) extraction.append(el("p", {className:"small", textContent:proposed.rejected.join("; ")}));
    extraction.append(workspaceButton("Save reviewed fields to profile", async () => {
      const chosen = selections.filter(s=>s.choose.checked);
      if (!chosen.length) {toast("Select the sections you have reviewed."); return;}
      const profile = (await api("/api/profile")).profile;
      for (const item of chosen) profile[item.section] = JSON.parse(item.edited.input.value);
      const result = await api("/api/profile", {method:"POST", body:{text:JSON.stringify(profile)}});
      toast(result.synced ? "Reviewed fields saved and verified in the extension." : "Profile saved; extension sync needs retry.", result.synced ? "" : "warn");
      extraction.replaceChildren(el("p", {textContent:result.synced ? "Profile and extension updated." : "Profile saved. Retry extension sync in Settings."}));
    }));
  });
  for (const version of result.versions) versions.append(el("div", {className: "row wrap card tight"},
    el("span", {className: "grow", textContent: `${version.name} · ${new Date(version.created_at * 1000).toLocaleString()}`}),
    workspaceButton("Edit as new version", async () => {
      const saved = await api(`/api/resumes/${version.id}`);
      if (saved.format === "structured") {resumeBuilderName=saved.name;openResumeBuilder(saved.text);return;}
      name.input.value = saved.name; content.input.value = saved.text; format.value = saved.format;
    }), el("a", {href: `/api/resumes/${version.id}/export.docx`, textContent: "DOCX"}),
    el("a", {href: `/api/resumes/${version.id}/export.pdf`, textContent: "PDF"})));
  holder.append(el("div", {id:"resumeBuilder"}), el("h2", {textContent: "Resume versions"}), upload, note, name.node, format, content.node,
    workspaceButton("Save new resume version", async () => {
      await api("/api/resumes", {method: "POST", body: {name: name.input.value, text: content.input.value, format: format.value}});
      await renderResumeStudio(); toast("Resume version saved. Choose it in an application's details.");
    }), el("details", {}, el("summary", {textContent:"Use this resume to update autofill"}),
      el("p", {className:"small muted", textContent:"Extracts career sections through your saved model, starting at an Experience, Education, Projects or Skills heading. Contact details above that heading are excluded. Review source quotes and select each section before replacing existing profile fields."}),
      extractButton, extraction), versions, el("hr"));
  renderResumeBuilder();
}

async function renderProviderSettings() {
  const [config, candidate] = await Promise.all([api("/api/provider"), api("/api/profile")]);
  const holder = $("providerSettings"); holder.replaceChildren();
  const provider = el("select", {ariaLabel: "Drafting provider"}, ...["homelab", "ollama", "openai-compatible", "anthropic"].map(s =>
    el("option", {value: s, textContent: s, selected: s === config.provider})));
  const url = workspaceField("Provider URL", "url", config.url), model = workspaceField("Model name", "text", config.model),
    key = workspaceField(config.hasKey ? "API key (blank keeps existing key at the same endpoint)" : "API key", "password");
  const bridge = workspaceField("Dashboard address reachable from the extension", "url", config.extensionDashboardUrl);
  const connectionStatus = el("p", {role:"status",id:"modelConnectionStatus",className:"small muted"});
  const connect = async testOnly => {
    connectionStatus.textContent = "Testing from inside the extension…";
    try {
      const receipt = await api("/api/provider/extension", {method:"POST",body:{baseUrl:bridge.input.value,testOnly}});
      connectionStatus.replaceChildren(document.createTextNode(receipt.message));
      if (receipt.needsPermission) connectionStatus.append(" ",el("a",{href:"#browser",textContent:"Open Browser to allow access"}));
      if (receipt.ok) connectionStatus.append(` Model replied: ${receipt.reply}`);
    } catch(err) {connectionStatus.textContent = `Connection failed: ${err.message}`;}
  };
  holder.append(el("h2", {textContent: "Drafting model"}), el("p", {className: "small muted",
    textContent: "Save and test your provider here, then connect the extension. Letters, tailoring, interview preparation and form answers can share this model. API keys stay on the server."}),
    provider, url.node, model.node, key.node,
    el("div", {className: "row wrap"}, workspaceButton("Save model", async () => {
      await api("/api/provider", {method: "POST", body: {provider: provider.value, url: url.input.value, model: model.input.value, key: key.input.value}});
      await renderProviderSettings(); toast("Model settings saved.");
    }), workspaceButton("Test saved model", async () => {
      const result = await api("/api/provider/test", {method: "POST"});
      toast(result.ok ? `Model replied: ${result.reply}` : "The model returned an empty reply.", result.ok ? "" : "warn");
    })), el("div",{className:"row wrap"},
      workspaceButton("Connect extension",()=>connect(false)), workspaceButton("Test extension connection",()=>connect(true))),
    connectionStatus,el("details",{},el("summary",{textContent:"Advanced: dashboard connection address"}),bridge.node,
      el("p",{className:"small muted",textContent:"The default is for the dashboard and browser on the same machine or in the same container. Change it only if your browser runs elsewhere; use an address it can reach without a login page."})));
  const profile = workspaceField("Complete profile JSON", "textarea", JSON.stringify(candidate.profile, null, 2));
  profile.input.rows = 18;
  await renderProfileEditor(holder, candidate);
  holder.append(el("details", {}, el("summary", {textContent: "Advanced: complete profile JSON"}), profile.node,
    workspaceButton("Save complete profile", async () => {
      const result = await api("/api/profile", {method: "POST", body: {text: profile.input.value}});
      toast(result.synced ? "Profile saved and synced." : "Saved; extension sync needs retry.", result.synced ? "" : "warn");
      await renderProviderSettings(); await refreshState();
    })), workspaceButton("Retry extension profile sync", async () => {
      const result = await api("/api/profile/sync", {method: "POST"});
      toast(result.synced ? "Extension profile verified." : result.syncError || "Sync failed", result.synced ? "" : "bad");
    }));
}

async function renderJobAlerts() {
  const result = await api("/api/alerts");
  const holder = $("jobAlerts"); holder.replaceChildren();
  const name = workspaceField("Search alert name"), query = workspaceField("Alert keywords (all must match)"),
    minimum = workspaceField("Minimum recognized skill coverage", "number", "0");
  minimum.input.min = 0; minimum.input.max = 100;
  holder.append(el("details", {}, el("summary", {textContent:`Saved search alerts (${result.alerts.length})`}),
    el("p", {className:"small muted", textContent:"Alerts are checked when the queue refreshes. Automatic refresh can be enabled in Settings. Notifications stay here; no email is sent."}),
    ...result.alerts.map(a => el("div", {className:"row wrap"}, el("span", {textContent:`${a.name}: ${a.query} · ${a.min_coverage}% minimum`}),
      workspaceButton("Remove alert",async()=>{await api(`/api/alerts/${a.id}`,{method:"DELETE"});await renderJobAlerts();}))),
    workspaceForm("New saved search",[name,query,minimum],"Save search alert",async()=>{
      await api("/api/alerts",{method:"POST",body:{name:name.input.value,query:query.input.value,min_coverage:Number(minimum.input.value)}});
      await renderJobAlerts();
    })));
  for (const item of result.notifications) holder.append(el("div", {className:"card amber row wrap"},
    el("div", {className:"grow",textContent:`${item.alert}: ${item.company} · ${item.title}`}),
    /^https?:\/\//i.test(item.url) ? el("a",{href:item.url,target:"_blank",rel:"noreferrer",textContent:"Posting"}) : null,
    workspaceButton("Dismiss notification",async()=>{await api(`/api/notifications/${item.id}/acknowledge`,{method:"POST"});await renderJobAlerts();})));
}
