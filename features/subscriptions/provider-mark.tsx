"use client";

import { useState, type CSSProperties } from "react";
import { monogramFor } from "@/lib/domain/subscription";
import { faviconUrl, providerIconUrl } from "@/lib/providers";
import { cn } from "@/lib/utils";

const SIZE_CLASS: Record<string, string> = {
  xs: "size-4 text-[7px]",
  sm: "size-5 text-[8px]",
  md: "size-7 text-[10px]",
  lg: "size-9 text-xs",
};

/**
 * The reusable brand mark behind every provider icon. Four tiers, cascading on
 * image error so EVERY provider can show a real logo:
 *   1. `logoUrl` → a curated direct logo image (hosted locally for brands no
 *                  icon service carries — e.g. regional telcos/utilities), on a
 *                  white circle.
 *   2. `slug`    → clean white Simple Icons glyph on the brand-color circle.
 *   3. `domain`  → full-color favicon (Google) on a white circle, for brands
 *                  Simple Icons doesn't carry (OpenAI, Microsoft, Amazon, …).
 *   4. monogram  → brand-color circle with white initials, the last resort.
 *
 * Stateful only for the onError cascade, so it's a client component. Used by
 * `SubscriptionIcon` (from a subscription) and the provider combobox (preset).
 */
type MarkStage = "direct" | "logo" | "favicon" | "monogram";

export function ProviderMark({
  name,
  color,
  slug,
  domain,
  logoUrl,
  size = "md",
  className,
  style,
}: {
  name: string;
  color: string;
  slug?: string;
  domain?: string;
  logoUrl?: string;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  style?: CSSProperties;
}) {
  const hasLogoUrl = Boolean(logoUrl);
  const hasSlug = Boolean(slug);
  const hasDomain = Boolean(domain);
  const [stage, setStage] = useState<MarkStage>(
    hasLogoUrl ? "direct" : hasSlug ? "logo" : hasDomain ? "favicon" : "monogram",
  );

  // direct → logo (slug) → favicon (domain) → monogram.
  const advance = () =>
    setStage((s) => {
      if (s === "direct") return hasSlug ? "logo" : hasDomain ? "favicon" : "monogram";
      if (s === "logo") return hasDomain ? "favicon" : "monogram";
      return "monogram";
    });

  // The white glyph and the monogram render on the brand-color circle; the
  // curated direct logo and the full-color favicon are images, so they sit on a
  // white circle to read clearly.
  const onWhite = stage === "direct" || stage === "favicon";

  return (
    <span
      title={name}
      className={cn(
        "inline-grid shrink-0 place-items-center overflow-hidden rounded-full ring-1 ring-inset",
        onWhite ? "ring-black/5" : "ring-white/15",
        SIZE_CLASS[size] ?? SIZE_CLASS.md,
        className,
      )}
      style={{ ...style, backgroundColor: onWhite ? "#fff" : color }}
    >
      {stage === "direct" && logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt=""
          draggable={false}
          onError={advance}
          className="h-[80%] w-[80%] object-contain"
        />
      ) : stage === "logo" && slug ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={providerIconUrl(slug)}
          alt=""
          draggable={false}
          onError={advance}
          className="h-[62%] w-[62%] object-contain"
        />
      ) : stage === "favicon" && domain ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={faviconUrl(domain)}
          alt=""
          draggable={false}
          onError={advance}
          className="h-[80%] w-[80%] object-contain"
        />
      ) : (
        <span className="font-semibold leading-none text-white drop-shadow-sm">
          {monogramFor(name)}
        </span>
      )}
    </span>
  );
}
