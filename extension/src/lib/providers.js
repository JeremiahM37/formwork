/**
 * formwork — model providers.
 *
 * One contract, three transports:
 *
 *   chat(messages, {json}) -> string
 *
 * The prompt, the validation, and the pinning all live elsewhere; a provider's
 * only job is to move messages to a model and text back. Keeping them this thin
 * is what makes the homelab path and the bring-your-own-key path behave
 * identically — there is no per-provider prompt to drift.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.__formwork = root.__formwork || {}).providers = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const trimSlash = (url) => String(url || "").replace(/\/+$/, "");

  /** A local 35B on a cold load can legitimately take minutes; beyond this it is hung. */
  const TIMEOUT_MS = 240000;

  async function postJSON(url, body, headers = {}, { timeoutMs = TIMEOUT_MS } = {}) {
    // Without an abort, a provider that accepts the connection and never
    // answers leaves the panel spinning with no error and no way back.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`no response after ${Math.round(timeoutMs / 1000)}s — is the model running?`);
      }
      // fetch() rejects with a bare "Failed to fetch" for a blocked host, which
      // is the single most likely misconfiguration. Say so.
      throw new Error(`${err.message} (check the model host is reachable and permitted)`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
    }
    return res.json();
  }

  /**
   * Self-hosted path: the homelab API proxies to Ollama.
   *
   * The extension sends messages, not a profile — the server never needs to
   * know what a job application is, and no second copy of the prompt exists.
   */
  function homelab({ baseUrl = "http://localhost:9105", model } = {}) {
    return {
      name: "homelab",
      async chat(messages, { json = false } = {}) {
        const body = await postJSON(`${trimSlash(baseUrl)}/api/jobfill/complete`, {
          messages,
          json,
          ...(model ? { model } : {}),
        });
        return body.content;
      },
    };
  }

  /**
   * Any OpenAI-compatible endpoint: OpenAI itself, OpenRouter, LM Studio, or a
   * local Ollama at /v1. One base URL covers the whole category, which is why
   * this is the path most self-hosters will actually use.
   */
  function openaiCompatible({
    baseUrl = "https://api.openai.com/v1",
    apiKey,
    model = "gpt-4o-mini",
    extra = {},
  } = {}) {
    return {
      name: "openai-compatible",
      async chat(messages, { json = false } = {}) {
        const body = await postJSON(
          `${trimSlash(baseUrl)}/chat/completions`,
          {
            model,
            messages,
            ...(json ? { response_format: { type: "json_object" } } : {}),
            // Escape hatch for server-specific options the OpenAI shape has no
            // room for (e.g. OpenRouter's routing preferences).
            //
            // It does NOT rescue Ollama: its /v1 shim ignores `think`, returns
            // reasoning in a separate `message.reasoning` field, and can leave
            // `content` empty once reasoning has eaten the budget — measured at
            // 3 mapped fields in 73s, against 16 in 6.2s on the native endpoint
            // (`npm run bench`). Point Ollama users at the `ollama` provider.
            ...extra,
          },
          apiKey ? { authorization: `Bearer ${apiKey}` } : {}
        );
        return body.choices?.[0]?.message?.content ?? "";
      },
    };
  }

  /**
   * Anthropic Messages API, called directly from the extension.
   *
   * Three things differ from the OpenAI shape and all three are load-bearing:
   *
   * 1. `anthropic-dangerous-direct-browser-access` — without it the request is
   *    blocked by CORS before it leaves the browser.
   * 2. The system prompt is a top-level field, not a message role.
   * 3. No structured-output schema. The field map is an object with arbitrary
   *    keys, and Anthropic's structured outputs require `additionalProperties:
   *    false` — an open-ended map cannot be expressed. JSON is requested in the
   *    prompt and parsed from the text instead.
   *
   * `max_tokens` caps thinking *and* response text together, and current models
   * think by default, so the budget is set well above the answer's size and
   * effort is lowered rather than thinking disabled — disabling it is the more
   * expensive lever and risks internal tags leaking into the output.
   */
  function anthropic({ apiKey, model = "claude-opus-5", effort = "low" } = {}) {
    return {
      name: "anthropic",
      async chat(messages, { json = false } = {}) {
        const system = messages
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n\n");
        const rest = messages.filter((m) => m.role !== "system");

        const body = await postJSON(
          "https://api.anthropic.com/v1/messages",
          {
            model,
            max_tokens: json ? 8000 : 4000,
            ...(system ? { system } : {}),
            messages: rest,
            output_config: { effort },
          },
          {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          }
        );

        // A refusal returns HTTP 200 with an empty content array — reading
        // content[0] unconditionally would throw on a perfectly valid response.
        if (body.stop_reason === "refusal") {
          throw new Error("the model declined this request");
        }
        return (body.content || [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
      },
    };
  }

  /**
   * Ollama's native endpoint — the right way to talk to a local model.
   *
   * Preferred over pointing the OpenAI-compatible provider at Ollama's /v1
   * shim, which cannot disable reasoning: `think: false` turns a minutes-long
   * deliberation into a sub-second lookup, and `format: "json"` constrains the
   * field map at the decoder rather than by asking nicely.
   */
  function ollama({ baseUrl = "http://localhost:11434", model = "qwen3.6:35b-a3b" } = {}) {
    return {
      name: "ollama",
      async chat(messages, { json = false } = {}) {
        const body = await postJSON(`${trimSlash(baseUrl)}/api/chat`, {
          model,
          messages,
          stream: false,
          think: false,
          ...(json ? { format: "json" } : {}),
          options: { temperature: json ? 0 : 0.4 },
        });
        return body.message?.content ?? "";
      },
    };
  }

  const BUILDERS = {
    homelab,
    ollama,
    "openai-compatible": openaiCompatible,
    anthropic,
  };

  /** Build the provider named by the user's settings. */
  function resolve(settings = {}) {
    const build = BUILDERS[settings.provider] || homelab;
    return build(settings[settings.provider] || {});
  }

  /**
   * Extract a JSON object from a model response.
   *
   * Providers that cannot be constrained to JSON sometimes wrap it in a fenced
   * block or a sentence of preamble, so the first balanced object is taken
   * rather than trusting the whole string to parse.
   */
  function parseJSON(text) {
    const trimmed = String(text || "").trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to extraction */
    }
    const start = trimmed.indexOf("{");
    if (start === -1) throw new Error("model returned no JSON");
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === "{") depth++;
      else if (trimmed[i] === "}" && --depth === 0) {
        return JSON.parse(trimmed.slice(start, i + 1));
      }
    }
    throw new Error("model returned truncated JSON");
  }

  return { resolve, parseJSON, homelab, ollama, openaiCompatible, anthropic };
});
