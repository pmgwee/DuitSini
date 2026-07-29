"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { revealItem, staggerContainer } from "@/lib/motion";

/** Fade + rise into view (once). For sections, cards, blocks. */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.2 }}
      variants={revealItem}
      transition={{ delay }}
    >
      {children}
    </motion.div>
  );
}

/** Staggered container — drives the stagger timing. Children MUST be <StaggerItem>. */
export function Stagger({
  children,
  className,
  stagger = 0.05,
}: {
  children: ReactNode;
  className?: string;
  stagger?: number;
}) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.15 }}
      variants={staggerContainer(stagger)}
    >
      {children}
    </motion.div>
  );
}

/** Child of <Stagger>. Names the reveal variant; the parent drives timing. */
export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} variants={revealItem}>
      {children}
    </motion.div>
  );
}
