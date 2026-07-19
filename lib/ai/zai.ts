import "server-only";
import OpenAI from "openai";

/**
 * Server-only Z.ai (GLM) client — OpenAI-compatible.
 *
 * Max plan → base URL defaults to the coding endpoint
 * (https://api.z.ai/api/coding/paas/v4); override with ZAI_BASE_URL (fall back to
 * https://api.z.ai/api/paas/v4 if the coding endpoint 401/403s for this use case).
 * Model defaults to glm-5.2 (the 1M-context variant); override with GLM_MODEL.
 *
 * Z.ai supports a non-standard `thinking` toggle on the request body:
 *   thinking: { type: "disabled" } → no reasoning tokens (fast, deterministic —
 *   use for classification / extraction / grading). Omit for full reasoning.
 * Keys are SERVER-ONLY — never prefix with NEXT_PUBLIC_.
 */

const DEFAULT_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const DEFAULT_MODEL = "glm-5.2";

export function isZaiConfigured(): boolean {
  return Boolean(process.env.ZAI_API_KEY);
}

function getClient(): OpenAI {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) throw new Error("ZAI_API_KEY is not set");
  return new OpenAI({
    baseURL: process.env.ZAI_BASE_URL || DEFAULT_BASE_URL,
    apiKey,
  });
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CreateChatOptions {
  messages: ChatMessage[];
  temperature?: number;
  /** Disable reasoning tokens for deterministic steps (classification/extraction). */
  thinkingDisabled?: boolean;
  /** Request a JSON-object response. */
  json?: boolean;
  maxTokens?: number;
}

/**
 * One non-streaming chat completion. Returns the assistant's text content.
 * Throws on API error so callers can catch + degrade.
 */
export async function createChat(opts: CreateChatOptions): Promise<string> {
  const client = getClient();
  // Non-streaming so the return narrows to ChatCompletion (→ .choices). The
  // `thinking` field is Z.ai-specific (non-standard for the OpenAI SDK), added via
  // an intersection so it's typed locally + serialized into the request body.
  const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & { thinking?: { type: string } } = {
    model: process.env.GLM_MODEL || DEFAULT_MODEL,
    messages: opts.messages,
    temperature: opts.temperature ?? 0,
    stream: false,
  };
  if (opts.maxTokens) params.max_tokens = opts.maxTokens;
  if (opts.json) params.response_format = { type: "json_object" };
  if (opts.thinkingDisabled) params.thinking = { type: "disabled" };

  const res = await client.chat.completions.create(params);
  return res.choices[0]?.message?.content ?? "";
}
