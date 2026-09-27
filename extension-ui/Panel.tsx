import { useEffect, useRef, useState } from "react";
import { DraftCard } from "./DraftCard";
import {
  errorText,
  type Analysis,
  type Bridge,
  type Job,
  type Receipt,
} from "./types";
function Section({ title, lines }: { title: string; lines: string[] }) {
  return lines.length ? (
    <div className="sect">
      <h4>{title}</h4>
      <ul>
        {lines.slice(0, 12).map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </div>
  ) : null;
}
function Report({
  parts,
  bridge,
  saveContext,
  revision,
}: {
  parts: Receipt[];
  bridge: Bridge;
  saveContext: () => Promise<void>;
  revision: number;
}) {
  const corrected = parts.flatMap((p) => p.corrected || []),
    review = parts.flatMap((p) => p.review || []),
    failed = parts.flatMap((p) => p.failed || []),
    missing = parts.flatMap((p) => p.missingRequired || []);
  const histories = parts.flatMap((p) => (p.history ? [p.history] : [])),
    saved = histories.reduce((n, h) => n + h.saved, 0),
    existing = histories.reduce((n, h) => n + h.existing, 0);
  const mapError = parts.find((p) => p.mapError || p.error),
    warning = parts.find((p) => p.contextWarning)?.contextWarning;
  const drafts = parts.flatMap((p) =>
    (p.drafts || []).map((d) => ({
      ...d,
      frameId: p.frameId,
      autoApprove: p.autoApprove,
    })),
  );
  return (
    <>
      <div className="stat">
        <span>
          <b>{parts.reduce((n, p) => n + (p.filled || 0), 0)}</b> filled
        </span>
        <span>
          <b>{review.length}</b> to review
        </span>
        <span>
          <b>{corrected.length}</b> corrected
        </span>
        <span>
          <b>{failed.length}</b> failed
        </span>
      </div>
      {!!(saved || existing) && (
        <div className="note">
          History: {saved} entries added; {existing} matching entries already
          present.
        </div>
      )}
      <Section
        title="History needs attention"
        lines={histories.flatMap((h) => h.issues || [])}
      />
      {parts.some((p) => p.frameId) && (
        <div className="note">
          Form found in an embedded frame on this page.
        </div>
      )}
      {warning && <div className="note pending">{warning}</div>}
      {mapError && (
        <div className="err">
          Model call failed ({mapError.mapError || mapError.error}). Only fields
          derived from your profile were filled.
        </div>
      )}
      <Section title="Corrected from your profile" lines={corrected} />
      <Section
        title="Needs your eye (amber)"
        lines={review.map((r) => `${r.label}: ${r.reason}`)}
      />
      <Section title="Could not be set (red)" lines={failed} />
      <Section title="Required, still empty" lines={missing} />
      {!!drafts.length && (
        <div className="sect">
          <h4>Drafts awaiting approval</h4>
          {drafts.map((item) => (
            <DraftCard
              key={`${revision}:${item.frameId}:${item.id}`}
              item={item}
              bridge={bridge}
              saveContext={saveContext}
            />
          ))}
        </div>
      )}
    </>
  );
}
function postingText() {
  const copy = (
    document.querySelector("main,article,[role=main]") || document.body
  ).cloneNode(true) as HTMLElement;
  copy
    .querySelectorAll(
      "form,input,textarea,select,script,style,nav,footer,[role=dialog],[data-formwork-ui]",
    )
    .forEach((n) => n.remove());
  return (copy.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30000);
}
export function Panel({ bridge, hide }: { bridge: Bridge; hide: () => void }) {
  const { ns, send } = bridge;
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState("Working…");
  const working = useRef(false);
  const [status, setStatus] = useState({ text: "", kind: "" });
  const [job, setJob] = useState<Job>({}),
    [contextMessage, setContextMessage] = useState(
      "Checking for a job description…",
    );
  const jobRef = useRef<Job>({}),
    edited = useRef(false);
  const [view, setView] = useState<
    "initial" | "working" | "report" | "closed" | "error" | "analysis"
  >("initial");
  const [parts, setParts] = useState<Receipt[]>([]),
    [hiddenCount, setHiddenCount] = useState(0),
    [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0),
    [analysis, setAnalysis] = useState<Analysis | null>(null),
    [selectedVersion, setSelectedVersion] = useState(""),
    [savedJob, setSavedJob] = useState(false);
  const analysisPosting = useRef<Job>({});
  const ready = useRef<Promise<void> | null>(null);
  function updateJob(value: Job) {
    jobRef.current = value;
    setJob(value);
  }
  function changeJob(value: Job) {
    edited.current = true;
    updateJob({ ...jobRef.current, ...value });
  }
  useEffect(() => {
    ready.current = (async () => {
      try {
        const saved = await send("getJobContext", {}),
          metadata = ns.scrape().schema,
          posting = ns.readJobPosting?.();
        const selected = {
          ...metadata,
          ...(posting || {}),
          ...(saved?.description || saved?.manual ? saved : {}),
        };
        selected.company ||= metadata.company;
        selected.title ||= metadata.title;
        if (!edited.current) {
          updateJob(selected);
          setContextMessage(
            selected.description
              ? "This posting will guide answers and revisions."
              : "No description found. Paste the posting here for role-specific answers.",
          );
        }
      } catch {
        setContextMessage("Paste the job description here to guide answers.");
      }
    })();
    ns.onProgress = setProgress;
    const refreshReport = () => {
      const summary = bridge.summarize(ns._last);
      if (!summary) return;
      setParts([{ ...summary, frameId: 0 }]);
      setStatus({ text: `${summary.filled || 0} filled`, kind: "ok" });
      setView("report");
    };
    ns.refreshLocalReport = refreshReport;
    return () => {
      if (ns.onProgress === setProgress) ns.onProgress = undefined;
      if (ns.refreshLocalReport === refreshReport) ns.refreshLocalReport = undefined;
    };
  }, []);
  async function saveContext() {
    await ready.current;
    const current = jobRef.current;
    const result = await send("saveJobContext", {
      company: current.company || "",
      title: current.title || "",
      description: current.description || "",
    });
    if (result?.error) throw new Error(result.error);
    setContextMessage(
      current.description?.trim()
        ? "Saved for this posting. Answers and revisions will use it."
        : "No job description set. Answers can only use your background and the question.",
    );
  }
  async function readDescription() {
    await ready.current;
    const posting = ns.readJobPosting?.();
    if (!posting) {
      setContextMessage(
        "No description found on this page. Paste it from the original posting.",
      );
      return;
    }
    edited.current = true;
    updateJob({ ...ns.scrape().schema, ...posting });
    try {
      await saveContext();
    } catch (error) {
      setContextMessage(errorText(error));
    }
  }
  function showBlocker(blocked: Receipt['blocked']) {
    if (blocked === 'authentication_required') {
      setStatus({text: 'sign-in required', kind: 'pending'});
      setMessage('Complete the site’s sign-in or email identification step, then choose Fill this form to continue.');
      setView('error');
      return;
    }
    const expired = blocked === 'application_expired';
    setStatus({text: expired ? 'posting expired' : 'verification required', kind: 'pending'});
    setMessage(expired
      ? 'This posting has expired. Open an active posting to continue.'
      : 'This site requires browser verification. Complete it on the page, then choose Fill this form to check again.');
    setView('error');
  }
  async function run(reveal = false) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setProgress("Loading your saved profile…");
    try {
      const blocked = ns.applicationBlocker?.();
      if (blocked) { ns._last = undefined; showBlocker(blocked); return; }
      try {
        await saveContext();
      } catch (error) {
        setStatus({ text: "context not saved", kind: "err" });
        setContextMessage(errorText(error));
        return;
      }
      if (reveal) {
        setStatus({ text: "opening the form…", kind: "" });
        const opened = await send("reveal", {});
        if (opened?.blocked) { ns._last = undefined; showBlocker(opened.blocked); return; }
        if (!opened?.revealed) {
          setStatus({ text: "could not open", kind: "err" });
          setMessage(`Formwork could not open the application${opened?.reason ? `: ${opened.reason}` : ''}. Open the intended form yourself, then choose Fill this form.`);
          setView("error");
          return;
        }
      }
      setStatus({ text: "reading the form…", kind: "" });
      setView("working");
      const local = await ns.runFrame();
      setProgress("Checking embedded application forms…");
      const frames = (await send("fanout", {})) || [];
      const all: Receipt[] = [
        ...(local ? [{ ...local, frameId: 0 }] : []),
        ...frames.flatMap((f) =>
          f?.summary ? [{ ...f.summary, frameId: f.frameId }] : [],
        ),
      ];
      const visible = all.filter((p) => !p.hiddenOnly && !p.blocked),
        closed = all.filter((p) => p.hiddenOnly);
      if (!visible.length) {
        const blocked = all.find(p => p.blocked)?.blocked;
        if (blocked) { ns._last = undefined; showBlocker(blocked); return; }
        if (closed.length) {
          setHiddenCount(closed.reduce((n, p) => n + (p.hiddenFields || 0), 0));
          setStatus({ text: "form not open", kind: "pending" });
          setView("closed");
        } else {
          setStatus({ text: "no form found", kind: "err" });
          setMessage(
            "No application form on this page. If the form is behind a button, open it first, then run formwork again.",
          );
          setView("error");
        }
        return;
      }
      setParts(visible);
      setRevision((n) => n + 1);
      setStatus({
        text: `${visible.reduce((n, p) => n + (p.filled || 0), 0)} filled`,
        kind: "ok",
      });
      setView("report");
    } catch (error) {
      setStatus({ text: "Fill stopped — retry available", kind: "err" });
      setMessage(errorText(error));
      setView("error");
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function analyze(version?: string) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setProgress("Analyzing the job posting…");
    setStatus({ text: "analyzing…", kind: "" });
    try {
      if (version === undefined) {
        analysisPosting.current = {
          description: postingText(),
          title:
            document.querySelector("h1")?.textContent?.trim() || document.title,
          company: ns.scrape().schema.company || "",
        };
        setSavedJob(false);
      }
      const result = await send("analyzePosting", {
        ...analysisPosting.current,
        ...(Number(version) ? { version_id: Number(version) } : {}),
      });
      if (result?.error) throw new Error(result.error);
      setAnalysis(result);
      setSelectedVersion(version || "");
      setView("analysis");
      setStatus({ text: "analyzed", kind: "ok" });
    } catch (error) {
      setStatus({ text: "analysis unavailable", kind: "err" });
      setMessage(errorText(error));
      setView("error");
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function savePosting() {
    setBusy(true);
    try {
      const result = await send("savePosting", analysisPosting.current);
      if (result?.error) throw new Error(result.error);
      setSavedJob(true);
      setStatus({ text: "saved", kind: "ok" });
    } catch (error) {
      setStatus({ text: errorText(error), kind: "err" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="panel" aria-busy={busy}>
      <header>
        <b>formwork</b>
        <span className={`sub ${status.kind}`}>{status.text}</span>
        <button
          type="button"
          aria-label="Hide Formwork"
          title="Hide Formwork (Esc). Reopen from the Formwork button."
          className="close"
          onClick={hide}
        >
          ×
        </button>
      </header>
      <div className="activity" role="status" aria-live="polite" hidden={!busy}>
        <span className="spinner" aria-hidden="true" />
        <span>{progress}</span>
      </div>
      <details className="job-context">
        <summary>Job description</summary>
        <div className="note">{contextMessage}</div>
        <label>
          Employer
          <input
            type="text"
            aria-label="Employer for this application"
            placeholder="Employer"
            value={job.company || ""}
            onChange={(e) => changeJob({ company: e.target.value })}
          />
        </label>
        <label>
          Role
          <input
            type="text"
            aria-label="Role for this application"
            placeholder="Role"
            value={job.title || ""}
            onChange={(e) => changeJob({ title: e.target.value })}
          />
        </label>
        <textarea
          rows={5}
          aria-label="Job description"
          placeholder="Paste the responsibilities and requirements from the job posting…"
          value={job.description || ""}
          onChange={(e) => changeJob({ description: e.target.value })}
        />
        <div className="row">
          <button type="button" onClick={() => void readDescription()}>
            Use description on this page
          </button>
          <button
            type="button"
            onClick={() =>
              void saveContext().catch((error) =>
                setContextMessage(errorText(error)),
              )
            }
          >
            Save job context
          </button>
        </div>
      </details>
      <div className="body">
        {view === "initial" && (
          <div className="note">
            Fills this application from your profile. Nothing is submitted.
          </div>
        )}
        {view === "working" && (
          <div className="note">Scanning fields and opening dropdowns…</div>
        )}
        {view === "error" && <div className="note">{message}</div>}
        {view === "closed" && (
          <>
            <div className="note">
              {hiddenCount > 0
                ? `This page has an application form with ${hiddenCount} field(s), but it is not open yet — usually behind an Apply button.`
                : "The application form is not open yet. This page has a supported Apply button that opens it."}
              {" "}formwork can open it, or you can click Apply yourself.
            </div>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void run(true)}
            >
              Open the form &amp; fill
            </button>
          </>
        )}
        {view === "report" && (
          <Report
            parts={parts}
            bridge={bridge}
            saveContext={saveContext}
            revision={revision}
          />
        )}
        {view === "analysis" && analysis && (
          <>
            <h3>{analysisPosting.current.title}</h3>
            <select
              aria-label="Resume to analyze"
              disabled={busy}
              value={selectedVersion}
              onChange={(e) => void analyze(e.target.value)}
            >
              <option value="">Saved profile + master resume</option>
              {(analysis.versions || []).map((v) => (
                <option value={v.id} key={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <p>
              {analysis.fit.coverage == null
                ? "Skill coverage unknown"
                : `${analysis.fit.coverage}% of recognized skills evidenced`}
            </p>
            <Section
              title="Evidenced in this resume"
              lines={analysis.fit.matched.map(
                (m) => `${m.skill}: ${m.evidence}`,
              )}
            />
            <Section
              title="Not evidenced"
              lines={analysis.fit.missing.map(
                (m) => `${m.skill}: ${m.posting}`,
              )}
            />
            <Section
              title="Work authorization language in the posting"
              lines={analysis.sponsorshipExcerpts || []}
            />
            {!!analysis.sponsorshipExcerpts?.length && (
              <p className="note">
                Quoted posting text, not an eligibility decision or employer
                sponsorship history.
              </p>
            )}
            <p className="note">{analysis.fit.explanation}</p>
            <p className="note">{analysis.note}</p>
            <button
              disabled={busy || savedJob}
              onClick={() => void savePosting()}
            >
              {savedJob ? "Job saved" : "Save job to Formwork"}
            </button>
          </>
        )}
        <div className="row">
          <button
            className="primary"
            disabled={busy}
            onClick={() => void run()}
          >
            Fill this form
          </button>
        </div>
      </div>
      <div className="row actions">
        <button disabled={busy} onClick={() => void analyze()}>
          Analyze job
        </button>
      </div>
      <footer>
        formwork never submits. Review the highlights, then submit yourself.
      </footer>
    </div>
  );
}
