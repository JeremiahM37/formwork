# formwork

Fill any job application from your own profile — locally, with every answer reviewable before you submit.

![formwork filling a Greenhouse application](docs/panel.png)

Job-application autofill exists, but the good ones are SaaS: you hand a company your full work history, contact details and résumé, and pay a subscription to have it typed back into forms. formwork does the same job from your own machine, against your own model, and shows you exactly what it did.

---

## What it does

- **Fills any application form**, on any applicant tracking system, without a single per-ATS selector. Reads the form's own semantics instead.
- **Answers factual questions with no model at all** — name, contact details, address, work authorisation, EEO answers, education, start date. These come straight from your profile.
- **Drafts the open-ended ones** from notes you write, into a staging area you approve before anything is typed.
- **Reuses your approved answers** on later forms, matched by intent rather than wording.
- **Attaches your résumé and cover letter** to upload fields.
- **Creates accounts** on systems that make you register before applying, from credentials the model is never shown.
- **Opens forms that are collapsed** behind an Apply button, and fills forms embedded in an iframe on a company's own careers site.
- **Handles the widgets that break naive autofill**: portalled menus, virtualised option lists thousands long, dropdowns built as buttons, two-level category pickers, segmented date fields, and autocompletes that discard anything not chosen from their own suggestions.
- **Refuses bot traps** — the hidden fields applicant tracking systems plant to catch robots.
- **Reports what it could not answer**, rather than guessing. A field is either right or visibly blank.
- **Never submits.** You review and click Submit.

Alongside the extension: a **résumé parser** that builds your profile from LaTeX, a **job aggregator** that assembles a queue of postings worth applying to, and two **harnesses** that check formwork against live forms.

---

## What makes it different

**No selector maps.** Most autofill tools hard-code CSS selectors per applicant tracking system. Every ATS redesign breaks them, so maintenance never ends. formwork reads the form's own semantics — labels, `aria-*`, option lists — and asks a model to map them onto your profile. A layout change costs nothing.

**The model is not trusted.** It proposes; a validation layer decides. Two classes of field are *pinned* to your profile and the model's answer is discarded even when it agrees:

- **Contact identity** — name, email, phone, links, location. Deterministic, so no model is needed. These are also stripped from the prompt entirely, which means **no personally identifying detail is ever sent to a model**, including in bring-your-own-key mode.
- **Demographics, work authorisation, criminal history, salary.** A plausible-looking wrong answer to *"are you Hispanic or Latino?"* is far worse than a blank field.

This is not defensive theatre. Measured against a local 35B on a real Greenhouse form, the model fabricated a gender from the candidate's *name*, contradicted their stated veteran status, rewrote a GitHub URL to the wrong username, and typo'd an email — all in runs where it was explicitly told not to. Prompt rules are a request. Validation is a guarantee.

**Embedded forms work.** Most companies host the posting on their own domain and embed the ATS form in an iframe. formwork runs in every frame: the panel stays in the top window, the filling happens in the frame that actually holds the form. Filling only the top document would miss the majority of live postings.

**Nothing is submitted.** formwork fills and highlights. You review and click Submit.

---

## Install

No store listing yet — load it unpacked:

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the `extension/` directory.
4. Open formwork's **Options** and add a profile (below).

## Setup

**On first install, formwork opens a guided setup** — eleven short steps covering who you
are, where you live, work eligibility, voluntary disclosures, your résumé, account
credentials and a drafting model. Every step is skippable, and a partial profile still
fills the fields it covers. Re-run it any time from Settings → *Run guided setup…*.

Everything below is the manual route, and is worth reading if you keep your résumé in
LaTeX — the parser fills in far more than the wizard asks for.

### 1. Profile

Your profile is structured JSON. If you keep your résumé in LaTeX, generate it:

```bash
python3 tools/parse_resume.py resume.tex -o profile.json
```

Every application also asks things no résumé contains — work authorisation, EEO questions, earliest start date. Put those in an `answers.json` beside the résumé and they are merged in, so re-parsing never clobbers them:

```jsonc
{
  "work_authorization": { "authorized_to_work_us": true, "requires_sponsorship_now": false },
  "demographics": { "gender": "Decline To Self Identify" },
  "preferences": { "earliest_start_date": "Immediately" }
}
```

Anything still unanswered is listed in `_needs_input`, and formwork will leave those fields blank rather than guess. Paste the resulting JSON into Options.

Not a LaTeX user? Write the JSON by hand — `tests/fixtures/profile.example.json` is a complete example.

### 2. About you (optional, but this is the quality lever)

Free-text notes — what you care about, hobbies, why you got into this. Used only when drafting open-ended answers. Drafts written from a résumé alone read like a résumé; drafts written from real notes read like you.

### 3. Account credentials (optional)

Some systems (Workday, iCIMS, SmartRecruiters) make you register before you can apply. Put an email and password in Options and formwork fills those signup and login forms too.

A password is answered **only** from these stored values. The model is never shown them, and a password it proposes anyway is discarded and reported rather than used. They are stored unencrypted in extension storage, so use a password unique to job applications.

