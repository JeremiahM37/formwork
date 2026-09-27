/*
 * formwork dashboard — the client.
 *
 * No build step and no framework, for the same reason the extension has none:
 * the whole thing has to be readable by someone who just cloned it and wants to
 * know what it does to their job applications before they run it.
 */
"use strict";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
};
const esc = (s) => String(s ?? "");

const state = {
  page: "queue",
  settings: {},
  counts: {},
  novnc: "",
  queue: [],
  applications: [],
  current: null, // the application open in Review
  progress: {},
  polling: null,
  navigated: false,
};

// Hosted inside another app's frame — see the embed rules in style.css.
if (new URLSearchParams(location.search).get("embed") === "1") {
  document.body.classList.add("embed");
}

/* ------------------------------------------------------------------- plumbing */

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { detail: text };
  }
  if (!response.ok) throw new Error(data?.detail || `${response.status}`);
  return data;
}

let toastTimer = null;
function toast(message, kind = "") {
  document.querySelector(".toast")?.remove();
  const node = el("div", { className: `toast ${kind}`, textContent: message });
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), kind === "bad" ? 9000 : 4500);
}

/** Run an async action with the button showing it is busy. */
async function busy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } catch (err) {
    toast(String(err.message || err), "bad");
    return null;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/* ---------------------------------------------------------------- navigation */

const PAGES = ["queue", "review", "applications", "workspace", "documents", "browser", "settings"];

function show(page) {
  state.page = page;
  // So a bookmark can land somewhere useful. Review is the one worth keeping.
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
  for (const section of document.querySelectorAll(".page")) {
    section.classList.toggle("active", section.id === `page-${page}`);
  }
  for (const button of document.querySelectorAll(".navbtn")) {
    button.setAttribute("aria-current", String(button.dataset.page === page));
  }
  if (page === "browser") mountBrowser();
  if (page === "documents") { loadDocuments(); renderResumeStudio().catch(err => toast(err.message, "bad")); }
  if (page === "workspace") renderWorkspace().catch(err => toast(err.message, "bad"));
  if (page === "settings") { renderGoogleSettings().catch(err => toast(err.message, "bad")); renderProviderSettings().catch(err => toast(err.message, "bad")); renderDiscoverySettings().catch(err => toast(err.message, "bad")); }
  window.scrollTo(0, 0);
}

for (const button of document.querySelectorAll(".navbtn")) {
  button.onclick = () => {
    state.navigated = true;
    show(button.dataset.page);
  };
}

/* --------------------------------------------------------------------- state */

async function refreshState() {
  let data;
  try {
    data = await api("/api/state");
  } catch (err) {
    $("browserDot").className = "dot off";
    return;
  }
  state.settings = data.settings;
  state.counts = data.counts;
  state.novnc = data.novnc;
  state.progress = data.progress || {};
  state.profile = data.profile;
  $("browserDot").className = `dot ${data.browser?.connected ? "" : "off"}`;
  $("browserDot").title = data.browser?.connected
    ? "browser connected"
    : `browser unreachable: ${data.browser?.reason || "unknown"}`;

  // Review counts what is waiting on a person, which includes what is being
  // filled right now — a badge that ignores work in flight reads as "nothing
  // to do" during the two minutes when there most is.
  const waiting = (state.counts.ready || 0) + (state.counts.filling || 0);
  const tracked = Object.entries(state.counts)
    .filter(([key]) => key !== "queue")
    .reduce((sum, [, n]) => sum + n, 0);
  $("cQueue").textContent = state.counts.queue || 0;
  $("cReview").textContent = waiting;
  $("cReview").classList.toggle("hot", (state.counts.ready || 0) > 0);
  $("cSent").textContent = tracked;

  applySettings();
  // Keep polling only while something is actually working.
  const working = Object.values(state.progress).some((p) => p && !p.done);
  if (working && !state.polling) state.polling = setInterval(tick, 2500);
  if (!working && state.polling) {
    clearInterval(state.polling);
    state.polling = null;
  }
}

async function tick() {
  await refreshState();
  await loadApplications();
  if (state.current) await openReview(state.current.id, { quiet: true });
}

/* --------------------------------------------------------------------- queue */

async function loadQueue() {
  const { jobs, sources = [], discovery = {}, sinceDays = 0, priorities = {} } = await api("/api/queue");
  state.queue = jobs;
  if (!$('queueAge').querySelector(`option[value="${sinceDays}"]`)) $('queueAge').append(el('option',{value:sinceDays,textContent:`Past ${sinceDays} days`}));
  $('queueAge').value=String(sinceDays);
  $('queueCountry').textContent=priorities.requireListedCountry ? (priorities.workCountries||[]).join(', ')+' only' : '';
  renderJobAlerts().catch(err => toast(err.message,"bad"));
  const failed = sources.filter(s => !s.ok);
  $("queueMeta").textContent = sources.length ? `${sources.length - failed.length}/${sources.length} sources available${failed.length ? ' · ' + failed.map(s => `${new URL(s.url).hostname}: ${s.error || 'failed'}`).join('; ') : ''}` : "";
  if (discovery.fetchedMatches != null) $("queueMeta").append(` · ${jobs.length} shown · ${discovery.eligible} postings after exclusions (${discovery.fetchedMatches} collected)`);
  renderQueue();
}

const queueView={search:'',sort:'recommended',filter:'all'};
$('queueSearch').oninput=e=>{queueView.search=e.target.value;renderQueue();};
$('queueAge').onchange=async e=>{
  const select=e.target,days=Number(select.value);select.disabled=true;
  try {await api('/api/settings',{method:'POST',body:{values:{sinceDays:days}}});state.settings.sinceDays=days;$('setSince').value=days;await loadQueue();toast('Date filter saved. Find jobs refreshes the full search.');}
  catch(error){toast(error.message,'bad');}finally{select.disabled=false;}
};
$('queueSort').onchange=e=>{queueView.sort=e.target.value;renderQueue();};
$('queuePreferences').onclick=()=>show('settings');
for(const button of document.querySelectorAll('[data-queue-filter]')) button.onclick=()=>{
  queueView.filter=button.dataset.queueFilter;
  for(const tab of document.querySelectorAll('[data-queue-filter]')) tab.setAttribute('aria-pressed',String(tab===button));
  renderQueue();
};
function renderQueue() {
  const list = $("queueList");
  list.replaceChildren();
  const strong=state.queue.filter(j=>j.match?.score>=80).length;
  $('queueOverview').replaceChildren(
    el('div',{},el('strong',{textContent:state.queue.length}),el('span',{textContent:'Jobs discovered'})),
    el('div',{},el('strong',{textContent:strong}),el('span',{textContent:'Strong matches'})),
    el('div',{},el('strong',{textContent:state.counts.ready||0}),el('span',{textContent:'Ready to review'})),
    el('a',{href:'#settings',onclick:()=>show('settings'),textContent:'Tune your preferences →'}));
  let visible=state.queue.filter(job=>{
    const text=[job.title,job.company,...(job.locations||[])].join(' ').toLowerCase();
    return text.includes(queueView.search.toLowerCase()) && (queueView.filter!=='strong'||job.match?.score>=80) && (queueView.filter!=='new'||!job.application_status);
  });
  if(queueView.sort==='match')visible.sort((a,b)=>(b.match?.score??-1)-(a.match?.score??-1));
  if(queueView.sort==='newest')visible.sort((a,b)=>String(b.posted||'').localeCompare(String(a.posted||'')));
  $('queueResultCount').textContent=`${visible.length} jobs`;
  if (!visible.length) {
    list.append(el("div", { className: "empty", textContent: state.queue.length ? "No jobs match these filters. Try another search or All jobs." : "Start with Find jobs to discover opportunities for your profile." }));
    return;
  }
  for (const job of visible) {
    const locations = (job.locations || []).slice(0, 3).join(" · ");
    const status = job.application_status;
    const actions = el("div", { className: "row" });
    if (/^https?:\/\//i.test(job.url)) actions.append(el("a", {href: job.url, target: "_blank", rel: "noreferrer",
      className: "small", textContent: job.source === "Remotive" ? "View on Remotive" : "Posting"}));

    if (status) {
      actions.append(
        el("span", { className: `chip ${status === "submitted" ? "ok" : status === "failed" ? "bad" : "warn"}`, textContent: status }),
        el("button", {
          className: "sm",
          textContent: "Open",
          onclick: () => openReview(job.application_id),
        })
      );
    } else {
      actions.append(
        el("button", {
          className: "primary sm",
          textContent: "Prepare",
          onclick: (event) => prepareJob(job, event.currentTarget),
        })
      );
    }
    actions.append(
      el("button", {
        className: "ghost sm",
        textContent: "Hide",
        onclick: async (event) => {
          await busy(event.currentTarget, "…", async () => {
            await api("/api/queue/hide", { method: "POST", body: { url: job.url } });
            await loadQueue();
          });
        },
      })
    );

    const score=job.match?.score;
    const badge=el('div',{className:'match-badge '+(score==null?'unknown':score>=80?'strong':score>=60?'good':'partial'),
      title:job.match?.basis||'Job details are needed to calculate a match.',ariaLabel:score==null?'Match unavailable':`${score} percent profile match`},
      el('strong',{textContent:score==null?'—':`${score}%`}),el('span',{textContent:'PROFILE MATCH'}));
    const tags=el('div',{className:'job-tags'},
      ...((job.fit?.matched||[]).slice(0,4).map(skill=>el('span',{className:'skill-tag',textContent:typeof skill==='string'?skill:skill.skill}))),
      ...(job.recommendation?.constraints?.checks||[]).filter(c=>c.status==='mismatch').map(c=>el('span',{className:'constraint-tag',textContent:`${c.kind} mismatch`})));
    const details=recommendationDetails(job);
    if(details) {
      details.querySelector('summary').textContent='Match breakdown';
      details.append(el('p',{className:'small muted',textContent:job.match?.basis||'Add job details to calculate a match.'}));
      if(job.match) details.append(el('p',{className:'small muted',textContent:`Score uses ${job.match.points} of ${job.match.maximumPoints} available preference points. Skill coverage: ${job.fit?.coverage??'unknown'}%; ${job.match.recognizedSkills} recognized skills. Constraint penalty: ${job.match.constraintPenalty} points.`}));
    }
    const missing=job.fit?.missing?.map(m=>m.skill)||[];
    list.append(el('article',{className:'job-card'},
      el('div',{className:'job-card-main'},
        el('div',{className:'company-avatar',textContent:(job.company||'?').slice(0,2).toUpperCase(),ariaHidden:'true'}),
        el('div',{className:'job-card-info'},el('p',{className:'job-company',textContent:job.company||'Company not listed'}),
          el('h2',{className:'job-title',textContent:job.title||'(untitled)'}),
          el('p',{className:'job-location',textContent:locations||'Location not provided'})),badge),
      tags,
      el('div',{className:'job-insight',textContent:score==null?'Limited evidence — at least 3 recognized skills are needed for a match score.':missing.length?`Skills to review: ${missing.slice(0,4).join(', ')}`:`Your profile covers all ${job.fit?.recognized||0} recognized skill mentions.`}),
      el('div',{className:'job-card-footer'},el('div',{className:'job-disclosure'},details,
        el('span',{className:'job-source',textContent:[job.source,job.posted?`Posted ${job.posted.slice(0,10)}`:'Date not listed'].filter(Boolean).join(' · ')})),actions)));

  }
}

