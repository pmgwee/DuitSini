"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Print the in-app report page (browser dialog → "Save as PDF"). This renders
 * the live page, so it always reflects the current styling — unlike the stored
 * report_html snapshot. Kept as the in-app "export to PDF" affordance.
 */
export function PrintButton() {
  return (
    <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => window.print()}>
      <Printer className="size-4" /> Print
    </Button>
  );
}
