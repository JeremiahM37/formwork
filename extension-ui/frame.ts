import { resumeOnPage } from "../server/dashboard/submission.mjs";
import { applicationBlocker } from "./application-state";
import type { Engine, Outcome, Schema, Field, Plan } from "./engine";
import type { Receipt } from "./types";
declare global {
  interface Window {
    __formwork?: Engine;
  }
}
/**
 * formwork — content script entry, review panel, and per-frame worker.
 *
 * Runs in every frame. Most real applications are not served from the ATS
 * domain directly: a company hosts the posting on its own site and embeds the
 * ATS form in an iframe (`job-boards.greenhouse.io/embed/job_app`, Lever and
 * Ashby equivalents). Filling only the top document therefore misses the
 * majority of live postings.
 *
 * So the script has two roles:
 *   - Top frame: owns the panel and coordinates.
 *   - Sub-frame:  no UI; exposes runFrame()/fillApproved() for the panel to
 *                 drive through the background worker.
 *
 * The panel is the product's safety story made visible: what was filled, what
 * was corrected, what was refused, and every draft answer sitting behind an
 * explicit approval before it can touch the page. Nothing here submits.
 */
export function initializeFrame() {
  "use strict";
  if (document.documentElement.hasAttribute("data-formwork-dashboard")) return;

  const ns = (window.__formwork = window.__formwork || ({} as Engine));
  const UI_VERSION = chrome.runtime.getManifest?.()?.version || "0.1.8";
  if (ns._initialized && ns._uiVersion === UI_VERSION) return;
  ns._initialized = true;
  ns._uiVersion = UI_VERSION;

  const send = <T = unknown>(type: string, payload: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "The extension did not respond. Reopen Formwork from its toolbar icon and retry.",
            ),
          ),
        180000,
      );
      Promise.resolve()
        .then(() => chrome.runtime.sendMessage({ type, payload }))
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });

  /* ------------------------------------------------------ per-document work */

  /**
   * Reveal a closed application form, if this document has one.
   *
   * Runs only when nothing fillable is visible anywhere, so the control being
   * pressed opens a form rather than sending one — and `findOpener` refuses
   * anything submit-shaped regardless.
   *
   * @returns {Promise<boolean>} whether fields became visible
   */
  ns.revealForm = async () => {
    if (ns.scrape().schema.fields.length) return false;
    const opener = ns.findOpener();
    if (!opener) return false;
    opener.click();
    return true; // clicked; whether a form appeared is judged across frames
  };

  /** How many fillable fields are visible in this document right now. */
  ns.visibleFieldCount = () => ns.scrape().schema.fields.length;
  ns.applicationBlocker = () => applicationBlocker(Boolean(ns.visibleFieldCount?.()));

  /** Scrape → plan → fill this document. Returns null when there is no form. */
  async function fillThisDocument() {
    ns.onProgress?.("Opening résumé sections…");
    const history = await ns.fillHistory?.(send);
    ns.onProgress?.("Reading fields and dropdowns…");
    const scraped = await ns.scrapeFull();
    if (ns.historyEditorProtected) {
      const kept = scraped.schema.fields
        .map((field, index) => ({ field, elements: scraped.registry[index] }))
        .filter(({ elements }) => !ns.historyEditorProtected?.(elements?.[0]));
      scraped.schema.fields = kept.map((item) => item.field);
      scraped.registry = kept.map((item) => item.elements);
    }
    if (!scraped.schema.fields.length) {
      if (
        !history ||
        !(history.saved || history.existing || (history.issues || []).length)
      )
        return null;
      const result = {
        dropped: [],
        review: [],
        missingRequired: [],
        staged: [],
      };
      const report = { filled: [], failed: [], history };
      return (ns._last = { scraped, result, report });
    }

    ns.onProgress?.("Preparing answers from your profile…");
    const result = await send<Plan>("plan", {
      schema: scraped.schema,
      fullOptions: ns._options || {},
    });
    if (!result || result.error) {
      return {
        scraped,
        result: result || { error: "no response from the extension" },
        report: null,
      };
    }

    const report = await ns.fill(
      result.fills,
      scraped.schema,
      scraped.registry,
      {
        review: (result.review || []).map((r) => r.id),
        files: await attachments(scraped.schema, result.documents),
        hints: result.hints || {},
      },
    );
    report.history = history;
    if (result.documents?.resume) {
      const selected = result.documents.resume;
      const bytes = decodeDataUrl(selected.dataUrl);
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b=>b.toString(16).padStart(2,'0')).join('');
      const check = await resumeOnPage({filename:selected.name,sha256});
      if (check.status !== 'matched' && (check.files.length || scraped.schema.fields.some(f=>f.type==='file' && /resume|résumé|cv\b/i.test(f.label)))) {
        result.review ||= [];
        result.review.push({id:'resume-verification',label:'Résumé attachment',reason:check.reason || 'Verify the selected résumé on the employer preview.'});
      }
    }

    // Kept so an approved draft can be written back into this same document.
    ns._last = { scraped, result, report };
    return { scraped, result, report };
  }

  /** Serializable summary for the panel, which may live in another frame. */
  function summarize(out: Outcome | undefined | null): Receipt | null {
    if (!out || !out.report) {
      return out
        ? { error: out.result.error, fields: out.scraped.schema.fields.length }
        : null;
    }
    const { scraped, result, report } = out;
    return {
      fields: scraped.schema.fields.length,
      company: scraped.schema.company,
      filled: report.filled.length,
      actions: report.receipts,
      history: report.history,
      failed: report.failed.map((f) => f.reason),
      corrected: (result.dropped || []).map((d) => d.reason),
      review: (result.review || []).map((r) => ({
        label: r.label,
        reason: r.reason,
      })),
      missingRequired: (result.missingRequired || [])
        .filter((f) => !report.filled.includes(f.id))
        .map((f) => f.label),
      drafts: (result.staged || []).map((d) => ({
        id: d.id,
        company: result.jobContext?.company || scraped.schema.company,
        role: result.jobContext?.title || scraped.schema.title,
        question: d.question,
        text: d.text,
        tells: d.tells || [],
        note: d.note,
      })),
      mapError: result.mapError,
      contextWarning: result.contextWarning,
      autoApprove: result.autoApprove,
    };
  }

  /** Entry point the panel drives in sub-frames. */
  ns.runFrame = async () => {
    const blocked = ns.applicationBlocker?.();
    if (blocked) { ns._last = undefined; return { blocked }; }
    const out = summarize(await fillThisDocument());
    if (out) return out;
    // No visible form. Say whether one exists but is closed, so the panel can
    // offer to open it instead of claiming there is nothing here.
    const hidden = ns.hiddenFieldCount();
    return hidden || ns.lazyFormOpener?.() ? { hiddenOnly: true, hiddenFields: hidden } : null;
  };

  /** Write an approved draft into this document. */
  ns.fillApproved = async (id, text) => {
    if (!ns._last)
      return { ok: false, reason: "this frame has not been filled yet" };
    const original = ns._last.scraped.schema.fields.find(
      (field) => field.id === id,
    );
    if (!original)
      return {
        ok: false,
        reason:
          "This draft no longer has a matching question. Fill this form again.",
      };
    const signature = (field: Field) =>
      JSON.stringify([
        field.label?.trim(),
        field.type,
        field.section || "",
        field.history || null,
      ]);
    // React forms can replace a textarea while the user reviews a draft. IDs
    // are scrape-local, so match the question, not its old numeric position.
    const fresh = ns.scrape();
    const matches = fresh.schema.fields.filter(
      (field) => signature(field) === signature(original),
    );
    if (matches.length !== 1)
      return {
        ok: false,
        reason:
          "The question changed or is ambiguous. Fill this form again before approving.",
      };
    const field = matches[0];
    const target = fresh.registry[fresh.schema.fields.indexOf(field)]?.[0];
    if (
      (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement) &&
      target.maxLength > 0 &&
      text.length > target.maxLength
    )
      return {
        ok: false,
        reason: `This answer has ${text.length} characters; the field allows ${target.maxLength}. Shorten it before approving.`,
      };
    try {
      const report = await ns.fill(
        { [field.id]: text },
        fresh.schema,
        fresh.registry,
        {
          review: [field.id],
          keepExisting: true,
        },
      );
      return {
        ok: report.filled.length > 0,
        reason: report.failed[0]?.reason,
        company: fresh.schema.company,
        title: fresh.schema.title,
      };
    } catch (error) {
      return {
        ok: false,
        reason: String(error instanceof Error ? error.message : error),
      };
    }
  };

  /**
   * Match stored documents to this document's file inputs.
   *
   * Files cannot live in chrome.storage, so they are kept as data URLs and
   * rebuilt into File objects here — a File can only be constructed in a
   * document context, which the background worker does not have.
   */
  async function attachments(
    schema: Schema,
    documents: NonNullable<Plan["documents"]> = {},
  ) {
    const KINDS = [
      { key: "coverLetter", re: /cover\s*letter/i },
      { key: "resume", re: /resume|curriculum vitae|\bcv\b/i },
    ];
    const out: Record<string, File> = {};
    for (const field of schema.fields) {
      if (field.type !== "file") continue;
      // Cover letter is tested first: "Resume/CV or Cover Letter" would
      // otherwise always resolve to the resume.
      const kind = KINDS.find((k) => k.re.test(field.label || ""));
      const doc = kind && documents[kind.key];
      if (!doc?.dataUrl) continue;
      try {
        out[field.id] = new File([decodeDataUrl(doc.dataUrl)], doc.name, {
          type: doc.type || "application/octet-stream",
        });
      } catch {
        /* a corrupt stored document should not abort the whole fill */
      }
    }
    return out;
  }

  /**
   * Decode a base64 data URL to bytes.
   *
   * Done by hand rather than with `fetch(dataUrl)` because content scripts are
   * subject to the host page's Content-Security-Policy, and a strict
   * `connect-src` — common on job boards — blocks the fetch with no useful
   * error. `atob` has no such constraint.
   */
  function decodeDataUrl(dataUrl: string) {
    const base64 = String(dataUrl).slice(String(dataUrl).indexOf(",") + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  return { ns, send, summarize };
}
