/** Shared test helpers: module loading and fixtures. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..");

const require = createRequire(import.meta.url);

/** Load one of the extension's UMD library modules. */
export const lib = (name) => require(join(ROOT, "extension", "src", "lib", `${name}.js`));

export const fixture = (name) =>
  JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", name), "utf8"));

export const profile = () => fixture("profile.example.json");
export const greenhouse = () => fixture("greenhouse-cloudflare.json");

/** A schema built from field literals, for focused unit tests. */
export const schemaOf = (...fields) => ({
  ats: "test",
  url: "https://example.test/apply",
  title: "Staff Engineer",
  company: "Testcorp",
  fields: fields.map((f, i) => ({ id: f.id ?? `f${i}`, required: false, type: "text", ...f })),
});

/** A provider stand-in: returns canned replies and records what it was sent. */
export function fakeProvider({ json = {}, text = "drafted answer", fail = null } = {}) {
  const calls = [];
  return {
    calls,
    name: "fake",
    async chat(messages, opts = {}) {
      calls.push({ messages, opts });
      if (fail) throw new Error(fail);
      return opts.json ? JSON.stringify(json) : text;
    },
  };
}
