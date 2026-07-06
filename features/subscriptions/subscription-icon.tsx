import type { Subscription } from "@/types/subscription";
import { CATEGORY_META } from "@/lib/constants";
import { getMonogram } from "@/lib/domain/subscription";
import { cn } from "@/lib/utils";

/**
 * A subscription's visual mark: a category-tinted monogram chip. Used in
 * calendar day cells, the day detail list, and (later) list rows.
 */
export function SubscriptionIcon({
  sub,
  size = "md",
  className,
}: {
  sub: Subscription;
  size?: "sm" | "md";
  className?: string;
}) {
  const color = CATEGORY_META[sub.category].colorVar;
  return (
    <span
      title={sub.name}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-lg font-semibold ring-1 ring-inset ring-white/10",
        size === "sm" ? "size-5 text-[9px]" : "size-7 text-[10px]",
        className,
      )}
      style={{
        backgroundColor: `color-mix(in oklch, ${color} 22%, transparent)`,
        color,
      }}
    >
      {getMonogram(sub)}
    </span>
  );
}
