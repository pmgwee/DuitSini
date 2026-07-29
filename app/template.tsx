"use client";

import { motion } from "framer-motion";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Route-level enter animation. `template.tsx` re-renders on every navigation
 * (unlike layout.tsx); keyed by pathname the motion.div re-mounts and plays a
 * short fade + rise on each new route. Enter-only (no AnimatePresence) so the
 * swap stays snappy — the new page's rise masks the instant replace. The
 * existing top route-progress bar covers perceived latency during the fetch.
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