async function prepareJob(job, button) {
  await busy(button, "starting…", async () => {
    const application = await api("/api/applications", {
      method: "POST",
      body: { url: job.url, company: job.company, title: job.title, source: job.source, description: job.description || job.raw?.description || "" },
    });
    await api(`/api/applications/${application.id}/prepare`, { method: "POST" });
    await refreshState();
    await openReview(application.id);
    show("review");
  });
}

$("refreshQueue").onclick = (event) =>
  busy(event.currentTarget, "searching…", async () => {
    await api("/api/queue/refresh", { method: "POST" });
    await loadQueue();
    await refreshState();
  });

/* -------------------------------------------------------------- applications */

async function loadApplications() {
  const { applications } = await api("/api/applications");
  state.applications = applications;
  renderApplications();
}

const STATUS_CHIP = { ready: "warn", submitted: "ok", failed: "bad", filling: "warn", queued: "" };

function renderApplications() {
  const list = $("appList");
  list.replaceChildren();
  if (!state.applications.length) {
    list.append(el("div", { className: "empty", textContent: "No applications yet." }));
    return;
  }
  for (const application of state.applications) {
    const progress = state.progress[application.id];
    const working = progress && !progress.done;
    list.append(
      el(
        "div",
        { className: "card tight" },
        el(
          "div",
          { className: "row wrap" },
          el(
            "div",
            { className: "grow" },
            el("div", { className: "truncate", textContent: application.title || application.url }),
            el("div", {
              className: "small muted truncate",
              textContent: application.company || new URL(application.url).host,
            })
          ),
          working
            ? el("span", { className: "chip warn" }, el("span", { className: "spin" }), progress.step)
            : el("span", {
                className: `chip ${STATUS_CHIP[application.status] ?? ""}`,
                textContent: application.status,
              }),
          el("button", { className: "sm", textContent: "Open", onclick: () => { openReview(application.id); show("review"); } }),
          el("button", {
            className: "ghost sm danger",
            textContent: "Remove",
            onclick: async (event) => {
              await busy(event.currentTarget, "…", async () => {
                await api(`/api/applications/${application.id}`, { method: "DELETE" });
                if (state.current?.id === application.id) state.current = null;
                await loadApplications();
                await refreshState();
              });
            },
          })
        ),
        application.note ? el("div", { className: "small", style: "color:var(--bad);margin-top:6px", textContent: application.note }) : null
      )
    );
  }
}