### 4. Model

| Provider | Use when |
|---|---|
| **Ollama** | Local and free. Uses the native `/api/chat`. |
| **Homelab API** | You already run a server-side proxy (see `server/jobfill.py`). |
| **OpenAI-compatible** | OpenAI, OpenRouter, LM Studio — anything speaking `/chat/completions`. |
| **Anthropic** | Claude, called directly from the browser. |

> **Ollama users:** point the *Ollama* provider at it, not the OpenAI-compatible one. Ollama's `/v1` shim cannot disable reasoning and returns it in a separate field, leaving `content` empty. Measured on the same form: **3 fields in 73s** through `/v1` versus **16 in 6.2s** natively.

> Ollama also rejects `chrome-extension://` origins with a 403. Either start it with `OLLAMA_ORIGINS='chrome-extension://*'`, or route through a server-side proxy like `server/jobfill.py`, where CORS does not apply.

Saving Options asks Chrome for permission to reach your model's host. Decline it and formwork still fills every profile-derived field — it just can't ask the model anything.

---

## How it works

```
  scrape            plan (background worker)              fill
┌──────────┐   ┌────────────────────────────────┐   ┌──────────────┐
│ DOM       │──▶│ prompt (identity redacted)     │──▶│ React-safe   │
│ semantics │   │   ↓                            │   │ writes       │
│ + options │   │ model  →  proposed values      │   │   ↓          │
└──────────┘   │   ↓                            │   │ verify each  │
               │ VALIDATE ── pin sensitive       │   │ field re-read│
               │            snap to profile      │   │   ↓          │
               │            match option lists   │   │ highlight    │
               │   ↓                            │   └──────────────┘
               │ draft essays → staging area     │
               └────────────────────────────────┘
                          nothing auto-submits
```

### The widgets

Writing into plain inputs is not the hard part. Each of these cost real debugging, and each has a fixture so it cannot regress:

- **Comboboxes commit by keyboard, not clicks.** react-select (Greenhouse, Ashby) portals its menu and ignores synthetic clicks on options — the click "succeeds" while nothing is selected. formwork types to filter and commits with `Enter`.
- **A menu belongs to the field that opened it.** Multiselects mark their chosen-pills area `role="listbox"` too, and popups render at the end of `<body>`. Taking "the first open listbox" made two fields report a third one's options — worse than finding none, because the value chosen comes from another question's list.
- **Long lists are virtualised.** About thirteen of 250 countries exist in the DOM at a time, always from the top, and typing does not filter them. The menu is scrolled until the match appears.
- **Some entries are categories.** Clicking "Website" opens a submenu rather than answering; the drill-down follows it, and says so when it has to pick from a list your profile cannot name.
- **A date is one question across three inputs.** Month, day and year sit behind a visible stand-in, each a fraction of a pixel wide. They are written whole or not at all — a half-written date leaves the widget holding `08//`, an error it keeps showing even after correction.
- **Autocompletes want keystrokes.** A place lookup that is handed a value in one go discards it, and one that is focused first blanks itself. Typed character by character without focusing, it resolves.
- **The filler trusts the DOM, not the write.** Every field is re-read after writing, and again once the page settles, because widgets revert asynchronously. `filled` means *confirmed present on the page*; anything that didn't stick gets a red ring instead of a silent success.

### Bot traps

Applicant tracking systems plant fields a person cannot see but a naive autofiller completes, and treat anything typed into one as proof of a robot. Workday's is named `website` and labelled *"This input is for robots only"*, rendered a fraction of a pixel tall with a zero clip-path while reporting itself as perfectly visible.

Filling one risks your account on a site you need, so wording, naming or impossible geometry is each enough to skip a field. The same rule cannot condemn a real question: applicant tracking systems routinely shrink a genuine radio to a pixel and draw their own control over it, so geometry alone never disqualifies a checkbox or radio.

### Free-text answers

Essays are drafted separately and land in a **staging area**. A draft cannot reach the page without an explicit approval — that invariant lives in the data (`needsApproval`), not in a prompt. Auto-approve exists and is off by default.

Approved answers go into an **answer bank**, matched on later forms by wording *and* by intent — "Why do you want to work at X?" and "Why are you interested in this role?" share no significant words but are the same question. A company-neutral answer is reused verbatim (no model call at all); a company-specific one becomes a voice sample for the next draft.

---

## Privacy

- Everything is stored in `chrome.storage.local`. There is no formwork account, server, or telemetry.
- Your name, email, phone, links and location are **never** included in a model request.
- Documents are stored as data URLs in your browser and attached directly to upload fields.
- The only outbound requests are to the model provider *you* configured.

---

## Supported

Content scripts run automatically on Greenhouse, Lever, Workday, Ashby, BambooHR, Workable, Jobvite, SmartRecruiters and iCIMS — including forms those systems embed as iframes into a company's own careers site.

On any **other** site, click the formwork toolbar icon and the panel is injected on demand (`activeTab`), so no permission over every site you visit is required up front. Because the approach is generic rather than per-ATS, it usually works there too.

