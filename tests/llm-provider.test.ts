import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Contract tests for the provider-neutral LLM adapter (`lib/ai/llm.ts`) and the
 * graceful-degradation paths that depend on it.
 *
 * Everything here runs against a STUBBED `globalThis.fetch` — no network, no
 * key, no billable request. The point is to pin down:
 *   - configuration (which env vars, what happens when they're missing/bad)
 *   - routing (the request must land on <base>/chat/completions, exactly once)
 *   - model selection
 *   - Chat Completions result parsing
 *   - structured-output validation + malformed-output handling
 *   - auth failure / provider failure / abort
 *   - the features' silent fallback when the LLM is unavailable
 */

import {
  describeLlmConfig,
  generateStructuredWithLLM,
  generateWithLLM,
  isLlmConfigured,
  resetLlmClient,
} from "@/lib/ai/llm";

const TEST_KEY = "test-key-not-a-real-secret";

/** A minimal but valid OpenAI-compatible Chat Completions payload. */
function chatPayload(text: string) {
  return {
    id: "chatcmpl_test",
    model: "z-ai/glm-5.3-flash",
    choices: [
      { index: 0, finish_reason: "stop", message: { role: "assistant", content: text } },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const captured: Captured[] = [];

/** Stub fetch with a queue of responders (last one repeats). */
function stubFetch(...responders: Array<() => Response | Promise<Response>>) {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      } catch {
        /* non-JSON body — leave empty */
      }
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      captured.push({ url, body, headers });
      const responder = responders[Math.min(i, responders.length - 1)];
      i += 1;
      return responder();
    }),
  );
}

const ENV_KEYS = ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  captured.length = 0;
  resetLlmClient();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLlmClient();
});

// ── Configuration ──────────────────────────────────────────────────────────