/* -------------------------------------------------------------------- review */

async function openReview(appId, { quiet = false, checkResume = !quiet } = {}) {
  const application = await api(`/api/applications/${appId}`);
  if (checkResume && application.status === 'ready' && application.resume_path) {
    try {
      application.snapshot = await api(`/api/applications/${appId}/refresh`, {method:'POST'});
    } catch (error) {
      application.snapshot = {...application.snapshot, resumeCheck:{status:'unknown',reason:'Could not verify the open employer page. Open the application and re-read it before sending.'}};
    }
  }
  state.current = application;
  if (!quiet) show("review");
  renderReview();
}

function renderReview() {
  const body = $("reviewBody");
  body.replaceChildren();
  const application = state.current;

  if (!application) {
    body.append(
      el("h1", { textContent: "Review" }),
      el("p", { className: "sub", textContent: "Pick something from the Queue and press Prepare. It lands here filled, with anything uncertain flagged." }),
      el("div", { className: "empty", textContent: "Nothing open." })
    );
    return;
  }

  const snapshot = application.snapshot || {};
  const fields = snapshot.fields || [];
  const staged = snapshot.staged || [];
  const progress = state.progress[application.id];
  const working = progress && !progress.done;

  const flagged = fields.filter((f) => f.review?.length);
  const blankRequired = fields.filter((f) => f.required && !f.value && f.type !== "file");
  const filled = fields.filter((f) => f.value);

  body.append(
    el("h1", { textContent: application.title || "Application" }),
    el(
      "p",
      { className: "sub" },
      el("span", { textContent: `${application.company || ""} · ` }),
      el("a", { href: application.url, target: "_blank", rel: "noreferrer", textContent: "open the posting" })
    )
  );

  if (working) {
    body.append(
      el(
        "div",
        { className: "card row" },
        el("span", { className: "spin" }),
        el("div", { className: "grow", textContent: progress.step }),
        el("span", { className: "muted small", textContent: "this can take a few minutes" })
      )
    );
    return;
  }

  if (application.status === "failed") {
    body.append(
      el(
        "div",
        { className: "card" },
        el("div", { style: "color:var(--bad)", textContent: "This one did not get filled." }),
        el("div", { className: "small muted", style: "margin-top:5px", textContent: application.note })
      )
    );
  }

  if (snapshot.browserUnavailable) body.append(el('p',{className:'card',textContent:'The employer application tab is not open. Saved answers are shown below; reopen it and re-read before sending.'}));
  if (snapshot.flow) {
    body.append(el('div',{className:'card'},
      el('h2',{textContent:snapshot.flow.heading || 'Workday application'}),
      el('p',{textContent:snapshot.flow.message}),
      ...(snapshot.flow.errors || []).map(text=>el('p',{className:'small',style:'color:var(--bad)',textContent:text}))));
    for(const [index,step] of (snapshot.steps || []).entries()) {
      body.append(el('details',{className:'card'},el('summary',{textContent:`Saved step ${index+1}: ${step.flow?.heading || 'Application page'}`}),
        ...(step.fields || []).map(field=>el('p',{className:'small',textContent:`${field.label}: ${field.value || '(blank)'}`}))));
    }
  }
  if(snapshot.reviewText) body.append(el('details',{className:'card'},el('summary',{textContent:'Read the employer’s review'}),
    el('p',{style:'white-space:pre-wrap',textContent:snapshot.reviewText})));

  if (!fields.length && !snapshot.cover?.text && !application.resume_path) {
    body.append(
      el("div", { className: "empty", textContent: "Nothing read from this form yet." }),
      actionBar(application)
    );
    return;
  }

  body.append(
    el(
      "div",
      { className: "stats" },
      stat(filled.length, "filled", "ok"),
      stat(flagged.length, "need your eye", flagged.length ? "warn" : ""),
      stat(staged.length, "drafts", staged.length ? "warn" : ""),
      stat(blankRequired.length, "required blank", blankRequired.length ? "bad" : "")
    )
  );

  if (snapshot.mapError) {
    body.append(
      el("div", { className: "card amber small" },
        `The model could not be reached (${snapshot.mapError}) — only the answers derived from your profile were filled.`)
    );
  }

  /* --- what needs a person ------------------------------------------------ */
  if (flagged.length || blankRequired.length) {
    body.append(el("h2", { textContent: "Needs your eye" }));
    const seen = new Set();
    for (const field of [...flagged, ...blankRequired]) {
      if (seen.has(field.id)) continue;
      seen.add(field.id);
      body.append(fieldCard(application, field));
    }
  }

  /* --- drafted answers ---------------------------------------------------- */
  if (staged.length) {
    body.append(el("h2", { textContent: "Drafted answers" }));
    for (const draft of staged) body.append(draftCard(application, draft));
  }

  /* --- documents ---------------------------------------------------------- */
  const cover = snapshot.cover || {};
  const rejected = snapshot.resumeRejected || [];
  if (application.resume_path || cover.text || rejected.length || (snapshot.attached || []).length) {
    body.append(el("h2", { textContent: "Documents" }));
    const card = el("div", { className: "card" });
    card.append(
      el(
        "div",
        { className: "row" },
        el("div", { className: "grow", textContent: "Résumé" }),
        application.resume_path
          ? el("a", {
              className: "small",
              href: `/api/documents/${application.resume_path.split("/").pop()}`,
              target: "_blank",
              rel: "noreferrer",
              textContent: "tailored for this posting →",
            })
          : el("span", { className: "muted small", textContent: "your master résumé, unchanged" })
      )
    );
    const resumeCheck = snapshot.resumeCheck;
    card.append(el('p', {className:'small muted',textContent:resumeCheck ? `Résumé: ${resumeCheck.status}. ${resumeCheck.reason || ''}` : 'Résumé has not been checked against the open employer page.'}));
    if (application.resume_path && !application.submitted_at && !['submitting','submission_unconfirmed'].includes(application.status)) {
      card.append(el('button',{textContent:'Attach / replace résumé',onclick:event=>busy(event.currentTarget,'attaching…',async()=>{
        const result=await api(`/api/applications/${application.id}/resume/attach`,{method:'POST'});
        await openReview(application.id,{quiet:true});
        toast(result.ok?'Résumé selected. Check the employer preview before sending.':result.reason,result.ok?'':'warn');
      })}));
    }
    const archived=snapshot.submissionAttempt?.documents?.resume;
    if(archived) card.append(el('a',{className:'small',href:`/api/documents/${encodeURIComponent(archived.archive)}`,target:'_blank',rel:'noreferrer',textContent:'Download exact attempted résumé'}));
    for (const line of snapshot.resumeSummary || []) {
      card.append(el("div", { className: "small muted", style: "margin-top:6px", textContent: line }));
    }
    for (const reject of rejected) {
      card.append(
        el(
          "div",
          { className: "small", style: "margin-top:9px;padding-left:11px;border-left:2px solid var(--warn)" },
          el("div", { style: "color:var(--warn)", textContent: `Rewrite rejected — ${reject.reason}` }),
          reject.proposed ? el("div", { className: "muted", textContent: reject.proposed }) : null
        )
      );
    }
    if (cover.text) {
      const area = el("textarea", { rows: 8, value: cover.text });
      const styleReview = writingReview(area);
      let factualReport = cover.factualReview, reviewedText = cover.text;
      const factualBox = el("div");
      const renderFacts = () => {
        factualBox.replaceChildren();
        if (!factualReport) return;
        if (area.value !== reviewedText) {
          factualBox.append(el("p", {className:"small muted", textContent:"Letter edited since factual review. Check the changed wording against your experience."}));return;
        }
        factualBox.append(el("p", {className:"small muted", textContent:factualReport.note}),
          ...(factualReport.concerns || []).map(c=>el("div", {className:"notice warn"},
            el("strong", {textContent:c.quote}), el("p", {textContent:c.reason}))));
      };
      area.addEventListener('input',renderFacts);renderFacts();
      card.append(
        el("div", { style: "margin-top:13px" },
          el("div", { className: "row", style: "margin-bottom:6px" },
            el("div", { className: "grow", textContent: "Cover letter" }),
            cover.unsupported?.length
              ? el("span", { className: "chip warn", textContent: `unverified: ${cover.unsupported.join(", ")}` })
              : el("span", { className: "chip ok", textContent: "no unsupported names or numbers found" })
          ),
          area,
          styleReview,
          factualBox,
          el("button", {className: "primary sm", textContent: "Approve & attach this letter",
            onclick: event => busy(event.currentTarget, "compiling…", async () => {
              const result = await api(`/api/applications/${application.id}/cover/approve`, {
                method: "POST", body: {text: area.value}});
              toast(result.attachment?.ok ? "Approved letter attached." : "PDF saved; attach it from the document link.");
              await openReview(application.id);
            })}),
          tweakBox(area, null, {
            run: async (instruction) => {
              const result = await api(`/api/applications/${application.id}/redraft`, {
                method: "POST",
                body: { question: "cover letter", previous: area.value, instruction, cover: true },
              });
              factualReport=result.factualReview;reviewedText=result.text;return result;
            },
            // One click for the letter's actual tells, so the reviewer does not
            // have to describe prose they can already see is wrong.
            presets: [
              ...(cover.tells?.length ? [{label:"Sounds like AI",instruction:tellInstruction(cover.tells)}] : []),
              ...(cover.factualReview?.concerns?.length ? [{label:"Revise flagged claims",instruction:()=>
                area.value === reviewedText && factualReport?.concerns?.length
                  ? `Correct these factual concerns: ${JSON.stringify(factualReport.concerns)}. Remove unsupported past-experience claims or describe them honestly as future interests. Preserve every supported numeric result and named tool. The job posting is not evidence of my past work.` : null}] : []),
            ],
          }),
          el("div", { className: "row", style: "margin-top:7px" },
            el("button", {
              className: "sm",
              textContent: "Copy",
              onclick: () => { navigator.clipboard.writeText(area.value); toast("Cover letter copied."); },
            })
          )
        )
      );
    }
    const attached = snapshot.attached || [];
    card.append(
      el("div", { className: "small", style: "margin-top:9px" },
        attached.length
          ? el("span", {
              className: "chip ok wrap",
              // Trimmed: a form's own name for its upload field can be a
              // sentence, and three of them is a paragraph in a chip.
              textContent: `on the form: ${attached.map((a) => (a.length > 44 ? `${a.slice(0, 44)}…` : a)).join(", ")}`,
            })
          : el("span", { className: "chip warn", textContent: "nothing attached to this form" }))
    );
    if (application.cover_path) {
      card.append(
        el("div", { className: "small", style: "margin-top:6px" },
          el("a", {
            href: `/api/documents/${application.cover_path.split("/").pop()}`,
            target: "_blank", rel: "noreferrer",
            textContent: "last compiled cover letter PDF →",
          }))
      );
      card.append(el("a", {href: `/api/applications/${application.id}/cover.docx`, className:"small", textContent:"Current letter draft (DOCX)"}));
      if (cover.attachment && !cover.attachment.ok) card.append(el("div", {className:"card amber"},
        el("p", {textContent:cover.attachment.reason || "The revised PDF could not be attached automatically."}),
        el("p", {className:"small", textContent:"Download the compiled PDF above and replace the cover letter in the Browser tab. Then confirm the upload here."}),
        el("button", {className:"sm", textContent:"I attached this PDF in the browser", onclick:event => busy(event.currentTarget,"saving…",async()=>{
          await api(`/api/applications/${application.id}/cover/confirm-manual`,{method:"POST"});
          await openReview(application.id);toast("Upload recorded as confirmed by you.");
        })})));
    }
    if (snapshot.resumeText) card.append(el("p", {}, el("a", {href:`/api/applications/${application.id}/resume.docx`, className:"small", textContent:"Prepared resume (DOCX)"})));
    if (cover.error) card.append(el("div", { className: "small", style: "color:var(--bad)", textContent: `Cover letter not drafted: ${cover.error}` }));
    body.append(card);
  }

  /* --- everything else ---------------------------------------------------- */
  const rest = fields.filter((f) => !flagged.includes(f) && !blankRequired.includes(f));
  const table = el("div", { className: "fields" });
  for (const field of rest) {
    table.append(
      el(
        "div",
        { className: "frow" },
        el("div", { className: "lbl" }, field.label || field.id, field.required ? el("span", { className: "req", textContent: "*" }) : null),
        el("div", { className: `val ${field.value ? "" : "blank"}`, textContent: field.value || "— blank" }),
        el("button", { className: "ghost sm", textContent: "Edit", onclick: (e) => inlineEdit(application, field, e.currentTarget) })
      )
    );
  }
  body.append(
    el("details", { className: "all" },
      el("summary", { textContent: `The other ${rest.length} fields` }),
      table)
  );

  body.append(actionBar(application));
}

