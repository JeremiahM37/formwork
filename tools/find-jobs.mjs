/**
 * Job aggregator — build a queue of application URLs for formwork to fill.
 *
 * Two source families, both public and structured:
 *
 *   - Optional community job lists on GitHub, configured in job-sources.json. They
 *     publish machine-readable listings, so this is a fetch, not a scrape.
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
 *   node tools/find-jobs.mjs --boards example-company --needs-sponsorship
 *   node tools/find-jobs.mjs --out queue.json --limit 50
 */
import { fetchPublicATS } from "./public-ats.mjs";
import { fetchWorkdayCached, enrichWorkday } from "./workday-source.mjs";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ sources */

const CATALOG = JSON.parse(readFileSync(new URL('./job-sources.json', import.meta.url),'utf8'));
export const GITHUB_LISTS = CATALOG.github;
export const DEFAULT_BOARDS = CATALOG.boards;
const UA = { "User-Agent": "formwork-job-aggregator (+https://github.com/JeremiahM37/formwork)" };
export const SOURCE_HEALTH = [];
export const PUBLIC_FEEDS = CATALOG.feeds;

async function getJSON(url, timeoutMs = 20000, valid = () => true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const report = {url, ok:false, checkedAt:new Date().toISOString()};
  SOURCE_HEALTH.push(report);
  try {
    const res = await fetch(url, { headers: UA, signal: controller.signal });
    report.status = res.status;
    if (!res.ok) {report.error = `HTTP ${res.status}`; return null;}
    const data = await res.json();
    if (!valid(data)) {report.error = "Unexpected response shape"; return null;}
    report.ok = true;
    report.count = Array.isArray(data) ? data.length : (data.jobs || data.data || []).length;
    return data;
  } catch (err) {
    report.error = err.name === "AbortError" ? "Timed out" : String(err.message);
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
  const secondary = Array.isArray(raw.secondaryLocations) ? raw.secondaryLocations : [];
  const countries = [raw.country, raw.address?.postalAddress?.addressCountry,
    ...secondary.map(place=>place.address?.addressCountry || place.address?.postalAddress?.addressCountry)]
    .filter(value=>typeof value === 'string' && value.trim());
  const workplaceType = raw.workplaceType || (raw.isRemote === true ? 'remote' : null);

  return {
    source: `${ats}:${company}`,
    description: String(raw.descriptionPlain || raw.description || raw.content || "").slice(0, 30000),
    company,
    // Ashby titles sometimes carry a leading space straight from the board.
    title: String(raw.title || raw.text || "").trim(),
    locations: [raw.location?.name || raw.categories?.location || raw.location || "", ...secondary.map(place=>place.location || ''),
      ...countries, ...(String(workplaceType).toLowerCase() === 'remote' ? ['Remote'] : [])]
      .filter(Boolean)
      .map((l) => String(l).trim()),
    url,
    posted: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
    sponsorship: null,
    active: raw.isListed !== false,
    countries: [...new Set(countries)], workplaceType,
    employmentType: raw.employmentType || raw.categories?.commitment || null,
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
  let value = String(url);
  // Query IDs distinguish real jobs (?gh_jid=, ?jobId=). Only trackers go.
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_.*|source|ref|referrer|gh_src|lever-source|lever-origin)$/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort(); parsed.hash = ""; value = parsed.href;
  } catch { /* retain malformed input for the caller to report */ }
  return value
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/(apply|application)\/?(?=\?|$)/i, "")
    .replace(/\/(?=\?|$)/, "")
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
    else {
      const previous = seen.get(key);
      const preferred = /\/(apply|application)\/?$/i.test(job.url) && !/\/(apply|application)\/?$/i.test(previous.url) ? job : previous;
      const description = previous.description || job.description;
      seen.set(key, description ? {...preferred, description} : preferred);
    }
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
      `https://raw.githubusercontent.com/${repo}/dev/.github/scripts/listings.json`, 20000, Array.isArray
    );
    if (Array.isArray(data)) out.push(...data.map((j) => normalizeGithub(j, name)));
  }
  return out;
}

