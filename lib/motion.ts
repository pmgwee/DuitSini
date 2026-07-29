import type { Transition, Variants } from "framer-motion";

/**
 * One motion vocabulary for the whole app. The dashboard surface uses RESTRAINT
 * (Material ease-out, 120–300ms) — the marketing/login vocabulary (expo-out,
 * springs with overshoot, shaders) lives on non-data surfaces only.
 *
 * Applied globally via <MotionConfig> in app/providers.tsx; exported here so
 * per-component overrides and overlay transitions stay consistent.
 */

/** Confident snappy default — tiles, tabs, toasts, dialog. */
export const spring: Transition = { type: "spring", stiffness: 380, damping: 30, mass: 0.8 };

/** Larger surfaces — drawers, modals, sheets. */
export const springGentle: Transition = { type: "spring", stiffness: 200, damping: 26 };

/** Celebrations — payment received, AI task done. Use sparingly. */
export const springPop: Transition = { type: "spring", stiffness: 500, damping: 12, mass: 0.6 };

/** Dashboard easing — Material standard. NOT expo (expo is marketing-only). */
export const easeOut = [0.4, 0, 0.2, 1] as [number, number, number, number];

/** Marketing/login easing — expo-out. Non-data surfaces only. */
export const easeExpo = [0.16, 1, 0.3, 1] as [number, number, number, number];

export const dur = { fast: 0.12, base: 0.2, slow: 0.3 } as const;

/** Enter variant — fade + rise. The pattern features/serenity already uses;
 *  extracted here so every page reuses it instead of hand-rolling. */
export const revealItem: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: dur.base, ease: easeOut } },
};

/** Container variant factory — staggers children's `show` by `stagger` (default 50ms). */
export const staggerContainer = (stagger = 0.05): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: stagger, delayChildren: 0.05 } },
});
