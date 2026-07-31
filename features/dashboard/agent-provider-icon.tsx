"use client";

import { ProviderMark } from "@/features/subscriptions/provider-mark";

const MARKS = {
  anthropic: {
    name: "Anthropic",
    color: "#d97757",
    slug: "anthropic",
    domain: "anthropic.com",
  },
  glm: {
    name: "Z.ai",
    color: "#3b6ef2",
    domain: "z.ai",
  },
  openai: {
    name: "OpenAI",
    color: "#10a37f",
    domain: "openai.com",
  },
} as const;

function markFor(source: string) {
  const normalized = source.toLowerCase();
  if (normalized === "codex" || normalized.includes("openai")) return MARKS.openai;
  if (normalized === "glm" || normalized.includes("zai") || normalized.includes("z.ai")) {
    return MARKS.glm;
  }
  return MARKS.anthropic;
}

export function AgentProviderIcon({
  source,
  size = "sm",
  className,
}: {
  source: string;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}) {
  const mark = markFor(source);
  return (
    <ProviderMark
      name={mark.name}
      color={mark.color}
      slug={"slug" in mark ? mark.slug : undefined}
      domain={mark.domain}
      size={size}
      className={className}
    />
  );
}
