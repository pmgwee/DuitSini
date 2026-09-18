# ADR-0012: OpenRouter prepaid credits with GLM 5.3 Flash

- **Status:** Accepted — implemented 2026-09-18
- **Supersedes:** The active provider choice in ADR-0011 (the provider-neutral adapter contract remains).

## Decision

Use OpenRouter's prepaid-credit account as the server-side LLM provider for the
three existing AI features. Keep the existing provider-neutral adapter and the
existing `@ai-sdk/openai` dependency, but target OpenRouter's OpenAI-compatible
Chat Completions endpoint:

```text
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=z-ai/glm-5.3-flash
```

The paid model slug is intentional; `:free` and `:batch` are not the interactive
default. The API key is `LLM_API_KEY`, server-only and never prefixed with
`NEXT_PUBLIC_`.

## Reasoning policy

All three call sites use `high`. They produce short, schema-constrained
classification or extraction results, so `high` gives enough ambiguity handling
without making the user-facing Vibe request or background tagger pay the latency
and token cost of `xhigh`. The adapter still accepts `xhigh` for a caller that
explicitly needs a deeper pass.

Because the GLM model id is not in `@ai-sdk/openai`'s OpenAI reasoning allowlist,
the adapter sets `forceReasoning: true` and forwards `reasoning_effort` when a
reasoning level is requested. It keeps system messages as `system` and omits
temperature while reasoning is enabled.

## Structured output and failure behavior

OpenRouter's model catalog advertises structured outputs for GLM 5.3 Flash. The
adapter continues to request a JSON schema, validate the result locally with Zod,
and retry once as plain-text JSON when a routed endpoint rejects structured output.
Missing keys and provider failures retain the existing deterministic fallback
behavior.

## Routing affinity

The adapter sends a per-server-process `x-session-id`. This gives OpenRouter a
stable routing/cache key for the app's one-shot calls without exposing user
identity or secret material.
