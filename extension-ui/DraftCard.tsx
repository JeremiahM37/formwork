import { useEffect, useRef, useState } from "react";
import type { Bridge, Draft, StyleFlag } from "./types";
import { errorText } from "./types";
export function DraftCard({
  item,
  bridge,
  saveContext,
}: {
  item: Draft;
  bridge: Bridge;
  saveContext: () => Promise<void>;
}) {
  const [text, setText] = useState(item.text),
    [instruction, setInstruction] = useState("");
  const [tells, setTells] = useState<StyleFlag[]>(item.tells || []);
  const [mark, setMark] = useState({
    text: "awaiting approval",
    kind: "pending",
  });
  const [busy, setBusy] = useState(false),
    [approved, setApproved] = useState(false);
  const reviewVersion = useRef(0),
    started = useRef(false),
    guidance = useRef<HTMLTextAreaElement>(null);
  const { send, ns } = bridge;
  async function review(value: string) {
    setText(value);
    setApproved(false);
    const version = ++reviewVersion.current;
    try {
      const result = await send("styleReview", { text: value });
      if (version === reviewVersion.current && result?.tells)
        setTells(result.tells);
    } catch {
      /* Editing remains available offline. */
    }
  }
  async function revise(instructions: string, label: string) {
    if (!instructions.trim()) {
      setMark({ text: "Tell me what you want changed first.", kind: "err" });
      guidance.current?.focus();
      return;
    }
    setBusy(true);
    setMark({ text: label, kind: "pending" });
    ++reviewVersion.current;
    try {
      await saveContext();
      const fresh = await send("redraft", {
        question: item.question,
        company: item.company,
        role: item.role,
        previous: text,
        instruction: instructions,
      });
      if (!fresh?.text)
        throw new Error(
          fresh?.error ||
            fresh?.note ||
            "The model returned no revision. Your draft was kept.",
        );
      setText(fresh.text);
      setTells(fresh.tells || []);
      setApproved(false);
      setMark({
        text: fresh.contextWarning || "Revised — review and approve to fill.",
        kind: "pending",
      });
    } catch (error) {
      setMark({ text: `Revision failed: ${errorText(error)}`, kind: "err" });
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    setBusy(true);
    setMark({ text: "filling…", kind: "pending" });
    try {
      const result = item.frameId
        ? await send("approveInFrame", {
            frameId: item.frameId,
            id: item.id,
            text,
          })
        : await ns.fillApproved(item.id, text);
      if (!result?.ok)
        throw new Error(
          result?.reason || result?.error || "could not write to the page",
        );
      setApproved(true);
      setMark({ text: "approved and filled", kind: "ok" });
      try {
        await send("approve", {
          question: item.question,
          answer: text,
          company: item.company || result.company,
          role: item.role || result.title,
          companySpecific:
            /\bfit\b|why|interest|motivat|this role|this position/i.test(
              item.question,
            ),
        });
      } catch {
        setMark({
          text: "Filled. Could not save this answer to your answer bank.",
          kind: "pending",
        });
      }
    } catch (error) {
      setMark({ text: errorText(error), kind: "err" });
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (item.autoApprove && !started.current) {
      started.current = true;
      void approve();
    }
  }, []);
  return (
    <div className="draft" aria-busy={busy}>
      <div className="q">{item.question}</div>
      <div className="origin">{item.note}</div>
      <textarea
        aria-label="Draft answer"
        value={text}
        disabled={busy}
        onChange={(e) => void review(e.target.value)}
      />
      <div
        className="origin"
        title={tells
          .map((t) => `${t.name}: ${(t.found || []).join("; ")}`)
          .join("\n")}
      >
        {tells.length
          ? `Style review: ${tells.map((t) => t.name).join(", ")}`
          : "No style flags (not an authorship test)."}
      </div>
      <label>
        How should this change?
        <textarea
          ref={guidance}
          rows={2}
          style={{ minHeight: 64 }}
          aria-label="How should this change?"
          placeholder="e.g. Make it shorter and more conversational. Focus on my internship."
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </label>
      <div className="row">
        <button
          disabled={busy}
          onClick={() =>
            void revise(instruction, "Revising with your instructions…")
          }
        >
          Revise with instructions
        </button>
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={busy || approved}
          onClick={() => void approve()}
        >
          Approve &amp; fill
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void revise(
              "Write a fresh alternative using the same grounded facts.",
              "Writing an alternative…",
            )
          }
        >
          Regenerate
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void revise(
              tells
                .map((t) => t.fix)
                .slice(0, 5)
                .join(" ") +
                " Preserve all claims and numbers; match my writing samples.",
              "Improving wording…",
            )
          }
        >
          Improve wording
        </button>
        <span className={mark.kind} role="status">
          {mark.text}
        </span>
      </div>
    </div>
  );
}
