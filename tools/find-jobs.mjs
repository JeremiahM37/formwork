/**
 * Job aggregator — build a queue of application URLs for formwork to fill.
 *
 * Two source families, both public and structured:
 *
 *   - Community job lists on GitHub (new-grad and internship trackers). They
 *     publish a machine-readable listings.json, so this is a fetch, not a scrape.
 *   - Applicant tracking system board APIs (Greenhouse, Lever, Ashby), which
 *     every company using them exposes publicly for their own careers page.
 *     This is the path for experienced roles, which the new-grad lists omit.
 *
 * Deliberately NOT included: LinkedIn, Indeed and Simplify. All three forbid
 * automated access in their terms, sit behind logins and anti-bot systems, and
 * offer no public jobs API to use instead — scraping them risks the account you
 * job-hunt with, for data these sources already cover.
 *
 * Usage:
 *   node tools/find-jobs.mjs --query "software engineer|backend" --since 14
 *   node tools/find-jobs.mjs --boards cloudflare,stripe --needs-sponsorship
 *   node tools/find-jobs.mjs --out queue.json --limit 50
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ sources */

export const GITHUB_LISTS = [
  { name: "new-grad", repo: "SimplifyJobs/New-Grad-Positions" },
  { name: "internships", repo: "SimplifyJobs/Summer2026-Internships" },
  { name: "new-grad-alt", repo: "vanshb03/New-Grad-2026" },
];

/** Companies whose ATS boards to poll for roles at any experience level. */
export const DEFAULT_BOARDS = {
  greenhouse: ["cloudflare", "stripe", "databricks", "figma", "reddit", "coinbase", "gitlab"],
  lever: ["palantir"],
  ashby: ["linear", "ramp", "notion", "vanta", "replit"],
};

const UA = { "User-Agent": "formwork-job-aggregator (+https://github.com/JeremiahM37/formwork)" };

