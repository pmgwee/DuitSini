"use client";

import { motion } from "framer-motion";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Route-level enter animation for the AUTHED app.
 *
 * ⚠ This MUST live under `app/(app)/` — NOT at the root. In Next.js, a
 * `template.tsx` remounts its subtree on every navigation (that is the
 * documented difference from `layout.tsx`, which persists state). If this file
 * sits at `app/template.tsx` (root), it wraps `(app)/layout.tsx` too, and that
 * remounts `MusicPlayerProvider` on every route change — which destroys the
 * YouTube IFrame, stops the music, and the floating mini-bar never appears.
 *
 * At this level the rendering order is `layout > template > page`, so the
 * provider (in the layout) stays mounted while only the page content remounts
 * and plays its fade + rise. That is the whole point: animate the page, never
 * the persistent player.
 */
export default function Template({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <motion.div
      key={pathname}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}
