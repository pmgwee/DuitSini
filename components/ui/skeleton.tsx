import { cn } from "@/lib/utils";

/**
 * Shimmer placeholder used by route `loading.tsx` files. The `.skeleton` class
 * (globals.css) supplies the theme-aware base tint + sweeping sheen; callers
 * size/shape it with utility classes. Purely presentational.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden="true" />;
}
