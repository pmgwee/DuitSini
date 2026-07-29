"use client";

import { animate, useInView, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

/**
 * Animated count-up for KPI numbers. Counts 0 → value when scrolled into view
 * (once). Respects prefers-reduced-motion (snaps to the final value). Uses
 * framer-motion's animate() — no extra dependency.
 *
 * Pass `format` to match an existing server-side formatter (e.g. formatCurrency)
 * from inside a client wrapper — never pass a function from a Server Component.
 */
export function CountUp({
  value,
  duration = 1,
  decimals = 0,
  prefix = "",
  suffix = "",
  className,
  format,
}: {
  value: number;
  duration?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  format?: (n: number) => string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setDisplay(value);
      return;
    }
    const controls = animate(0, value, {
      duration,
      ease: "easeOut",
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [inView, value, duration, reduce]);

  const formatted = format
    ? format(display)
    : display.toLocaleString("en-MY", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });

  return (
    <span ref={ref} className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}

/** Convenience: animated ringgit amount. RM 1,234.50 */
export function CountUpMoney({
  value,
  className,
  decimals = 2,
}: {
  value: number;
  className?: string;
  decimals?: number;
}) {
  return <CountUp value={value} decimals={decimals} prefix="RM " className={className} />;
}