A read-only sweep of live postings currently reports **zero label problems across Greenhouse, Lever and Ashby** — 41 forms, 521 fields.

**Known limitations:**

- **A content script cannot produce a trusted event.** A few widgets respond only to genuine input — Workday's "How did you hear about us" and its date segments ignore synthetic clicks *and* synthetic keystrokes. formwork reports those as unset and says why; it never claims to have filled one. The Workday harness drives a real browser and can complete them.
- **Workday's own screens are turned by the harness, not the extension.** The extension fills whatever page it is on; `tools/workday.mjs` walks the six-screen flow.
- **Listing pages aren't application pages.** Some `?gh_jid=` links land on a search view with no form anywhere. Nothing to fill.
- **Multi-entry sections are filled once.** A form offering "Add another employer" gets your most recent entry, not your whole history.
- **Cover-letter generation is intentionally minimal** — the drafter refuses to make claims about a company it knows nothing about.

---

## Finding jobs to fill

formwork fills the form in front of you; `tools/find-jobs.mjs` builds the list of
forms worth opening.

```bash
node tools/find-jobs.mjs --query "software engineer|backend" --since 14
node tools/find-jobs.mjs --boards cloudflare,stripe --remote --out queue.json
```

| Flag | Effect |
|---|---|
| `--query <regex>` | Match the job title |
| `--location <regex>` | Match any listed location |
| `--remote` | Only postings listing remote or anywhere |
| `--needs-sponsorship` | Hide roles that state they won't sponsor or require citizenship |
| `--since <days>` | Drop anything posted longer ago than this |
| `--limit <n>` | How many to print and write (default 40) |
| `--out <file>` | Write the matches as JSON |
| `--no-github`, `--no-boards` | Use only one source family |

It aggregates two kinds of **public, structured** source: the community new-grad
and internship trackers on GitHub, which publish a machine-readable
`listings.json` (~34k postings), and the Greenhouse, Lever and Ashby board APIs
that companies expose for their own careers pages — the route to roles above
entry level, which the community lists don't carry.

It deliberately does **not** touch LinkedIn, Indeed or Simplify. All three are
login-walled, prohibit automated access in their terms, and offer no public jobs
API — scraping them would risk the account you job-hunt with, for postings these
sources already carry. A test asserts none of those hosts ever becomes a source.

Nothing is applied to automatically. The tool produces URLs; you open them.

---

## Checking it against real forms

Two harnesses drive live postings. Neither submits anything.

```bash
node tools/sweep.mjs --from queue.json     # read-only: what would be understood
node tools/workday.mjs <posting-url>       # fills a Workday application, stops at Review
```

`sweep.mjs` loads each posting, runs the scraper and validator over it, and
reports fields found, fields answerable from the profile alone, and any label
that is an internal id, a placeholder or an instruction rather than a question.
It types nothing. It exists because the scraper's rules are about how real
applicant tracking systems build forms, and a change that helps one and quietly
breaks another looks identical from inside the fixture suite.

`workday.mjs` is the exception to "one page at a time": Workday gates the form
behind an account and splits it across six screens. It reuses the extension's
own scrape / validate / fill modules and supplies only what the extension
cannot — getting past the gate, and turning the page. It identifies submission
controls and refuses to click them, and a test enforces that rather than
trusting care.

Where the two disagree, believe the extension. The harness drives a real
browser and can produce trusted events; a content script cannot, so a widget
that only responds to genuine input (Workday's "How did you hear about us", its
date segments) is filled by the harness and honestly reported as unset by the
extension.

---

## Development

```bash
npm install                  # playwright, for the e2e suite only
npx playwright install chromium

npm run test:fast            # unit + integration + parser, offline, ~1s
npm test                     # everything, including real-Chromium e2e
npm run bench -- --provider ollama --base http://localhost:11434
```

| Suite | Covers |
|---|---|
| `tests/unit/` | Pinning, PII redaction, answer-bank matching, provider wire shapes, approval gate, job aggregation |
| `tests/integration/` | The full planning path against a schema captured from a live Greenhouse posting |
| `tests/e2e/` | The real extension in Chromium: first-run setup, fills a served form, attaches a résumé, approves a draft, refuses bot traps |
| `tests/test_parse_resume.py` | LaTeX → profile, including `\entry` slot ordering and detex |

The e2e suite serves both the fixture form and a stub provider, so it is deterministic and needs no network or model.

If you use [`verify`](https://github.com/JeremiahM37/verify), `.verify.yaml` runs all of it plus the deployed endpoint.

---

## Server-side proxy (optional)

`server/jobfill.py` is a FastAPI router for the "Homelab API" provider. It moves messages to Ollama and text back — deliberately dumb, so the prompt has exactly one definition (in the extension) and the self-hosted and BYOK paths cannot drift apart. It also sidesteps browser CORS entirely.

---

## Licence

MIT — see [LICENSE](LICENSE).

Most ATS terms of service prohibit automated *submission*. formwork deliberately does not submit: it fills, you review, you click.
