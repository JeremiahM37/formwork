/**
 * The job aggregator's normalising and filtering.
 *
 * Everything here is offline: the network shapes are captured in
 * tests/fixtures/listings.json and tests/fixtures/greenhouse-cloudflare.json,
 * taken from the live sources. The point is that the two source families —
 * community lists and applicant tracking system boards — collapse into one
 * record shape that the rest of the tool can reason about, and that the filters
 * never hand back a posting you cannot actually apply to.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers/load.mjs";
import {
  normalizeGithub,
  normalizeBoard,
  dedupe,
  filterJobs,
  excludesSponsorship,
  GITHUB_LISTS,
  DEFAULT_BOARDS,
} from "../../tools/find-jobs.mjs";

const fixture = (name) => JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", name), "utf8"));
const listings = fixture("listings.json");
const github = listings.map((j) => normalizeGithub(j, "new-grad"));
const byCompany = (name) => github.find((j) => j.company === name);

test("a community listing becomes a record the filler can use", () => {
  const job = byCompany("Northwind Systems");
  assert.equal(job.source, "github:new-grad");
  assert.equal(job.title, "New Grad Backend Engineer");
  assert.equal(job.url, "https://boards.greenhouse.io/northwind/jobs/4001");
  assert.deepEqual(job.locations, ["Asheville, NC", "Remote in USA"]);
  assert.equal(job.posted.slice(0, 4), "2026", "epoch seconds, not milliseconds");
  assert.equal(job.active, true);
});

test("string-typed booleans and Python list literals are parsed", () => {
  // Not every list publishes real JSON types; one of the three does not.
  const job = byCompany("Stringly Typed Inc");
  assert.equal(job.active, true, '"true" is not a truthy accident — it is parsed');
  assert.deepEqual(job.locations, ["Denver, CO", "Remote"]);
});

test("a listing that is closed or delisted is not active", () => {
  assert.equal(byCompany("Mechanize").active, false, "active:false means the role is gone");
  assert.equal(byCompany("Hidden Corp").active, false, "is_visible:false means it was pulled");
});

test("closed postings are filtered out — applying to them wastes the user's day", () => {
  const open = filterJobs(github);
  assert.equal(open.length, 3);
  assert.equal(
    open.some((j) => j.company === "Mechanize" || j.company === "Hidden Corp"),
    false
  );
});

/** Real responses from the three board APIs, trimmed to the fields used. */
const boards = fixture("boards.json");

