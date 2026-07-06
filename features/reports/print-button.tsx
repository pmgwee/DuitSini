"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Print/Export the report (browser → Save as PDF). */
export function PrintButton() {
  return (
    <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => window.print()}>
      <Printer className="size-4" /> Export
    </Button>
  );
}
