"use client";

import { useState, type ReactNode } from "react";
import { Pencil, Plus } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Subscription } from "@/types/subscription";
import { SubscriptionForm } from "./subscription-form";

/** "Add subscription" trigger that opens the create form in a dialog. */
export function AddSubscriptionButton({
  className,
  size,
  label = "Add subscription",
  defaultStartDate,
}: {
  className?: string;
  size?: "sm" | "default" | "lg";
  label?: string;
  /** Initial start date (e.g. the calendar day the user clicked "Add" from). */
  defaultStartDate?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size={size}
        className={cn("gap-1.5", className)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Plus className="size-4" /> {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add subscription"
        description="Track a new recurring charge, trial, or bill."
      >
        <SubscriptionForm
          defaultStartDate={defaultStartDate}
          onDone={() => setOpen(false)}
        />
      </Dialog>
    </>
  );
}

/** "Edit" trigger that opens the edit form (with lifecycle actions) for a sub. */
export function EditSubscriptionButton({
  subscription,
  className,
  children,
}: {
  subscription: Subscription;
  className?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className={cn("gap-1.5", className)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {children ?? (
          <>
            <Pencil className="size-3.5" /> Edit
          </>
        )}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Edit subscription">
        <SubscriptionForm subscription={subscription} onDone={() => setOpen(false)} />
      </Dialog>
    </>
  );
}