function stat(value, label, kind = "") {
  return el("div", { className: `stat ${kind}` }, el("b", { textContent: String(value) }), el("span", { textContent: label }));
}

function fieldCard(application, field) {
  const card = el("div", { className: "card amber tight" });
  const input = el("input", { type: "text", value: field.value || "" });
  card.append(
    el(
      "div",
      { className: "row wrap" },
      el("div", { className: "grow" },
        el("div", { textContent: field.label || field.id }),
        el("div", { className: "small", style: "color:var(--warn)", textContent: field.review?.[0] || "required, and still blank" })
      ),
      field.required ? el("span", { className: "chip bad", textContent: "required" }) : null
    )
  );
  if (field.options?.length && field.options.length <= 40) {
    const select = el("select");
    select.append(el("option", { value: "", textContent: "— choose —" }));
    for (const option of field.options) select.append(el("option", { value: option, textContent: option, selected: option === field.value }));
    select.onchange = () => { input.value = select.value; };
    card.append(el("div", { style: "margin-top:9px" }, select));
    if (field.optionsPartial) {
      card.append(el("div", { className: "small muted", style: "margin-top:5px", textContent: "This list is longer than could be read off the page — if what you want is missing, type it below and the widget will filter." }));
    }
  }
  card.append(
    el("div", { className: "row", style: "margin-top:9px" },
      input,
      el("button", {
        className: "primary sm",
        textContent: "Set",
        onclick: (event) =>
          busy(event.currentTarget, "…", async () => {
            const snapshot = await api(`/api/applications/${application.id}/field`, {
              method: "POST",
              body: { fieldId: field.id, value: input.value },
            });
            state.current.snapshot = snapshot;
            renderReview();
            toast("Written to the form.");
          }),
      })
    )
  );
  return card;
}

