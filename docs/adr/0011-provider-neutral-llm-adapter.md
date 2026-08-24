# ADR-0011: Provider-neutral LLM adapter — OpenCode Go (`gpt-5.6-luna`) over the Responses API

- **Status:** Accepted — implemented 2026-08-24
- **Scope:** `lib/ai/llm.ts` (new, replaces `lib/ai/zai.ts`), `lib/music/tags.ts`, `lib/music/vibe.ts`, `lib/serenity/analyzer.ts`, `lib/serenity/index.ts`, `app/api/yt/vibe/route.ts`, the Music widget + Serenity posts feed copy, `.env.example`
- **Supersedes (in part):** ADR-0007 — the *roles* the LLM plays are unchanged; only the vendor, the wire protocol and the naming change.

## Context

The LLM path was wired directly to **Z.ai / GLM-5.2** through the `openai` SDK's
**Chat Completions** endpoint, with the vendor's name baked into the module
(`lib/ai/zai.ts`), the function names (`createChat`, `isZaiConfigured`), the env vars
(`ZAI_API_KEY`, `ZAI_BASE_URL`, `GLM_MODEL`), a vendor-specific request field
(`thinking: { type: "disabled" }`) and even user-facing copy ("Set `ZAI_API_KEY` …").

Changing provider therefore meant a broad refactor across three features. Two forces made
that concrete: the move to **OpenCode Go / `gpt-5.6-luna`**, and the fact that OpenCode Go
speaks the **Responses API**, not Chat Completions — so the response-parsing assumption
(`res.choices[0].message.content`) was wrong as well as the base URL.

## Decision

### D1 — One adapter, provider-neutral by contract

`lib/ai/llm.ts` is the only module in the app that knows a vendor exists. It exports:

| Export | Purpose |
|---|---|
| `isLlmConfigured()` | The gate every caller checks before spending a call. |
| `generateWithLLM(opts)` | One non-streaming generation → text. |
| `generateStructuredWithLLM({ schema, … })` | Schema-enforced generation → validated object. |
| `describeLlmConfig()` | Non-secret config (base URL + model) for diagnostics. |
| `getLlmModel()` / `resetLlmClient()` | The configured model + a test/HMR seam. |

Features import these and nothing else. **No feature may import a vendor SDK or add a
vendor-specific request field.** Vendor-specific knobs are normalised at the adapter
boundary: the old `thinkingDisabled: true` (Z.ai) becomes `reasoning: "none"`, which the
adapter maps to the Responses API's `reasoningEffort`.

### D2 — Provider-neutral configuration, validated at runtime

`LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` — read in exactly one place, with defaults
`https://opencode.ai/zen/go/v1` and `gpt-5.6-luna`. Validation errors name the variable,
never its value. There is **no fallback to the old `ZAI_*` names**: a half-migrated
deployment should fail loudly at config time, not silently route to a dead vendor.

`LLM_BASE_URL` is the **base**, not the documented full endpoint — `@ai-sdk/openai`'s
Responses model appends `/responses` itself (verified in the installed
`@ai-sdk/openai@4.0.46`: `url: ({ path }) => ${baseURL}${path}` with `path: "/responses"`).
The adapter strips a trailing `/responses` and trailing slashes defensively, so a base URL
copied verbatim from the docs can never produce `/responses/responses`.

### D3 — Schema-enforced structured output, still validated locally

All three LLM roles produce structured data, and all three previously did
`JSON.parse` + hand-rolled validation on a free-text response. They now call
`generateStructuredWithLLM` with a **zod** schema, which:

1. asks the provider for structured output (`generateObject`), then
2. on any failure — including an endpoint that does not support structured output —
   retries **once** as plain-text JSON, then
3. **always** re-validates the result against the same zod schema before returning.

Malformed or incomplete output throws, which routes into each caller's existing
degradation path. Local validation was not weakened anywhere: the music tagger still
filters every tag through the fixed `VOCAB`, `vibe.ts` still runs `fromVocab`/`fromStrings`
and clamps `length` to 5–50, and the Serenity analyzer still `safeParse`s before merging.

One shape change was required to make schema enforcement possible: the tagger's wire format
moved from a dynamically-keyed object (`{"<videoId>": ["tag"]}`, not expressible as a JSON
schema) to `{"tracks":[{"id","tags"}]}`. The **contract** — `videoId → in-vocabulary tags`,
cached in `music_track_tags` — is unchanged.

### D4 — Behaviour explicitly preserved

- The LLM still **never selects or ranks songs** (ADR-0007's governing rule).
- Vibe intent parsing, constrained genre/mood/era vocabularies, `BATCH_SIZE = 16` batching
  and the `music_track_tags` cache are untouched.
- Serenity keeps its durable `unstable_cache` layer, its per-instance peek map, its
  cron-only warm and its deterministic fallback.
- An absent key remains a **supported state** everywhere.

## Consequences

- Switching providers again is: change `lib/ai/llm.ts` (and the three env vars). No feature
  touches a vendor name.
- Dependencies: `@ai-sdk/openai` + `ai` added; the raw `openai` SDK **removed** (it had
  exactly one importer, the deleted `lib/ai/zai.ts`).
- The provider-side structured-output mode is a capability we assert but cannot prove
  without a live key; the plain-text-JSON retry is the insurance, and local validation is
  the guarantee.
- ADR-0007's note that "a server key (`ZAI_*`) now sits in the music path" reads as
  `LLM_API_KEY` from here on. The privacy property is unchanged: only public track metadata
  is sent, never listening history or user identity.
