"use client";

import { useState } from "react";
import type { Subscription } from "@/types/subscription";
import { CATEGORY_META } from "@/lib/constants";
import { getMonogram } from "@/lib/domain/subscription";
import { findProviderPreset, providerIconUrl } from "@/lib/providers";
import { cn } from "@/lib/utils";

const SIZE_CLASS: Record<string, string> = {
  xs: "size-4 rounded-full text-[7px]",
  sm: "size-5 rounded-full text-[8px]",
  md: "size-7 rounded-full text-[10px]",
  lg: "size-9 rounded-full text-xs",
};

/**
 * A subscription's visual mark — the provider's real brand logo when we know it
 * (a white Simple Icons glyph on a brand-color circle), falling back to a
 * brand-color monogram chip. The accent color prefers an explicit `sub.color`,
 * then a matched provider preset's brand color, then the category color — so
 * Netflix reads red, Spotify green, etc.
 *
 * The logo is fetched lazily from the keyless Simple Icons CDN; if the slug is
 * missing or the request 404s, `onError` swaps to the monogram, so the UI never
 * shows a broken image. Stateful (the swap) so this is a client component.
 */
export function SubscriptionIcon({
  sub,
  size = "md",
  className,
}: {
  sub: Subscription;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}) {
  const preset = findProviderPreset(sub.provider) ?? findProviderPreset(sub.name);
  const color = sub.color || preset?.color || CATEGORY_META[sub.category].colorVar;
  const slug = preset?.icon;
  const [failed, setFailed] = useState(false);
  const showLogo = Boolean(slug) && !failed;

  return (
    <span
      title={sub.name}
      className={cn(
        "inline-grid shrink-0 place-items-center overflow-hidden ring-1 ring-inset ring-white/15",
        SIZE_CLASS[size] ?? SIZE_CLASS.md,
        className,
      )}
      style={{ backgroundColor: color }}
    >
      {showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={providerIconUrl(slug as string)}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
          className="h-[62%] w-[62%] object-contain"
        />
      ) : (
        <span className="font-semibold leading-none text-white drop-shadow-sm">
          {getMonogram(sub)}
        </span>
      )}
    </span>
  );
}
