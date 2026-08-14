/**
 * Settings persistence.
 *
 * The interesting behaviour is the merge: a user who saved settings before a
 * new provider or option existed must still get sane defaults for it, or the
 * extension reads `undefined` for a field it assumes is present.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lib } from "../helpers/load.mjs";

/** Minimal chrome.storage.local stand-in over a plain object. */
function stubChrome(initial = {}) {
  const data = structuredClone(initial);
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return key in data ? { [key]: structuredClone(data[key]) } : {};
        },
        async set(patch) {
          Object.assign(data, structuredClone(patch));
        },
      },
    },
  };
  return data;
}

const storage = lib("storage");

test("defaults are returned when nothing has been saved", async () => {
  stubChrome();
  const settings = await storage.getSettings();
  assert.equal(settings.provider, "homelab");
  assert.equal(settings.autoApprove, false, "auto-approve must default to off");
  assert.equal(await storage.getProfile(), null);
  assert.equal(await storage.getAbout(), "");
  assert.deepEqual(await storage.getBank(), []);
  assert.deepEqual(await storage.getDocuments(), {});
});

test("a provider added after the user saved still gets its defaults", async () => {
  // Settings saved by an older build: no `ollama` block at all.
  stubChrome({ settings: { provider: "homelab", homelab: { baseUrl: "http://saved:9105" } } });
  const settings = await storage.getSettings();

  assert.equal(settings.homelab.baseUrl, "http://saved:9105", "saved values win");
  assert.ok(settings.ollama, "a provider the user has never seen must still be configured");
  assert.equal(settings.ollama.baseUrl, "http://localhost:11434");
  assert.equal(settings.anthropic.model, "claude-opus-5");
});

test("a partially configured provider keeps its unset fields", async () => {
  stubChrome({ settings: { provider: "anthropic", anthropic: { apiKey: "k" } } });
  const settings = await storage.getSettings();
  assert.equal(settings.anthropic.apiKey, "k");
  assert.equal(settings.anthropic.model, "claude-opus-5", "unset fields fall back to defaults");
});

test("defaults are copies, so reading twice cannot mutate them", async () => {
  stubChrome();
  const first = await storage.getSettings();
  first.homelab.baseUrl = "http://mutated";
  const second = await storage.getSettings();
  assert.notEqual(second.homelab.baseUrl, "http://mutated");
});

test("values round-trip through set and get", async () => {
  stubChrome();
  await storage.setProfile({ identity: { first_name: "Dana" } });
  await storage.setBank([{ question: "q", answer: "a" }]);
  await storage.setDocuments({ resume: { name: "r.pdf" } });

  assert.equal((await storage.getProfile()).identity.first_name, "Dana");
  assert.equal((await storage.getBank()).length, 1);
  assert.equal((await storage.getDocuments()).resume.name, "r.pdf");
});

test("no default points at a non-local host", () => {
  // A shipped default aimed at someone's private server is both a leak and a
  // nonsense default for everyone else.
  const providers = storage.DEFAULTS.settings;
  for (const key of ["homelab", "ollama"]) {
    assert.match(providers[key].baseUrl, /^https?:\/\/(localhost|127\.0\.0\.1)/, `${key} default`);
  }
});