function draftCard(application, draft) {
  const area = el("textarea", { rows: 6, value: draft.text });
  const note = el("div", { className: "small muted", style: "margin:3px 0 8px", textContent: draft.note || "" });
  return el(
    "div",
    { className: "card" },
    el("div", { className: "row" },
      el("div", { className: "grow", textContent: draft.question }),
      el("span", { className: "chip warn", textContent: "awaiting approval" })
    ),
    note,
    area,
    writingReview(area),
    tweakBox(area, note, {
      run: (instruction) =>
        api(`/api/applications/${application.id}/redraft`, {
          method: "POST",
          body: { question: draft.question, previous: area.value, instruction },
        }),
      presets: draft.tells?.length
        ? [{ label: "Sounds like AI", instruction: tellInstruction(draft.tells) }]
        : [],
    }),
    el("div", { className: "row", style: "margin-top:8px" },
      el("button", {
        className: "primary sm",
        textContent: "Approve & fill",
        onclick: (event) =>
          busy(event.currentTarget, "writing…", async () => {
            const snapshot = await api(`/api/applications/${application.id}/approve`, {
              method: "POST",
              body: { fieldId: draft.id, text: area.value },
            });
            state.current.snapshot = snapshot;
            renderReview();
            toast("Approved and written to the form.");
          }),
      })
    )
  );
}

