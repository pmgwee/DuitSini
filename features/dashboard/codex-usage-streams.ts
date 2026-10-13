import { codexStreamsByAccount, type CodexAccountMetadata } from "@/lib/claude-usage/codex-accounts";
import { SUPPORTED_SOURCES } from "@/lib/claude-usage/protocol";
import type { UsageStream } from "./use-claude-usage-live";

const sourceRank = (stream: UsageStream) => SUPPORTED_SOURCES[stream.source] ?? Number.MAX_SAFE_INTEGER;

/** Keep the original ring UI and render one fixed section per enrolled seat. */
export function streamsWithCodexAccounts(
  streams: UsageStream[],
  accounts: CodexAccountMetadata[],
  directoryReady = true,
): UsageStream[] {
  const nonCodex = streams.filter((stream) => stream.source !== "codex");
  const byAccount = directoryReady ? codexStreamsByAccount(streams, accounts) : new Map<string, UsageStream>();
  const codex = accounts.map((account): UsageStream => {
    const stream = byAccount.get(account.account_key);
    if (stream) {
      return {
        ...stream,
        account_key: account.account_key,
        account_email: stream.account_email ?? account.email,
        label: account.label,
      };
    }
    return {
      source: "codex",
      label: account.label,
      account_key: account.account_key,
      account_email: account.email,
      workspace_id: account.workspace_id,
      workspace_name: account.workspace_name,
      plan_type: account.plan_type,
      five_hour: { utilization: null, resets_at: null },
      seven_day: { utilization: null, resets_at: null },
      limits: null,
      provider: { name: "OpenAI", gateway_host: "chatgpt.com", official: true },
      state: "not_connected",
      status_message: `${account.label} is not connected yet.`,
    };
  });
  // Re-apply the dashboard's provider order so seats sit in Codex's slot
  // (above Google AI Pro), not after every other provider. Stable within a rank.
  return [...nonCodex, ...codex]
    .map((stream, index) => ({ stream, index }))
    .sort((a, b) => sourceRank(a.stream) - sourceRank(b.stream) || a.index - b.index)
    .map(({ stream }) => stream);
}
