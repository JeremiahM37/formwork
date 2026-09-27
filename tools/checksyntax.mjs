/**
 * Parse every shipped file and validate the manifest.
 *
 * Cheap standing guard: a syntax error in a content script produces no error
 * anywhere the user can see — Chrome injects nothing and the panel simply never
 * appears.
 */
import { readFileSync, readdirSync, statSync, copyFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, extname, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Typecheck and rebuild the React panel before checking shipped artifacts.
execFileSync("npm", ["run", "build:extension"], {cwd:ROOT, stdio:"inherit"});

const scratch = mkdtempSync(join(tmpdir(), "formwork-lint-"));

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

/** node infers the grammar from the extension, so ES modules are checked as .mjs. */
function check(file) {
  const isModule = readFileSync(file, "utf8").match(/^\s*import\s|^\s*export\s/m);
  let target = file;
  if (isModule) {
    target = join(scratch, `${basename(file, ".js")}.mjs`);
    copyFileSync(file, target);
  }
  execFileSync(process.execPath, ["--check", target], { stdio: "pipe" });
}

let failed = 0;
// The dashboard's script is here for the same reason the extension's are: a
// syntax error in it produces no error anywhere the user looks either. The page
// renders its shell and then simply stays empty.
const files = [...walk(join(ROOT, "extension")), ...walk(join(ROOT, "server", "dashboard", "static"))]
  .filter((f) => extname(f) === ".js");

for (const file of files) {
  try {
    check(file);
  } catch (err) {
    console.error(`FAIL ${file.replace(ROOT + "/", "")}\n  ${String(err.stderr).slice(0, 300)}`);
    failed++;
  }
}

const manifest = JSON.parse(readFileSync(join(ROOT, "extension", "manifest.json"), "utf8"));
const referenced = [...manifest.content_scripts.flatMap((c) => c.js), manifest.background.service_worker];
for (const script of referenced) {
  try {
    statSync(join(ROOT, "extension", script));
  } catch {
    console.error(`FAIL manifest references a missing file: ${script}`);
    failed++;
  }
}

console.log(
  `${files.length} JS files parsed, manifest v${manifest.manifest_version} references ` +
    `${referenced.length} scripts — ${failed} failure(s)`
);
process.exit(failed ? 1 : 0);