/**
 * Say what to change instead of rewriting it yourself.
 *
 * Not liking a draft should cost a sentence, not a paragraph. The instruction
 * goes back through the prompt that wrote the draft in the first place, so the
 * revision still knows the profile it is allowed to draw on — a "make it
 * shorter" answered by a prompt that has forgotten the candidate shortens by
 * inventing.
 *
 * Every version is kept. A retry that comes back worse is otherwise a dead end,
 * and the fear of that is what stops people pressing the button at all.
 */
// How a drafted letter or answer *reads*, alongside how true it is. The server
// checks it against the humanizer patterns (server/dashboard/humanize.py); this
// only shows what came back and turns it into one instruction for a redraft.
function tellChip(tells) {
  if (!tells) return null;
  if (!tells.length) return el("span", { className: "chip ok", textContent: "no style flags" });
  const strong = tells.filter((t) => !t.weak).length;
  const named = `${tells.map((t) => t.name).slice(0, 3).join(", ")}${tells.length > 3 ? "…" : ""}`;
  return el("span", {
    className: "chip warn",
    // Only a strong tell earns the strong wording. Two weak habits in an
    // otherwise good letter is something to glance at, and saying "reads like
    // AI" about it is how the chip stops meaning anything.
    textContent: strong ? `style review: ${named}` : `worth a look: ${named}`,
    // The excerpts go in the tooltip rather than the chip: the reviewer needs
    // them to find the phrase in the letter, and they are a paragraph long.
    title: tells
      .map((t) => `${t.code} ${t.name}${t.weak ? " (weak)" : ""}${t.found?.length ? `\n    ${t.found.join("\n    ")}` : ""}`)
      .join("\n"),
    style: strong ? "" : "opacity:.75",
  });
}

function writingReview(area) {
  const holder = el("div", {className: "small", style: "margin:6px 0"});
  const update = () => holder.replaceChildren(tellChip(window.__formwork.humanize.report(area.value)));
  area.addEventListener("input", update);
  update();
  return holder;
}

// Built from what was actually found, not from the whole rule list: a small
// model given fifteen rules obeys the last few.
function tellInstruction(tells) {
  if (!tells?.length) return "";
  const ordered = [...tells.filter((t) => !t.weak), ...tells.filter((t) => t.weak)];
  const fixes = [...new Set(ordered.map((t) => t.fix).filter(Boolean))].slice(0, 5);
  return `This reads like it was written by a model. ${fixes.join(" ")}`;
}

function tweakBox(area, note, { run, presets = [] }) {
  const history = [];
  const input = el("input", {
    type: "text",
    placeholder: "tell it what to change — shorter, lead with the networking work, less formal…",
  });
  const undo = el("button", {
    className: "ghost sm",
    textContent: "Undo",
    style: "display:none",
    onclick: () => {
      area.value = history.pop();
      area.dispatchEvent(new Event("input"));
      if (!history.length) undo.style.display = "none";
    },
  });

  const retry = async (event, override) =>
    busy(event.currentTarget, "rewriting…", async () => {
      const asked = (override ?? input.value).trim();
      const result = await run(asked);
      if (!result?.text) {
        toast("Nothing came back — the model may be busy.", "warn");
        return;
      }
      history.push(area.value);
      undo.style.display = "";
      area.value = result.text;
      area.dispatchEvent(new Event("input"));
      if (note) note.textContent = result.note || (asked ? `revised: ${asked}` : "written again");
      input.value = "";
      if (result.unsupported?.length) {
        toast(`Check these — they are not in your résumé: ${result.unsupported.join(", ")}`, "warn");
      }
      if (result.lost?.length) toast(`Revision dropped these details: ${result.lost.join(", ")}. Review or Undo.`, "warn");
      // A redraft can trade one tell for another, so the new text is reported
      // rather than assumed fixed. Silence on a clean rewrite.
      if (result.tells?.length) {
        toast(`Style flags: ${result.tells.map((t) => t.name).join(", ")}`, "warn");
      }
    });

  input.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      retry({ currentTarget: input.nextElementSibling });
    }
  };

  return el("div", { className: "row", style: "margin-top:8px" }, input,
    el("button", { className: "sm", textContent: "Retry", onclick: retry }),
    ...presets.map((preset) =>
      el("button", {
        className: "sm",
        textContent: preset.label,
        title: typeof preset.instruction === 'function' ? 'Revise the currently flagged claims' : preset.instruction,
        onclick: (event) => {
          const instruction = typeof preset.instruction === 'function' ? preset.instruction() : preset.instruction;
          if (!instruction) {toast('No current factual findings apply to this wording. Review the edits or request a new draft.');return;}
          return retry(event,instruction);
        },
      })),
    undo);
}

