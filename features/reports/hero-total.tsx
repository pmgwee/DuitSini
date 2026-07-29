"use client";

import { CountUp } from "@/components/ui/count-up";
import { formatCurrency } from "@/lib/domain/money";
import { HOME_CURRENCY } from "@/lib/domain/fx";

/**
 * Animated hero total for the report detail pages. Kept as a client island so
 * the count-up runs in the browser AND so the formatCurrency formatter can be
 * built here (a Server Component can't pass a function prop down). The server
 * page passes only the serializable `value`.
 */
export function ReportHeroTotal({ value, className }: { value: number; className?: string }) {
  return <CountUp value={value} className={className} format={(v) => formatCurrency(v, HOME_CURRENCY)} />;
}
