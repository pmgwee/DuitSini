import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

/**
 * One surface recipe to retire the ~20 hand-rolled card class strings drifting
 * across settings/reports/bills. Locks radius + border + background to three
 * variants; padding stays caller-controlled (use the page's spacing token).
 */
const surfaceVariants = {
  flat: "rounded-2xl border border-border/60 bg-surface/40",
  glass: "rounded-2xl border border-border/60 glass",
  elevated: "rounded-2xl border border-border/60 bg-surface/70 card-elevated",
} as const;

export function Surface({
  variant = "elevated",
  className,
  ...props
}: { variant?: keyof typeof surfaceVariants } & ComponentProps<"div">) {
  return <div className={cn(surfaceVariants[variant], className)} {...props} />;
}
