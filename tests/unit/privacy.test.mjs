/**
 * Guards against personal data reaching a public repository.
 *
 * Deliberately pattern-based rather than identity-based: a test that listed the
 * maintainer's real name, address and phone number in order to forbid them
 * would itself be the leak. Instead it looks for the *shapes* of private data —
 * real email addresses, phone numbers, private-range and CGNAT/Tailscale
 * addresses, absolute home paths, and API-key prefixes — so it protects any
 * contributor, not just the author.
 *
 * Scope is "what could be committed": tracked files plus untracked files that
 * .gitignore does not exclude. The maintainer's own `profile/private/` working
 * data is ignored by git and therefore correctly out of scope.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, extname } from "node:path";
import { ROOT } from "../helpers/load.mjs";

/** Files that would end up in a clone. */
function committableFiles() {
  try {
    return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return null; // not a git checkout — the test skips rather than lying
  }
}

const BINARY = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".ico", ".zip", ".woff", ".woff2"]);

/** This file states the patterns, so scanning it would match on itself. */
const SELF = "tests/unit/privacy.test.mjs";

const RULES = [
  {
    name: "real email address",
    // Reserved example domains (RFC 2606) and .test are legitimate in fixtures.
    re: /\b[\w.+-]+@(?!example\.(com|org|net)\b)(?!\w+\.test\b)[\w-]+\.[a-z]{2,}\b/gi,
  },
  {
    name: "phone number",
    // 555-01xx is the reserved fictional range; anything else looks real.
    re: /\b(?!\d{3}[-.\s]?555[-.\s]?01\d{2})\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g,
  },
  {
    name: "private or CGNAT IP address",
    // 10/8, 172.16/12, 192.168/16 and the 100.64/10 range Tailscale draws from.
    re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g,
  },
  {
    name: "absolute home directory path",
    re: /\/(?:home|Users)\/(?!me\b|you\b|user\b)[a-z][\w.-]*\//gi,
  },
  {
    name: "API key or token",
    re: /\b(?:sk-ant-[\w-]{8,}|sk-proj-[\w-]{8,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[\w-]{10,})\b/g,
  },
];

const files = committableFiles();

test("no private data in any committable file", { skip: files ? false : "not a git checkout" }, () => {
  const findings = [];

  for (const rel of files) {
    if (rel === SELF || BINARY.has(extname(rel).toLowerCase())) continue;
    const abs = join(ROOT, rel);
    let text;
    try {
      if (statSync(abs).size > 2_000_000) continue;
      text = readFileSync(abs, "utf8");
    } catch {
      continue; // deleted between listing and reading, or unreadable
    }

    for (const rule of RULES) {
      for (const match of text.match(rule.re) || []) {
        findings.push(`${rel}: ${rule.name} — ${match}`);
      }
    }
  }

  assert.deepEqual(findings, [], `private data found in committable files:\n  ${findings.join("\n  ")}`);
});

test("the maintainer's working profile is never committable", { skip: files ? false : "not a git checkout" }, () => {
  // profile/private/ holds a real résumé, contact details and answers. It must
  // stay out of git no matter what else changes.
  const leaked = files.filter((f) => f.startsWith("profile/private/"));
  assert.deepEqual(leaked, [], `private working files are committable: ${leaked.join(", ")}`);
});

test("the example persona is fictional, not a copy of a real profile", () => {
  const example = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/profile.example.json"), "utf8"));
  assert.match(example.identity.email, /@example\.com$/, "fixtures must use a reserved domain");
  assert.match(example.identity.phone, /555-01\d{2}$/, "fixtures must use the reserved 555-01xx range");
});