function inlineEdit(application, field, button) {
  const row = button.closest(".frow");
  if (row.querySelector(".edit")) return;
  const input = el("input", { type: "text", value: field.value || "" });
  const editor = el("div", { className: "edit" },
    input,
    el("button", {
      className: "primary sm",
      textContent: "Set",
      onclick: (event) =>
        busy(event.currentTarget, "…", async () => {
          const snapshot = await api(`/api/applications/${application.id}/field`, {
            method: "POST",
            body: { fieldId: field.id, value: input.value },
          });
          state.current.snapshot = snapshot;
          renderReview();
        }),
    }),
    el("button", { className: "ghost sm", textContent: "Cancel", onclick: () => editor.remove() })
  );
  row.append(editor);
  input.focus();
}

function actionBar(application) {
  const bar = el("div", { className: "actionbar" });
  if (application.submitted_at || ["submitted", "screening", "interview", "offer", "accepted", "rejected", "withdrawn", "ghosted"].includes(application.status)) {
    bar.append(el("span", {className:"chip ok", textContent:`${application.status} · application snapshot preserved`}));
    return bar;
  }
  if (['submitting','submission_unconfirmed'].includes(application.status)) {
    bar.append(el('span',{className:'chip',textContent:'Submission unconfirmed — automatic retry blocked'}));
    bar.append(el('button',{textContent:'Check confirmation',disabled:application.status==='submitting',onclick:event=>busy(event.currentTarget,'checking…',async()=>{
      const result=await api(`/api/applications/${application.id}/reconcile`,{method:'POST'});
      await loadApplications();await openReview(application.id,{quiet:true});
      toast(result.confirmation?'Submission confirmed.':'Still unconfirmed. Check the employer record; do not submit again.',result.confirmation?'':'warn');
    })}));
    return bar;
  }
  bar.append(
    el("button", {
      textContent: "Re-fill",
      onclick: (event) =>
        busy(event.currentTarget, "filling…", async () => {
          await api(`/api/applications/${application.id}/prepare`, { method: "POST" });
          await refreshState();
          await openReview(application.id, { quiet: true });
          toast("Filling again — watch it on the Browser tab.");
        }),
    }),
    el("button", {
      textContent: "Re-read the page",
      onclick: (event) =>
        busy(event.currentTarget, "reading…", async () => {
          const snapshot = await api(`/api/applications/${application.id}/refresh`, { method: "POST" });
          state.current.snapshot = snapshot;
          renderReview();
        }),
    }),
    el("button", { textContent: "Watch it", onclick: () => show("browser") }),
    el("div", { className: "grow" })
  );

  if (application.status === "submitted") {
    bar.append(el("span", { className: "chip ok", textContent: "submitted" }));
    return bar;
  }

  const flow=application.snapshot?.flow;
  if(flow && flow.kind!=='review') {
    const next=flow.kind==='next' && !flow.needsFill;
    bar.append(el('button',{className:'primary',textContent:next?'Save and continue':flow.kind==='login'?'Resume after sign-in':'Fill this step',
      disabled:next && (flow.disabled || application.snapshot?.staged?.length>0),
      onclick:event=>busy(event.currentTarget,'continuing…',async()=>{
        await api(`/api/applications/${application.id}/continue`,{method:'POST',body:{action:next?'next':'fill'}});
        await refreshState();await openReview(application.id,{quiet:true});
      })}));
    return bar;
  }

  bar.append(
    el("button", {
      className: "primary",
      textContent: "Submit application",
      onclick: (event) => confirmSubmit(application, event.currentTarget),
    })
  );
  return bar;
}

async function confirmSubmit(application, button) {
  await busy(button, "checking…", async () => {
    // Find the control and report it before pressing anything, so the
    // confirmation names the button that is about to be clicked rather than
    // asking about an abstraction.
    const dry = await api(`/api/applications/${application.id}/submit?dry=true`, { method: "POST" });
    if (!dry.ok) {
      toast(dry.reason || "No submit control found.", "warn");
      return;
    }
    const snapshot = application.snapshot || {};
    const blanks = (snapshot.fields || []).filter((f) => f.required && !f.value && f.type !== "file").length;
    const drafts = (snapshot.staged || []).length;
    const warnings = [
      blanks ? `${blanks} required field(s) still blank` : "",
      drafts ? `${drafts} draft(s) not approved` : "",
    ].filter(Boolean);
    const message =
      `Send this application to ${application.company || "the employer"}?\n\n` +
      `It will click "${dry.control}".\n` +
      (warnings.length ? `\n⚠ ${warnings.join("\n⚠ ")}\n` : "") +
      `\nThis cannot be undone.`;
    if (!window.confirm(message)) return;

    const result = await api(`/api/applications/${application.id}/submit`, { method: "POST" });
    await loadApplications();
    await refreshState();
    await openReview(application.id, { quiet: true });
    toast(
      result.confirmation
        ? "Submitted — the page confirmed it."
        : (result.clicked === false ? result.reason || "Submission was blocked before clicking." : "Submission unconfirmed. Check the employer record; retry is blocked."),
      result.confirmation ? "" : "warn"
    );
  });
}

/* ----------------------------------------------------------------- documents */

let documentsLoaded = false;
async function loadDocuments() {
  if (documentsLoaded) return;
  documentsLoaded = true;
  const [resume, profile] = await Promise.all([api("/api/resume"), api("/api/profile")]);
  $("resumeTex").value = resume.tex;
  $("resumeMeta").textContent = resume.path;
  $("aboutText").value = profile.about || "";
  $("answersJson").value = JSON.stringify(profile.answers || {}, null, 2);
}