export async function fetchBoards(boards = DEFAULT_BOARDS) {
  const out = [];
  for (const company of boards.greenhouse || []) {
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${company}/jobs?content=true`, 20000, d => Array.isArray(d?.jobs));
    for (const j of d?.jobs || []) out.push(normalizeBoard(j, "greenhouse", company));
  }
  for (const company of boards.lever || []) {
    const d = await getJSON(`https://api.lever.co/v0/postings/${company}?mode=json`, 20000, Array.isArray);
    for (const j of Array.isArray(d) ? d : []) out.push(normalizeBoard(j, "lever", company));
  }
  for (const company of boards.ashby || []) {
    const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${company}`, 20000, d => Array.isArray(d?.jobs));
    for (const j of d?.jobs || []) out.push(normalizeBoard(j, "ashby", company));
  }
  const workday = await Promise.all((boards.workday || []).map(url=>fetchWorkdayCached(url, {health:SOURCE_HEALTH,cacheDir:process.env.FORMWORK_FEED_CACHE || join(homedir(),'.cache','formwork-feeds')})));
  out.push(...workday.flat());
  for (const ats of ["smartrecruiters", "rippling"]) {
    for (const company of boards[ats] || []) out.push(...await fetchPublicATS(ats,company,{health:SOURCE_HEALTH,cacheDir:process.env.FORMWORK_FEED_CACHE || join(homedir(),".cache","formwork-feeds")}));
  }
  return out;
}

export function normalizeFeed(raw, source) {
  const date = raw.publication_date || (raw.created_at ? new Date(Number(raw.created_at)*1000).toISOString() : null);
  return {source, company:raw.company_name || "", title:raw.title || "", url:raw.url || "",
    description:String(raw.description || "").slice(0,30000),
    locations:[raw.candidate_required_location || raw.location || "", ...(source === "Remotive" || raw.remote ? ["Remote"] : [])].filter(Boolean),
    posted:date, sponsorship:null, active:true, salary:raw.salary || "",
    workplaceType:source === 'Remotive' || raw.remote === true ? 'remote' : null};
}

export async function fetchPublicFeeds(names = PUBLIC_FEEDS.map(s=>s.name)) {
  const cacheDir = process.env.FORMWORK_FEED_CACHE || join(homedir(),'.cache','formwork-feeds');
  mkdirSync(cacheDir,{recursive:true});
  const out = [];
  for (const source of PUBLIC_FEEDS.filter(s=>names.includes(s.name))) {
    const path = join(cacheDir, source.name + '.json');
    let cached;
    try {cached = JSON.parse(readFileSync(path,'utf8'));} catch { /* first request */ }
    let data;
    if (cached && Date.now()-cached.at < (cached.data ? 6*3600000 : 300000)) {
      data = cached.data;
      SOURCE_HEALTH.push({url:source.url,ok:!!data,cached:true,checkedAt:new Date(cached.at).toISOString(),...(!data ? {error:'Previous request failed; retry after five minutes'} : {})});
    } else {
      data = await getJSON(source.url, 20000, d => Array.isArray(source.name === "Remotive" ? d?.jobs : d?.data));
      writeFileSync(path,JSON.stringify({at:Date.now(),data}));
    }
    const items = data?.jobs || data?.data || [];
    if (Array.isArray(items)) out.push(...items.map(raw=>normalizeFeed(raw,source.name)));
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

  const sources = arg("sources") ? JSON.parse(readFileSync(arg("sources"),"utf8")) : null;
  const boards = sources ? sources : arg("boards")
    ? { greenhouse: arg("boards").split(","), lever: [], ashby: [] }
    : DEFAULT_BOARDS;

  process.stderr.write("fetching community lists…\n");
  const github = (has("no-github") || sources?.github === false) ? [] : await fetchGithubLists();
  process.stderr.write(`  ${github.length} listings\nfetching ATS boards…\n`);
  const board = has("no-boards") ? [] : await fetchBoards(boards);
  process.stderr.write(`  ${board.length} listings\n`);

  const feeds = has("no-feeds") ? [] : await fetchPublicFeeds(sources?.feeds);
  const all = dedupe([...github, ...board, ...feeds]);
  await enrichWorkday(all,{health:SOURCE_HEALTH,cacheDir:process.env.FORMWORK_FEED_CACHE || join(homedir(),'.cache','formwork-feeds')});
  const matched = filterJobs(all, {
    query: arg("query"),
    location: arg("location"),
    since: arg("since") ? Number(arg("since")) : null,
    remoteOnly: has("remote"),
    needsSponsorship: has("needs-sponsorship"),
  }).sort((a, b) => (b.posted || "").localeCompare(a.posted || ""));

  const limit = Number(arg("limit", 40));
  const picked = has("all") ? matched : matched.slice(0, limit);

  console.log(`\n${all.length} unique postings · ${matched.length} match · showing ${picked.length}\n`);
  for (const job of picked) {
    const when = job.posted ? job.posted.slice(0, 10) : "—";
    console.log(
      `${when}  ${job.company.slice(0, 22).padEnd(23)}${job.title.slice(0, 46).padEnd(47)}` +
        `${job.locations.join(", ").slice(0, 24)}`
    );
  }

  const out = arg("out");
  if (arg("health-out")) writeFileSync(arg("health-out"),JSON.stringify(SOURCE_HEALTH));
  if (out) {
    writeFileSync(out, JSON.stringify(picked, null, 1));
    console.log(`\nwrote ${picked.length} postings to ${out}`);
  }
  console.log("\nOpen any of these and click formwork — nothing is applied for automatically.");
}
