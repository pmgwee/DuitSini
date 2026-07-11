"use client";

import { useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { CATEGORY_COLOR } from "@/lib/constants";
import type { Category } from "@/lib/constants";
import { formatCurrency } from "@/lib/domain/money";
import { HOME_CURRENCY } from "@/lib/domain/fx";
import type { ReportCategoryTotal } from "@/lib/reports/types";

/**
 * Category ring for a stored report. The DONUT keeps its hover interaction —
 * hovering a slice dims the others and surfaces a detail box at the TOP of the
 * legend column (i.e. BESIDE the chart, never overlapping the center label).
 * The legend TEXT rows are intentionally static: no row hover highlight, so the
 * only hover affordance is the chart itself. The donut center always shows the
 * period total; legend rows carry the category count when `counts` is supplied.
 */
export function ReportCategoryChart({
  categories,
  counts,
  centerLabel,
  centerValue,
}: {
  categories: ReportCategoryTotal[];
  /** Optional category → subscription count, shown in the legend. */
  counts?: Record<string, number>;
  centerLabel: string;
  centerValue: number;
}) {
  const [active, setActive] = useState<number | null>(null);

  const data = categories.map((c) => ({
    category: c.category as Category,
    label: c.label,
    value: c.totalMYR,
    count: counts?.[c.category] ?? 0,
    color: CATEGORY_COLOR[c.category as Category] ?? CATEGORY_COLOR.other,
  }));
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const activeItem = active != null ? data[active] : null;

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <div className="relative h-44 w-44 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius={52}
              outerRadius={80}
              paddingAngle={2}
              stroke="none"
              onMouseEnter={(_, i) => setActive(i)}
              onMouseLeave={() => setActive(null)}
              isAnimationActive={false}
            >
              {data.map((d, i) => (
                <Cell
                  key={d.category}
                  fill={d.color}
                  opacity={active == null || active === i ? 1 : 0.35}
                  style={{ transition: "opacity 120ms" }}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-center">
            <div className="text-[11px] text-muted-foreground">{centerLabel}</div>
            <div className="text-sm font-semibold">{formatCurrency(centerValue, HOME_CURRENCY)}</div>
          </div>
        </div>
      </div>

      <div className="flex w-full flex-1 flex-col gap-2">
        {/* Hover detail — sits beside the donut (top of the legend column), not over its center. */}
        {activeItem ? (
          <div className="rounded-lg border border-border/60 bg-surface px-3 py-2 text-xs shadow-sm">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ background: activeItem.color }} />
              <span className="font-medium">{activeItem.label}</span>
            </div>
            <div className="mt-1 text-muted-foreground">
              {formatCurrency(activeItem.value, HOME_CURRENCY)}
              {" · "}
              {Math.round((activeItem.value / total) * 100)}%
            </div>
          </div>
        ) : null}

        {/* Static legend — no row hover (the donut drives the only hover affordance). */}
        <ul className="flex w-full flex-1 flex-col gap-0.5">
          {data.map((d) => (
            <li
              key={d.category}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs"
            >
              <span className="size-2 shrink-0 rounded-full" style={{ background: d.color }} />
              <span className="flex-1 truncate text-muted-foreground">{d.label}</span>
              {counts ? (
                <span className="tabular-nums text-muted-foreground/70">{d.count}</span>
              ) : null}
              <span className="w-20 text-right font-medium tabular-nums">
                {formatCurrency(d.value, HOME_CURRENCY)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