$("saveResume").onclick = (event) =>
  busy(event.currentTarget, "saving…", async () => {
    await api("/api/resume", { method: "POST", body: { text: $("resumeTex").value } });
    toast("Résumé saved.");
  });

$("compileResume").onclick = (event) =>
  busy(event.currentTarget, "compiling…", async () => {
    const result = await api("/api/resume/compile", { method: "POST" });
    window.open(`/api/documents/${result.document}`, "_blank");
  });

$("saveAbout").onclick = (event) =>
  busy(event.currentTarget, "saving…", async () => {
    const result = await api("/api/profile/about", { method: "POST", body: { text: $("aboutText").value } });
    toast(result.synced ? "Notes saved and synced to the extension." : `Saved; extension sync failed: ${result.syncError || "retry in Settings"}`, result.synced ? "" : "warn");
  });

$("saveAnswers").onclick = (event) =>
  busy(event.currentTarget, "saving…", async () => {
    const result = await api("/api/profile/answers", { method: "POST", body: { text: $("answersJson").value } });
    toast(result.synced ? "Answers saved and synced to the extension." : `Saved; extension sync failed: ${result.syncError || "retry in Settings"}`, result.synced ? "" : "warn");
  });

/* ------------------------------------------------------------------- browser */

let browserMounted = false;
function mountBrowser() {
  if (browserMounted) return;
  browserMounted = true;
  const wrap = $("novncWrap");
  if (state.novnc === "off") {
    wrap.append(
      el("div", { className: "card small muted" },
        "No noVNC view configured. The browser is presumably one you can see already — " +
        "set FORMWORK_NOVNC_URL if it is somewhere else.")
    );
    return;
  }
  // Same host, the noVNC port. The usual arrangement is the browser, its view
  // and this dashboard on one machine, so guessing beats asking: the address
  // that reached this page is the address that reaches the desktop beside it.
  const src = state.novnc || `http://${location.hostname}:9112/vnc.html?autoconnect=1&resize=scale`;
  const open=el('a',{className:'browser-open',href:src,target:'_blank',rel:'noreferrer',textContent:'Open desktop in a full tab ↗'});
  wrap.append(open,el('p',{className:'small muted',textContent:'On a phone, open the full tab for more room. Use the desktop toolbar’s keyboard control to type into the remote browser.'}));
  if(location.protocol==='https:' && new URL(src,location.href).protocol==='http:') {
    wrap.append(el('p',{className:'card',textContent:'Open the desktop using the button above. This secure page cannot embed its HTTP connection.'}));
  } else wrap.append(el('iframe',{className:'frame',src,title:'Formwork application browser',allow:'clipboard-read; clipboard-write; fullscreen',allowFullscreen:true}));

}

/* ------------------------------------------------------------------ settings */

function applySettings() {
  const s = state.settings;
  if (document.activeElement?.closest("#page-settings")) return; // don't fight the user
  $("setAutoMode").checked = Boolean(s.autoMode);
  $("setTailorResume").checked = Boolean(s.tailorResume);
  $("setDraftCoverLetter").checked = Boolean(s.draftCoverLetter);
  $("setQuery").value = s.query ?? "";
  $("setLocation").value = s.location ?? "";
  $("setSince").value = s.sinceDays ?? 21;
  $("setLimit").value = s.limit ?? 60;
  $("setRefreshInterval").value = s.refreshIntervalHours ?? 0;
  $("setRemoteOnly").checked = Boolean(s.remoteOnly);
  $("setHideNoSponsorship").checked = Boolean(s.hideNoSponsorship);
}

$("saveSettings").onclick = (event) =>
  busy(event.currentTarget, "saving…", async () => {
    state.settings = await api("/api/settings", {
      method: "POST",
      body: {
        values: {
          autoMode: $("setAutoMode").checked,
          tailorResume: $("setTailorResume").checked,
          draftCoverLetter: $("setDraftCoverLetter").checked,
          query: $("setQuery").value,
          location: $("setLocation").value,
          sinceDays: Number($("setSince").value),
          limit: Number($("setLimit").value) || 60,
          refreshIntervalHours: Number($("setRefreshInterval").value) || 0,
          remoteOnly: $("setRemoteOnly").checked,
          hideNoSponsorship: $("setHideNoSponsorship").checked,
        },
      },
    });
    toast("Settings saved.");
  });

/* ---------------------------------------------------------------------- boot */

window.addEventListener("hashchange", () => {
  const page = location.hash.replace(/^#/, "");
  if (PAGES.includes(page) && page !== state.page) {
    state.navigated = true;
    show(page);
  }
});

(async function start() {
  const asked = location.hash.replace(/^#/, "");
  // A page asked for by name is a choice, and outranks the ready-application
  // auto-open below.
  if (PAGES.includes(asked)) state.navigated = true;
  show(PAGES.includes(asked) ? asked : "queue");
  renderReview();
  await refreshState();
  if (!state.navigated && state.profile && !state.profile.present) {
    show("settings");
    state.navigated = true;
  }
  await Promise.all([loadQueue(), loadApplications()]);
  // A ready application is the thing most likely to be wanted on open — but
  // only if the reader has not already gone somewhere. Loading the queue and
  // the applications takes a moment, and yanking someone off the tab they just
  // tapped is worse than making them tap Review.
  const ready = state.applications.find((a) => a.status === "ready");
  if (ready) {
    await openReview(ready.id, { quiet: true, checkResume: true });
    if (!state.navigated) show("review");
  }
  setInterval(refreshState, 15000);
})();
