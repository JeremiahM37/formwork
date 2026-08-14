/**
 * Benchmark the planning path.
 *
 * Two halves, because they fail differently:
 *
 *   - The deterministic layers (prompt build, validation) run per form and must
 *     stay negligible next to a model call. If they ever aren't, something has
 *     become accidentally quadratic.
 *   - The model call dominates wall clock, and its *yield* — how many fields it
 *     actually maps — varies more by endpoint than by model. Latency alone
 *     hides that: an endpoint can be slower AND map less.
 *
 * Usage:
 *   node tools/bench.mjs                          # offline, CPU layers only
 *   node tools/bench.mjs --provider ollama --base http://host:11434 --runs 3
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const lib = (n) => require(join(ROOT, "extension", "src", "lib", `${n}.js`));

const { buildMessages } = lib("prompt");
const { validate } = lib("validate");
const P = lib("providers");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const schema = read("tests/fixtures/greenhouse-cloudflare.json");
const profile = read(arg("profile", "tests/fixtures/profile.example.json"));

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    min: s[0],
    p50: s[Math.floor(s.length / 2)],
    max: s.at(-1),
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
};
const ms = (n) => `${n.toFixed(2)}ms`;

/* ---------------------------------------------------------------- CPU path */

const ITERATIONS = Number(arg("iterations", 500));
const MODEL_REPLY = Object.fromEntries(
  schema.fields.filter((f) => f.options).map((f) => [f.id, f.options[0]])
);

const promptTimes = [];
const validateTimes = [];
for (let i = 0; i < ITERATIONS; i++) {
  let t = performance.now();
  const { messages } = buildMessages(schema, profile);
  promptTimes.push(performance.now() - t);

  t = performance.now();
  validate(MODEL_REPLY, schema, profile, {});
  validateTimes.push(performance.now() - t);
}

const { messages } = buildMessages(schema, profile);
const chars = messages.reduce((n, m) => n + m.content.length, 0);

console.log(`form: ${schema.fields.length} fields (${schema.company})`);
console.log(`prompt: ~${Math.round(chars / 4)} tokens, ${chars} chars\n`);
console.log(`deterministic layers, ${ITERATIONS} iterations:`);
for (const [name, times] of [["build prompt", promptTimes], ["validate", validateTimes]]) {
  const s = stats(times);
  console.log(`  ${name.padEnd(14)} p50 ${ms(s.p50).padStart(8)}  mean ${ms(s.mean).padStart(8)}  max ${ms(s.max).padStart(8)}`);
}

/* -------------------------------------------------------------- model path */

const providerName = arg("provider");
if (!providerName) {
  console.log("\n(no --provider given; skipping model benchmark)");
  process.exit(0);
}

const settings = {
  provider: providerName,
  [providerName]: {
    baseUrl: arg("base"),
    model: arg("model", "qwen3.6:35b-a3b"),
    apiKey: arg("key", process.env.FORMWORK_API_KEY),
  },
};
const provider = P.resolve(settings);
const RUNS = Number(arg("runs", 3));

console.log(`\nmodel path — ${provider.name} (${settings[providerName].model ?? "default"}), ${RUNS} run(s):`);

const latencies = [];
const yields = [];
for (let i = 0; i < RUNS; i++) {
  const t = performance.now();
  let mapped = 0;
  let validated = 0;
  try {
    const raw = P.parseJSON(await provider.chat(messages, { json: true }));
    mapped = Object.keys(raw).length;
    validated = Object.keys(validate(raw, schema, profile, {}).fills).length;
  } catch (err) {
    console.log(`  run ${i + 1}: FAILED — ${err.message}`);
    continue;
  }
  const elapsed = performance.now() - t;
  latencies.push(elapsed);
  yields.push(mapped);
  console.log(
    `  run ${i + 1}: ${(elapsed / 1000).toFixed(1)}s  model mapped ${mapped}  validated ${validated}`
  );
}

if (latencies.length) {
  const s = stats(latencies);
  const y = stats(yields);
  console.log(
    `\n  latency p50 ${(s.p50 / 1000).toFixed(1)}s (min ${(s.min / 1000).toFixed(1)}s, max ${(s.max / 1000).toFixed(1)}s)`
  );
  console.log(`  model-mapped fields p50 ${y.p50} (min ${y.min}, max ${y.max})`);
  console.log(
    "\n  Note: validated > mapped is expected — pinned fields are derived from the\n" +
      "  profile and do not depend on the model answering at all."
  );
}