test("all three board APIs normalise to one shape", () => {
  for (const [ats, raws] of Object.entries(boards)) {
    for (const raw of raws) {
      const job = normalizeBoard(raw, ats, "acme");
      assert.equal(job.source, `${ats}:acme`, ats);
      assert.ok(job.title, `${ats}: a title`);
      assert.ok(/^https?:\/\//.test(job.url), `${ats}: a fetchable url, got ${job.url}`);
      assert.ok(job.locations.length, `${ats}: a location`);
      assert.ok(job.posted?.startsWith("20"), `${ats}: a real date, got ${job.posted}`);
      assert.equal(job.active, true, "a board only publishes open roles");
    }
  }
});

test("a Lever posting points at the application form, not the advert", () => {
  assert.match(normalizeBoard(boards.lever[0], "lever", "palantir").url, /\/apply$/);
  // Older board responses omit applyUrl; the form URL is still reachable.
  const derived = normalizeBoard(
    { text: "Backend Engineer", hostedUrl: "https://jobs.lever.co/acme/xyz/", categories: { location: "Remote" } },
    "lever",
    "acme"
  );
  assert.equal(derived.url, "https://jobs.lever.co/acme/xyz/apply");
  assert.deepEqual(derived.locations, ["Remote"]);
});

test("an Ashby posting keeps its title clean", () => {
  // Ashby serves this one with a leading space; it would break title filters
  // anchored with ^ and misalign every listing printed after it.
  assert.equal(boards.ashby[0].title.startsWith(" "), true, "fixture still has the quirk");
  assert.equal(normalizeBoard(boards.ashby[0], "ashby", "ramp").title, "Security Engineer, Cloud");
});

test("an unparseable date becomes null rather than Invalid Date", () => {
  const job = normalizeBoard({ title: "Engineer", applyUrl: "https://x.test/a", location: "SF", createdAt: "soon" }, "ashby", "x");
  assert.equal(job.posted, null, "a bad date must not poison sorting or the age filter");
});

const posting = (url, extra = {}) => ({ company: "Northwind Systems", title: "New Grad Backend Engineer", locations: [], posted: null, active: true, url, ...extra });

test("the same posting found twice appears once", () => {
  // The community lists overlap heavily with each other and with the boards,
  // and the same posting arrives with tracking parameters, a bare protocol
  // difference, or pointing at the advert rather than its own form.
  const same = "https://boards.greenhouse.io/northwind/jobs/4001";
  const jobs = dedupe([
    ...github,
    posting(`${same}?gh_src=tracking`),
    posting(same),
    posting(`${same}/application`),
    posting(same.replace("https://", "http://www.")),
  ]);
  assert.equal(jobs.filter((j) => /northwind/i.test(j.company)).length, 1);
});

test("the surviving copy is the one that lands on the form", () => {
  const advert = "https://jobs.ashbyhq.com/acme/abc-123";
  const [job] = dedupe([posting(advert), posting(`${advert}/application`)]);
  assert.equal(job.url, `${advert}/application`, "skip the advert page when a direct form URL exists");
});

test("different openings under one title are all kept", () => {
  // A large employer runs dozens of distinct reqs named "Software Engineer".
  // Deduplicating on company and title hid 53 of Microsoft's 54 in a live
  // pull; every one of them is a job the user could have applied to.
  const reqs = [1, 2, 3, 4].map((n) =>
    posting(`https://apply.careers.microsoft.com/careers/job/19703935566${n}`, {
      company: "Microsoft",
      title: "Software Engineer",
      locations: [n > 2 ? "Remote in USA" : "Redmond, WA"],
    })
  );
  assert.equal(dedupe(reqs).length, 4);
});

test("a posting with no url is dropped — there is nothing to open", () => {
  assert.deepEqual(dedupe([{ company: "Ghost", title: "Engineer", url: "", locations: [], active: true }]), []);
});

test("filters narrow by title, location and age", () => {
  const q = (opts) => filterJobs(github, opts).map((j) => j.company);
  assert.deepEqual(q({ query: "backend" }), ["Northwind Systems"]);
  assert.deepEqual(q({ location: "New York" }), ["Hollow Point Labs"]);
  assert.deepEqual(q({ remoteOnly: true }).sort(), ["Northwind Systems", "Stringly Typed Inc"]);
  assert.equal(
    q({ since: 30 }).includes("Hollow Point Labs"),
    false,
    "posted in 2023 — stale, however recently the row was touched"
  );
});

test("a candidate who needs sponsorship is not shown roles closed to them", () => {
  const open = filterJobs(github, { needsSponsorship: true }).map((j) => j.company);
  assert.equal(open.includes("Northwind Systems"), false, '"Does Not Offer Sponsorship"');
  assert.equal(open.includes("Hollow Point Labs"), false, '"U.S. Citizenship is Required"');
  assert.deepEqual(open, ["Stringly Typed Inc"], "unknown status is still worth applying to");
});

test("sponsorship is only excluded on an explicit statement", () => {
  // Most listings say "Other", which means the list does not know. Treating
  // that as a refusal would hide the majority of the board.
  for (const value of ["Other", "", null, undefined])
    assert.equal(excludesSponsorship({ sponsorship: value }), false, JSON.stringify(value));
  for (const value of ["Does Not Offer Sponsorship", "U.S. Citizenship is Required", "Security Clearance required"])
    assert.equal(excludesSponsorship({ sponsorship: value }), true, value);
});

test("an unmatched filter yields nothing rather than everything", () => {
  assert.deepEqual(filterJobs(github, { query: "quantum blacksmith" }), []);
});

test("no source reaches a site that forbids automated access", () => {
  // LinkedIn, Indeed and Simplify's own board are login-walled and their terms
  // prohibit scraping. Data flows from public APIs only; a regression here
  // would put the user's own accounts at risk.
  const targets = [
    ...GITHUB_LISTS.map((l) => l.repo),
    ...Object.values(DEFAULT_BOARDS).flat(),
    readFileSync(join(ROOT, "tools", "find-jobs.mjs"), "utf8")
      .split("\n")
      .filter((l) => /fetch\(|https:\/\//.test(l) && !l.trim().startsWith("*"))
      .join("\n"),
  ].join("\n");
  for (const banned of ["linkedin.com", "indeed.com", "api.simplify.jobs", "glassdoor"]) {
    assert.equal(targets.toLowerCase().includes(banned), false, `${banned} must not be a source`);
  }
});