describe("provider configuration", () => {
  it("reports unconfigured when LLM_API_KEY is absent or blank", () => {
    expect(isLlmConfigured()).toBe(false);
    process.env.LLM_API_KEY = "   ";
    expect(isLlmConfigured()).toBe(false);
    process.env.LLM_API_KEY = TEST_KEY;
    expect(isLlmConfigured()).toBe(true);
  });

  it("defaults to OpenRouter's base URL and GLM 5.3 Flash", () => {
    process.env.LLM_API_KEY = TEST_KEY;
    expect(describeLlmConfig()).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "z-ai/glm-5.3-flash",
    });
  });

  it("honours LLM_BASE_URL / LLM_MODEL overrides", () => {
    process.env.LLM_API_KEY = TEST_KEY;
    process.env.LLM_BASE_URL = "https://example.test/v1";
    process.env.LLM_MODEL = "some-other-model";
    expect(describeLlmConfig()).toEqual({
      baseUrl: "https://example.test/v1",
      model: "some-other-model",
    });
  });

  it("normalises a base URL that already carries the endpoint", () => {
    process.env.LLM_API_KEY = TEST_KEY;
    process.env.LLM_BASE_URL = "https://openrouter.ai/api/v1/chat/completions/";
    expect(describeLlmConfig().baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("throws a secret-safe error when the key is missing", () => {
    expect(() => describeLlmConfig()).toThrow(/LLM_API_KEY/);
  });

  it("rejects a malformed base URL without echoing any secret", () => {
    process.env.LLM_API_KEY = TEST_KEY;
    process.env.LLM_BASE_URL = "not-a-url";
    try {
      describeLlmConfig();
      throw new Error("expected a throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/LLM_BASE_URL/);
      expect(message).not.toContain(TEST_KEY);
    }
  });
});

// ── Routing + model selection ──────────────────────────────────────────────

describe("Chat Completions routing", () => {
  beforeEach(() => {
    process.env.LLM_API_KEY = TEST_KEY;
  });

  it("posts to <base>/chat/completions with the configured model", async () => {
    stubFetch(() => jsonResponse(chatPayload("hello")));
    const text = await generateWithLLM({ messages: [{ role: "user", content: "hi" }] });

    expect(text).toBe("hello");
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(captured[0].url).not.toContain("/chat/completions/chat/completions");
    expect(captured[0].url).not.toContain("/responses");
    expect(captured[0].body.model).toBe("z-ai/glm-5.3-flash");
    expect(captured[0].headers["x-session-id"]).toBeTruthy();
  });

  it("never emits a duplicated chat endpoint when the full endpoint is configured", async () => {
    process.env.LLM_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
    stubFetch(() => jsonResponse(chatPayload("ok")));
    await generateWithLLM({ messages: [{ role: "user", content: "hi" }] });
    expect(captured[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("sends the key as a bearer token and nowhere else", async () => {
    stubFetch(() => jsonResponse(chatPayload("ok")));
    await generateWithLLM({ messages: [{ role: "user", content: "hi" }] });
    expect(captured[0].headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(captured[0].url).not.toContain(TEST_KEY);
    expect(JSON.stringify(captured[0].body)).not.toContain(TEST_KEY);
  });

  it("maps system messages and omits reasoning for \"none\"", async () => {
    stubFetch(() => jsonResponse(chatPayload("ok")));
    await generateWithLLM({
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
      reasoning: "none",
      maxTokens: 42,
    });
    const body = captured[0].body;
    expect(body).not.toHaveProperty("thinking");
    expect(body).toHaveProperty("messages");
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBe(42);
    expect(JSON.stringify(body)).toContain("be terse");
  });

  it("sends the requested effort when reasoning is enabled", async () => {
    stubFetch(() => jsonResponse(chatPayload("ok")));
    await generateWithLLM({
      messages: [{ role: "user", content: "hi" }],
      reasoning: "xhigh",
    });
    // `forceReasoning` is load-bearing: without it @ai-sdk/openai classifies
    // the GLM id as non-reasoning and drops the field entirely.
    expect(captured[0].body.reasoning_effort).toBe("xhigh");
  });
});

// ── Generation + structured output ─────────────────────────────────────────

describe("generation", () => {
  beforeEach(() => {
    process.env.LLM_API_KEY = TEST_KEY;
  });

  it("parses the Chat Completions result shape", async () => {
    stubFetch(() => jsonResponse(chatPayload("the answer")));
    await expect(generateWithLLM({ messages: [{ role: "user", content: "q" }] })).resolves.toBe(
      "the answer",
    );
  });

  const schema = z.object({ genres: z.array(z.string()).default([]), length: z.number() });

  it("returns a schema-validated object", async () => {
    stubFetch(() => jsonResponse(chatPayload(JSON.stringify({ genres: ["indie"], length: 25 }))));
    const out = await generateStructuredWithLLM({
      messages: [{ role: "user", content: "q" }],
      schema,
    });
    expect(out).toEqual({ genres: ["indie"], length: 25 });
    expect(captured[0].body).toHaveProperty("response_format"); // structured-output format requested
  });

  it("throws when the model returns malformed JSON (after the plain-text retry)", async () => {
    stubFetch(() => jsonResponse(chatPayload("not json at all")));
    await expect(
      generateStructuredWithLLM({ messages: [{ role: "user", content: "q" }], schema }),
    ).rejects.toThrow();
    expect(captured.length).toBeGreaterThan(1); // structured attempt + text retry
  });

  it("throws when the output parses but violates the schema — validation is not weakened", async () => {
    stubFetch(() => jsonResponse(chatPayload(JSON.stringify({ genres: "indie", length: "lots" }))));
    await expect(
      generateStructuredWithLLM({ messages: [{ role: "user", content: "q" }], schema }),
    ).rejects.toThrow(/schema/i);
  });

  it("falls back to plain-text JSON when structured-output mode is rejected by the endpoint", async () => {
    let call = 0;
    stubFetch(() => {
      call += 1;
      if (call === 1) {
        return jsonResponse(
          { error: { message: "unsupported parameter: response_format", type: "invalid_request_error", code: "x" } },
          400,
        );
      }
      return jsonResponse(chatPayload('```json\n{"genres":["rock"],"length":10}\n```'));
    });
    const out = await generateStructuredWithLLM({
      messages: [{ role: "user", content: "q" }],
      schema,
      maxRetries: 0,
    });
    expect(out).toEqual({ genres: ["rock"], length: 10 });
  });
});

// ── Failure modes ──────────────────────────────────────────────────────────

describe("failure modes", () => {
  beforeEach(() => {
    process.env.LLM_API_KEY = TEST_KEY;
  });

  it("throws on an authentication failure without leaking the key", async () => {
    stubFetch(() =>
      jsonResponse({ error: { message: "Invalid API key", type: "invalid_request_error", code: "401" } }, 401),
    );
    await expect(
      generateWithLLM({ messages: [{ role: "user", content: "q" }], maxRetries: 0 }),
    ).rejects.toSatisfy((err: unknown) => !String((err as Error)?.message).includes(TEST_KEY));
  });

  it("throws on a provider failure (5xx)", async () => {
    stubFetch(() => jsonResponse({ error: { message: "boom", type: "server_error", code: "500" } }, 500));
    await expect(
      generateWithLLM({ messages: [{ role: "user", content: "q" }], maxRetries: 0 }),
    ).rejects.toThrow();
  });

  it("propagates an abort/timeout instead of silently retrying as text", async () => {
    stubFetch(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateStructuredWithLLM({
        messages: [{ role: "user", content: "q" }],
        schema: z.object({ a: z.string() }),
        abortSignal: controller.signal,
        maxRetries: 0,
      }),
    ).rejects.toThrow();
  });
});

// ── Feature-level graceful degradation ─────────────────────────────────────

describe("graceful degradation", () => {
  it("parseVibe returns null with no key configured (no request made)", async () => {
    stubFetch(() => jsonResponse(chatPayload("{}")));
    const { parseVibe } = await import("@/lib/music/vibe");
    await expect(parseVibe("rainy-day indie folk")).resolves.toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("parseVibe returns null when the provider fails", async () => {
    process.env.LLM_API_KEY = TEST_KEY;
    stubFetch(() => jsonResponse({ error: { message: "nope", type: "server_error", code: "500" } }, 500));
    const { parseVibe } = await import("@/lib/music/vibe");
    await expect(parseVibe("rainy-day indie folk")).resolves.toBeNull();
    // The SDK's retry budget (2 retries, backed off) is preserved, so a 500
    // legitimately takes several seconds to exhaust before we degrade.
  }, 40_000);

  it("parseVibe keeps the fixed-vocabulary constraint and the 5-50 length clamp", async () => {
    process.env.LLM_API_KEY = TEST_KEY;
    stubFetch(() =>
      jsonResponse(
        chatPayload(
          JSON.stringify({
            genres: ["indie", "NOT-A-GENRE"],
            moods: ["chill"],
            eras: [],
            artists: ["Oasis"],
            seedNames: ["oasis - wonderwall"],
            exclude: ["EDM"],
            length: 999,
          }),
        ),
      ),
    );
    const { parseVibe } = await import("@/lib/music/vibe");
    const c = await parseVibe("rainy-day indie folk, no edm");
    expect(c).toBeTruthy();
    expect(c!.genres).toEqual(["indie"]); // out-of-vocabulary tag dropped locally
    expect(c!.moods).toEqual(["chill"]);
    expect(c!.artists).toEqual(["Oasis"]);
    expect(c!.exclude).toEqual(["edm"]); // lowercased
    expect(c!.length).toBe(25); // out-of-range → default
  });

  it("ensureTagVectors yields no vectors (rather than throwing) with no key configured", async () => {
    stubFetch(() => jsonResponse(chatPayload("{}")));
    const { ensureTagVectors } = await import("@/lib/music/tags");
    const out = await ensureTagVectors(
      [{ videoId: "abc", title: "Wonderwall", channel: "Oasis" }],
      null,
    );
    expect(out.size).toBe(0);
    expect(captured).toHaveLength(0);
  });

  it("ensureTagVectors validates tags against the fixed vocabulary", async () => {
    process.env.LLM_API_KEY = TEST_KEY;
    stubFetch(() =>
      jsonResponse(
        chatPayload(
          JSON.stringify({ tracks: [{ id: "abc", tags: ["rock", "1990s", "made-up-tag"] }] }),
        ),
      ),
    );
    const { ensureTagVectors } = await import("@/lib/music/tags");
    const out = await ensureTagVectors(
      [{ videoId: "abc", title: "Wonderwall", channel: "Oasis" }],
      null,
    );
    expect([...(out.get("abc")?.keys() ?? [])].sort()).toEqual(["1990s", "rock"]);
  });

  it("ensureTagVectors degrades silently when the provider fails", async () => {
    process.env.LLM_API_KEY = TEST_KEY;
    stubFetch(() => jsonResponse({ error: { message: "nope", type: "server_error", code: "500" } }, 500));
    const { ensureTagVectors } = await import("@/lib/music/tags");
    const out = await ensureTagVectors(
      [{ videoId: "abc", title: "Wonderwall", channel: "Oasis" }],
      null,
    );
    expect(out.size).toBe(0);
  }, 40_000);
});