async function getJSON(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // one dead source must not sink the run
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------- normalise */

/**
 * Community lists store everything as strings — including booleans and a
 * Python-style list literal for locations — so parse defensively.
 */
export function normalizeGithub(raw, listName) {
  const bool = (v) => v === true || String(v).toLowerCase() === "true";
  const locations = (() => {
    if (Array.isArray(raw.locations)) return raw.locations;
    try {
      return JSON.parse(String(raw.locations || "[]").replace(/'/g, '"'));
    } catch {
      return String(raw.locations || "")
        .split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  })();

  return {
    source: `github:${listName}`,
    company: raw.company_name || "",
    title: raw.title || "",
    locations,
    url: raw.url || "",
    posted: raw.date_posted ? new Date(Number(raw.date_posted) * 1000).toISOString() : null,
    sponsorship: raw.sponsorship || null,
    active: bool(raw.active) && bool(raw.is_visible ?? true),
  };
}

export function normalizeBoard(raw, ats, company) {
  // Lever ships epoch milliseconds, the others ISO 8601.
  const posted = raw.updated_at || raw.createdAt || raw.publishedAt || raw.created_at || null;
  const at = posted ? new Date(typeof posted === "number" ? posted : String(posted)) : null;

  // Lever and Ashby distinguish the advert from the form; Greenhouse embeds
  // the form in the advert, so its one URL is both. Fall back to deriving
  // Lever's form URL for the older board responses that omit applyUrl.
  const url =
    raw.applyUrl ||
    raw.absolute_url ||
    (ats === "lever" && raw.hostedUrl ? `${String(raw.hostedUrl).replace(/\/$/, "")}/apply` : "") ||
    raw.jobUrl ||
    "";

  return {
    source: `${ats}:${company}`,
    company,
    // Ashby titles sometimes carry a leading space straight from the board.
    title: String(raw.title || raw.text || "").trim(),
    locations: [raw.location?.name || raw.categories?.location || raw.location || ""]
      .filter(Boolean)
      .map((l) => String(l).trim()),
    url,
    posted: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
    sponsorship: null,
    active: true,
  };
}

/* ----------------------------------------------------------------- filters */

/**
 * Identity of a posting, for deduplication.
 *
 * The URL is the only trustworthy identity. Company plus title is not: a large
 * employer runs dozens of genuinely different openings under one title — 54
 * distinct "Software Engineer" reqs at Microsoft in a single pull — and keying
 * on the title hides all but one of them. A duplicate costs a click; a hidden
 * posting costs the job.
 *
 * So normalise away the things that vary without changing which posting it is:
 * tracking parameters, the protocol, `www.`, and the trailing `/apply` or
 * `/application` segment that distinguishes an advert from its own form.
 */
export function postingKey(url) {
  return String(url)
    .split(/[?#]/)[0]
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/(apply|application)\/?$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/** Same posting reached two ways is one job. */
export function dedupe(jobs) {
  const seen = new Map();
  for (const job of jobs) {
    if (!job.url) continue;
    const key = postingKey(job.url);
    // Keep the first sighting, but prefer a URL that lands on the form itself.
    if (!seen.has(key)) seen.set(key, job);
    else if (/\/(apply|application)\/?$/i.test(job.url) && !/\/(apply|application)\/?$/i.test(seen.get(key).url))
      seen.set(key, job);
  }
  return [...seen.values()];
}

/**
 * Whether a posting is closed to someone who needs visa sponsorship.
 *
 * Only excludes on an explicit statement. "Other" and a missing value mean the
 * list does not know — and a posting of unknown status is worth an application,
 * whereas one that says "U.S. Citizenship is Required" is not.
 */
export function excludesSponsorship(job) {
  return /does not offer sponsorship|citizenship is required|no sponsorship|clearance/i.test(
    job.sponsorship || ""
  );
}

export function filterJobs(
  jobs,
  { query, location, since, remoteOnly, needsSponsorship, activeOnly = true } = {}
) {
  const titleRe = query ? new RegExp(query, "i") : null;
  const locRe = location ? new RegExp(location, "i") : null;
  const cutoff = since ? Date.now() - since * 86400000 : null;

  return jobs.filter((job) => {
    if (activeOnly && !job.active) return false;
    if (needsSponsorship && excludesSponsorship(job)) return false;
    if (titleRe && !titleRe.test(job.title)) return false;
    const locs = job.locations.join(", ");
    if (locRe && !locRe.test(locs)) return false;
    if (remoteOnly && !/remote|anywhere/i.test(locs)) return false;
    if (cutoff && job.posted && Date.parse(job.posted) < cutoff) return false;
    return true;
  });
}

/* -------------------------------------------------------------- collection */

export async function fetchGithubLists(lists = GITHUB_LISTS) {
  const out = [];
  for (const { name, repo } of lists) {
    const data = await getJSON(
      `https://raw.githubusercontent.com/${repo}/dev/.github/scripts/listings.json`
    );
    if (Array.isArray(data)) out.push(...data.map((j) => normalizeGithub(j, name)));
  }
  return out;
}

export async function fetchBoards(boards = DEFAULT_BOARDS) {
  const out = [];
  for (const company of boards.greenhouse || []) {
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${company}/jobs`);
    for (const j of d?.jobs || []) out.push(normalizeBoard(j, "greenhouse", company));
  }
  for (const company of boards.lever || []) {
    const d = await getJSON(`https://api.lever.co/v0/postings/${company}?mode=json`);
    for (const j of Array.isArray(d) ? d : []) out.push(normalizeBoard(j, "lever", company));
  }
  for (const company of boards.ashby || []) {
    const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${company}`);
    for (const j of d?.jobs || []) out.push(normalizeBoard(j, "ashby", company));
  }
  return out;
}

/* --------------------------------------------------------------------- cli */

// Importing this file (tests, other tools) must not trigger a network run.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const has = (name) => process.argv.includes(`--${name}`);

  const boards = arg("boards")
    ? { greenhouse: arg("boards").split(","), lever: [], ashby: [] }
    : DEFAULT_BOARDS;

  process.stderr.write("fetching community lists…\n");
  const github = has("no-github") ? [] : await fetchGithubLists();
  process.stderr.write(`  ${github.length} listings\nfetching ATS boards…\n`);
  const board = has("no-boards") ? [] : await fetchBoards(boards);
  process.stderr.write(`  ${board.length} listings\n`);

  const all = dedupe([...github, ...board]);
  const matched = filterJobs(all, {
    query: arg("query"),
    location: arg("location"),
    since: arg("since") ? Number(arg("since")) : null,
    remoteOnly: has("remote"),
    needsSponsorship: has("needs-sponsorship"),
  }).sort((a, b) => (b.posted || "").localeCompare(a.posted || ""));

  const limit = Number(arg("limit", 40));
  const picked = matched.slice(0, limit);

  console.log(`\n${all.length} unique postings · ${matched.length} match · showing ${picked.length}\n`);
  for (const job of picked) {
    const when = job.posted ? job.posted.slice(0, 10) : "—";
    console.log(
      `${when}  ${job.company.slice(0, 22).padEnd(23)}${job.title.slice(0, 46).padEnd(47)}` +
        `${job.locations.join(", ").slice(0, 24)}`
    );
  }

  const out = arg("out");
  if (out) {
    writeFileSync(out, JSON.stringify(picked, null, 1));
    console.log(`\nwrote ${picked.length} postings to ${out}`);
  }
  console.log("\nOpen any of these and click formwork — nothing is applied for automatically.");
}
