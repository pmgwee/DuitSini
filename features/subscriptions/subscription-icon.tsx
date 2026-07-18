import type { Subscription } from "@/types/subscription";
import { CATEGORY_META } from "@/lib/constants";
import { findProviderPreset } from "@/lib/providers";
import type { CSSProperties } from "react";
import { ProviderMark } from "./provider-mark";

/**
 * A subscription's visual mark, resolved from the subscription itself: the
 * brand logo (when its provider matches a known preset) on a brand-color
 * circle, falling back to a monogram. The accent color prefers an explicit
 * `sub.color`, then a matched provider preset's brand color, then the category
 * color — so Netflix reads red, Spotify green, etc. Renders `ProviderMark`.
 */
export function SubscriptionIcon({
  sub,
  size = "md",
  className,
  style,
}: {
  sub: Subscription;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  style?: CSSProperties;
}) {
  const preset = findProviderPreset(sub.provider) ?? findProviderPreset(sub.name);
  const color = sub.color || preset?.color || CATEGORY_META[sub.category].colorVar;
  return (
    <ProviderMark
      name={sub.provider || sub.name}
      color={color}
      slug={preset?.icon}
      domain={preset?.domain}
      logoUrl={preset?.logoUrl}
      size={size}
      className={className}
      style={style}
    />
  );
}
