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
(function () {
  "use strict";

  const ns = (window.__formwork = window.__formwork || {});
  if (ns._initialized) return;
  ns._initialized = true;

  const send = (type, payload) => chrome.runtime.sendMessage({ type, payload });

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
    const opener = ns.findOpener();
    if (!opener) return false;
    opener.click();
    return true; // clicked; whether a form appeared is judged across frames
  };

  /** How many fillable fields are visible in this document right now. */
  ns.visibleFieldCount = () => ns.scrape().schema.fields.length;

  /** Scrape → plan → fill this document. Returns null when there is no form. */
  async function fillThisDocument() {
    const scraped = await ns.scrapeFull();
    if (!scraped.schema.fields.length) return null;

    const result = await send("plan", {
      schema: scraped.schema,
      fullOptions: ns._options || {},
    });
    if (!result || result.error) {
      return { scraped, result: result || { error: "no response from the extension" }, report: null };
    }

    const report = await ns.fill(result.fills, scraped.schema, scraped.registry, {
      review: result.review.map((r) => r.id),
      files: await attachments(scraped.schema, result.documents),
    });

    // Kept so an approved draft can be written back into this same document.
    ns._last = { scraped, result };
    return { scraped, result, report };
  }

  /** Serializable summary for the panel, which may live in another frame. */
  function summarize(out) {
    if (!out || !out.report) {
      return out ? { error: out.result.error, fields: out.scraped.schema.fields.length } : null;
    }
    const { scraped, result, report } = out;
    return {
      fields: scraped.schema.fields.length,
      company: scraped.schema.company,
      filled: report.filled.length,
      failed: report.failed.map((f) => f.reason),
      corrected: result.dropped.map((d) => d.reason),
      review: result.review.map((r) => ({ label: r.label, reason: r.reason })),
      missingRequired: result.missingRequired
        .filter((f) => !report.filled.includes(f.id))
        .map((f) => f.label),
      drafts: result.staged.map((d) => ({
        id: d.id,
        question: d.question,
        text: d.text,
        note: d.note,
      })),
      mapError: result.mapError,
      autoApprove: result.autoApprove,
    };
  }

  /** Entry point the panel drives in sub-frames. */
  ns.runFrame = async () => {
    const out = summarize(await fillThisDocument());
    if (out) return out;
    // No visible form. Say whether one exists but is closed, so the panel can
    // offer to open it instead of claiming there is nothing here.
    const hidden = ns.hiddenFieldCount();
    return hidden ? { hiddenOnly: true, hiddenFields: hidden } : null;
  };

  /** Write an approved draft into this document. */
  ns.fillApproved = async (id, text) => {
    if (!ns._last) return { ok: false, reason: "this frame has not been filled yet" };
    const { scraped } = ns._last;
    const report = await ns.fill({ [id]: text }, scraped.schema, scraped.registry, {
      review: [id],
      keepExisting: true, // don't clear the highlights from the main run
    });
    return { ok: report.filled.length > 0, company: scraped.schema.company, title: scraped.schema.title };
  };

  /**
   * Match stored documents to this document's file inputs.
   *
   * Files cannot live in chrome.storage, so they are kept as data URLs and
   * rebuilt into File objects here — a File can only be constructed in a
   * document context, which the background worker does not have.
   */
  async function attachments(schema, documents = {}) {
    const KINDS = [
      { key: "coverLetter", re: /cover\s*letter/i },
      { key: "resume", re: /resume|curriculum vitae|\bcv\b/i },
    ];
    const out = {};
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
  function decodeDataUrl(dataUrl) {
    const base64 = String(dataUrl).slice(String(dataUrl).indexOf(",") + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // A sub-frame is a worker only. Mounting a panel inside an embedded form
  // would render it clipped inside the iframe's box.
  if (window.top !== window) return;

  /* ------------------------------------------------------------------ panel */

  const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const kid of kids) node.append(kid);
    return node;
  };

  const STYLE = `
    :host { all: initial; }
    .panel {
      position: fixed; right: 16px; bottom: 16px; width: 380px; max-height: 76vh;
      display: flex; flex-direction: column; z-index: 2147483647;
      font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
      color: #e8e8ea; background: #17171a; border: 1px solid #2e2e33;
      border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.45); overflow: hidden;
    }
    header { display: flex; align-items: center; gap: 8px; padding: 12px 14px;
      border-bottom: 1px solid #2e2e33; background: #1d1d21; }
    header b { font-size: 14px; letter-spacing: -.01em; }
    header .sub { color: #8b8b95; font-size: 12px; margin-left: auto; }
    .body { overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
    button { font: inherit; border-radius: 7px; border: 1px solid #3a3a42; cursor: pointer;
      background: #26262c; color: #e8e8ea; padding: 6px 11px; }
    button:hover { background: #30303a; }
    button.primary { background: #2f6f4f; border-color: #38855f; color: #fff; }
    button.primary:hover { background: #37805c; }
    button:disabled { opacity: .5; cursor: default; }
    .row { display: flex; gap: 8px; align-items: center; }
    .stat { display: flex; gap: 14px; flex-wrap: wrap; color: #b6b6c0; font-size: 12px; }
    .stat b { color: #e8e8ea; }
    .note { color: #8b8b95; font-size: 12px; }
    .sect { border-top: 1px solid #2a2a30; padding-top: 10px; }
    .sect h4 { margin: 0 0 6px; font-size: 12px; font-weight: 600; color: #b6b6c0;
      text-transform: uppercase; letter-spacing: .06em; }
    ul { margin: 0; padding-left: 16px; color: #b6b6c0; font-size: 12px; }
    li { margin-bottom: 3px; }
    .draft { border: 1px solid #33333b; border-radius: 9px; padding: 10px; background: #1c1c21; }
    .draft .q { font-size: 12px; color: #c9c9d2; margin-bottom: 7px; }
    .draft .origin { font-size: 11px; color: #8b8b95; margin-bottom: 7px; }
    textarea { width: 100%; box-sizing: border-box; min-height: 118px; resize: vertical;
      font: inherit; color: #e8e8ea; background: #131317; border: 1px solid #33333b;
      border-radius: 7px; padding: 8px; }
    .pending { color: #d9a441; }
    .ok { color: #4ea87a; }
    .err { color: #d97070; }
    footer { padding: 9px 14px; border-top: 1px solid #2e2e33; background: #1d1d21;
      color: #8b8b95; font-size: 11.5px; }
  `;

  const host = el("div");
  host.style.cssText = "position:fixed;inset:auto;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  root.append(el("style", { textContent: STYLE }));

  const body = el("div", { className: "body" });
  const status = el("span", { className: "sub" });
  const fillBtn = el("button", { className: "primary", textContent: "Fill this form" });
  root.append(
    el(
      "div",
      { className: "panel" },
      el("header", {}, el("b", { textContent: "formwork" }), status),
      body,
      el("footer", {
        textContent: "formwork never submits. Review the highlights, then submit yourself.",
      })
    )
  );

  const show = (...nodes) => body.replaceChildren(...nodes);
  const setStatus = (text, cls = "") => {
    status.textContent = text;
    status.className = `sub ${cls}`;
  };

  /* ------------------------------------------------------------------- flow */

  async function run() {
    fillBtn.disabled = true;
    setStatus("reading the form…");
    show(el("div", { className: "note", textContent: "Scanning fields and opening dropdowns…" }));

    // This document, plus every embedded frame — the ATS form is usually in one.
    // runFrame() rather than summarize() directly, so the top frame reports a
    // closed form the same way a sub-frame does.
    const local = await ns.runFrame();
    const frames = (await send("fanout", {})) || [];
    const all = [
      ...(local ? [{ ...local, frameId: 0 }] : []),
      ...frames.filter((f) => f && f.summary).map((f) => ({ ...f.summary, frameId: f.frameId })),
    ];
    const parts = all.filter((p) => !p.hiddenOnly);
    const closed = all.filter((p) => p.hiddenOnly);

    fillBtn.disabled = false;

    if (!parts.length) {
      // A closed form is a different situation from an absent one, and the
      // user can act on it — so say which it is and offer to open it.
      if (closed.length) {
        const n = closed.reduce((sum, p) => sum + p.hiddenFields, 0);
        setStatus("form not open", "pending");
        const openBtn = el("button", { className: "primary", textContent: "Open the form & fill" });
        openBtn.onclick = async () => {
          openBtn.disabled = true;
          setStatus("opening the form…");
          const opened = await send("reveal", {});
          if (!opened?.revealed) {
            setStatus("could not open", "err");
            openBtn.disabled = false;
            return;
          }
          await run();
        };
        show(
          el("div", {
            className: "note",
            textContent:
              `This page has an application form with ${n} field(s), but it is not open yet — ` +
              "usually behind an Apply button. formwork can open it, or you can click Apply yourself.",
          }),
          el("div", { className: "row" }, openBtn, fillBtn)
        );
        return;
      }

      setStatus("no form found", "err");
      show(
        el("div", {
          className: "note",
          textContent:
            "No application form on this page. If the form is behind a button, open it first, then run formwork again.",
        }),
        el("div", { className: "row" }, fillBtn)
      );
      return;
    }

    const total = (k) => parts.reduce((n, p) => n + (p[k]?.length ?? p[k] ?? 0), 0);
    setStatus(`${total("filled")} filled`, "ok");
    render(parts);
  }

  function render(parts) {
    const nodes = [];
    const flat = (k) => parts.flatMap((p) => p[k] || []);
    const filled = parts.reduce((n, p) => n + (p.filled || 0), 0);
    const corrected = flat("corrected");
    const review = flat("review");
    const failed = flat("failed");
    const missing = flat("missingRequired");
    const mapError = parts.find((p) => p.mapError)?.mapError;

    nodes.push(
      el(
        "div",
        { className: "stat" },
        el("span", {}, el("b", { textContent: String(filled) }), " filled"),
        el("span", {}, el("b", { textContent: String(review.length) }), " to review"),
        el("span", {}, el("b", { textContent: String(corrected.length) }), " corrected"),
        el("span", {}, el("b", { textContent: String(failed.length) }), " failed")
      )
    );

    if (parts.some((p) => p.frameId)) {
      nodes.push(
        el("div", { className: "note", textContent: "Form found in an embedded frame on this page." })
      );
    }
    if (mapError) {
      nodes.push(
        el("div", {
          className: "err",
          textContent: `Model call failed (${mapError}). Only fields derived from your profile were filled.`,
        })
      );
    }

    nodes.push(el("div", { className: "row" }, fillBtn));

    if (corrected.length) nodes.push(section("Corrected from your profile", corrected));
    if (review.length) nodes.push(section("Needs your eye (amber)", review.map((r) => `${r.label}: ${r.reason}`)));
    if (failed.length) nodes.push(section("Could not be set (red)", failed));
    if (missing.length) nodes.push(section("Required, still empty", missing));

    const drafts = parts.flatMap((p) => (p.drafts || []).map((d) => ({ ...d, frameId: p.frameId, autoApprove: p.autoApprove })));
    if (drafts.length) {
      const sect = el("div", { className: "sect" }, el("h4", { textContent: "Drafts awaiting approval" }));
      for (const item of drafts) sect.append(draftCard(item));
      nodes.push(sect);
    }

    show(...nodes);
  }

  function section(title, lines) {
    const list = el("ul");
    for (const line of lines.slice(0, 12)) list.append(el("li", { textContent: line }));
    return el("div", { className: "sect" }, el("h4", { textContent: title }), list);
  }

  /**
   * One staged draft. The text is not written to the page until Approve is
   * pressed — that click is the only path from a draft to a filled field.
   */
  function draftCard(item) {
    const box = el("textarea", { value: item.text });
    const mark = el("span", { className: "pending", textContent: "awaiting approval" });
    const approve = el("button", { className: "primary", textContent: "Approve & fill" });
    const regen = el("button", { textContent: "Regenerate" });

    approve.onclick = async () => {
      approve.disabled = true;
      mark.className = "pending";
      mark.textContent = "filling…";
      const res = item.frameId
        ? await send("approveInFrame", { frameId: item.frameId, id: item.id, text: box.value })
        : await ns.fillApproved(item.id, box.value);

      if (!res?.ok) {
        mark.className = "err";
        mark.textContent = res?.reason || "could not write to the page";
        approve.disabled = false;
        return;
      }
      mark.className = "ok";
      mark.textContent = "approved and filled";
      await send("approve", {
        question: item.question,
        answer: box.value,
        company: res.company,
        role: res.title,
        // A "why us" answer is company-specific; a "proudest project" is not.
        companySpecific: /this (company|role|position)|why (do you |are you )?(want|interested)/i.test(
          item.question
        ),
      });
    };

    regen.onclick = async () => {
      regen.disabled = true;
      mark.textContent = "re-drafting…";
      const fresh = await send("redraft", { question: item.question });
      regen.disabled = false;
      mark.className = "pending";
      mark.textContent = "awaiting approval";
      if (fresh?.text) box.value = fresh.text;
    };

    const card = el(
      "div",
      { className: "draft" },
      el("div", { className: "q", textContent: item.question }),
      el("div", { className: "origin", textContent: item.note }),
      box,
      el("div", { className: "row" }, approve, regen, mark)
    );

    if (item.autoApprove) approve.click();
    return card;
  }

  /* ------------------------------------------------------------------ mount */

  fillBtn.onclick = run;
  show(
    el("div", {
      className: "note",
      textContent: "Fills this application from your profile. Nothing is submitted.",
    }),
    el("div", { className: "row" }, fillBtn)
  );

  /**
   * Mount the panel, and keep it mounted.
   *
   * A content script running at document_idle can land mid-hydration. When a
   * React app's hydration fails it discards the server-rendered DOM and
   * re-renders from scratch, taking any node we already inserted with it — the
   * panel mounts, disappears milliseconds later, and nothing errors.
   */
  let dismissed = false;
  const mount = () => {
    if (!dismissed && !host.isConnected) document.documentElement.append(host);
  };

  mount();
  new MutationObserver(mount).observe(document.documentElement, { childList: true });
  setTimeout(mount, 1500);

  ns._panel = {
    toggle() {
      dismissed = host.isConnected;
      if (dismissed) host.remove();
      else mount();
    },
  };

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "formwork/toggle") ns._panel.toggle();
    });
  } catch (err) {
    ns._listenerError = String(err && err.message ? err.message : err);
  }
})();
