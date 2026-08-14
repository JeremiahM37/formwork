/**
 * Providers are deliberately thin, so what matters is the wire shape each one
 * sends and that a failure surfaces as a readable message rather than a bare
 * "Failed to fetch".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lib } from "../helpers/load.mjs";

const P = lib("providers");

/** Capture the single request a provider makes, and reply with `body`. */
function captureFetch(body, { status = 200 } = {}) {
  const seen = {};
  globalThis.fetch = async (url, init) => {
    seen.url = url;
    seen.init = init;
    seen.body = JSON.parse(init.body);
    return {
      ok: status < 400,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return seen;
}

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

test("parseJSON accepts bare, fenced, and preamble-wrapped output", () => {
  assert.deepEqual(P.parseJSON('{"f0":"a"}'), { f0: "a" });
  assert.deepEqual(P.parseJSON('```json\n{"f0":"a"}\n```'), { f0: "a" });
  assert.deepEqual(P.parseJSON('Sure! Here you go:\n{"f0":"a"}\nHope that helps.'), { f0: "a" });
  assert.deepEqual(P.parseJSON('{"a":{"b":"}"}}'), { a: { b: "}" } }, "braces inside strings");
});

test("parseJSON reports truncation distinctly from having no JSON at all", () => {
  assert.throws(() => P.parseJSON("no json here"), /no JSON/);
  assert.throws(() => P.parseJSON('{"f0": "unterminated'), /truncated/);
  assert.throws(() => P.parseJSON(""), /no JSON/);
});

test("ollama disables reasoning and constrains the decoder for field mapping", () => {
  const seen = captureFetch({ message: { content: '{"f0":"x"}' } });
  return P.ollama({ baseUrl: "http://host:11434" })
    .chat([{ role: "user", content: "hi" }], { json: true })
    .then((out) => {
      assert.equal(seen.url, "http://host:11434/api/chat");
      assert.equal(seen.body.think, false, "reasoning must be off — it is a lookup, not a puzzle");
      assert.equal(seen.body.format, "json");
      assert.equal(seen.body.stream, false);
      assert.equal(out, '{"f0":"x"}');
    });
});

test("ollama drops the json constraint when drafting prose", async () => {
  const seen = captureFetch({ message: { content: "prose" } });
  await P.ollama({}).chat([], { json: false });
  assert.equal(seen.body.format, undefined);
});

test("anthropic sends the headers a direct browser call requires", async () => {
  const seen = captureFetch({ content: [{ type: "text", text: '{"f0":"x"}' }], stop_reason: "end_turn" });
  await P.anthropic({ apiKey: "sk-test", model: "claude-opus-5" }).chat(
    [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }],
    { json: true }
  );

  assert.equal(seen.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(seen.init.headers["x-api-key"], "sk-test");
  assert.equal(
    seen.init.headers["anthropic-dangerous-direct-browser-access"],
    "true",
    "without this the request is blocked by CORS before it leaves the browser"
  );
  // The system prompt is a top-level field, not a message role.
  assert.equal(seen.body.system, "SYS");
  assert.deepEqual(seen.body.messages.map((m) => m.role), ["user"]);
  assert.ok(seen.body.max_tokens > 0, "max_tokens covers thinking plus output and is required");
});

test("anthropic surfaces a refusal instead of indexing into empty content", async () => {
  captureFetch({ content: [], stop_reason: "refusal" });
  await assert.rejects(
    () => P.anthropic({ apiKey: "k" }).chat([{ role: "user", content: "hi" }], {}),
    /declined/
  );
});

test("an OpenAI-compatible server gets the JSON response_format", async () => {
  const seen = captureFetch({ choices: [{ message: { content: "{}" } }] });
  await P.openaiCompatible({ baseUrl: "https://api.example/v1", apiKey: "k", model: "m" })
    .chat([], { json: true });
  assert.equal(seen.url, "https://api.example/v1/chat/completions");
  assert.equal(seen.init.headers.authorization, "Bearer k");
  assert.deepEqual(seen.body.response_format, { type: "json_object" });
});

test("a trailing slash in a configured base URL does not double up", async () => {
  const seen = captureFetch({ message: { content: "" } });
  await P.ollama({ baseUrl: "http://host:11434/" }).chat([], {});
  assert.equal(seen.url, "http://host:11434/api/chat");
});

test("an HTTP error names the status and echoes the server's reason", async () => {
  captureFetch({ error: "model not found" }, { status: 404 });
  await assert.rejects(() => P.ollama({}).chat([], {}), /404.*model not found/s);
});

test("a blocked host produces actionable advice, not 'Failed to fetch'", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(() => P.ollama({}).chat([], {}), /reachable and permitted/);
});

test("resolve falls back to the self-hosted provider for an unknown name", () => {
  assert.equal(P.resolve({ provider: "nope" }).name, "homelab");
  assert.equal(P.resolve({}).name, "homelab");
  assert.equal(P.resolve({ provider: "ollama", ollama: {} }).name, "ollama");
});
