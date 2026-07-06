"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Ban, Loader2, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import {
  BILLING_CYCLES,
  BILLING_CYCLE_LABELS,
  CATEGORIES,
  CATEGORY_META,
  CURRENCIES,
} from "@/lib/constants";
import {
  subscriptionInputSchema,
  subscriptionPatchSchema,
  type SubscriptionInput,
  type SubscriptionPatch,
} from "@/lib/validation/subscription";
import {
  createSubscription,
  deleteSubscription,
  setSubscriptionCancelled,
  setSubscriptionPaused,
  updateSubscription,
} from "@/lib/data/actions";
import type { Subscription } from "@/types/subscription";
import { Button } from "@/components/ui/button";
import { toISODate } from "@/lib/domain/dates";
import { cn } from "@/lib/utils";

const inputClass =
  "h-11 w-full rounded-xl border border-border/60 bg-input/50 px-3 text-sm outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 focus:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40";

interface FieldValues {
  name: string;
  provider: string;
  category: string;
  amount: number;
  currency: string;
  billingCycle: string;
  intervalCount: number;
  planType: string;
  startDate: string;
  isTrial: boolean;
  freeTrialEndAt: string;
  notes: string;
}

/**
 * Add/edit subscription form. Create uses the full input schema; edit uses the
 * partial patch schema. Either way the fields are the same; on submit it calls
 * the matching server action, then `onDone` (closes the dialog).
 */
export function SubscriptionForm({
  subscription,
  onDone,
}: {
  subscription?: Subscription | null;
  onDone: () => void;
}) {
  const mode: "create" | "edit" = subscription ? "edit" : "create";
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FieldValues>({
    resolver: zodResolver(mode === "edit" ? subscriptionPatchSchema : subscriptionInputSchema) as never,
    defaultValues: {
      name: subscription?.name ?? "",
      provider: subscription?.provider ?? "",
      category: subscription?.category ?? "other",
      amount: subscription?.amount ?? (undefined as unknown as number),
      currency: subscription?.currency ?? "USD",
      billingCycle: subscription?.billingCycle ?? "monthly",
      intervalCount: subscription?.intervalCount ?? 1,
      planType: subscription?.planType ?? "",
      startDate: subscription?.startDate ?? toISODate(new Date()),
      isTrial: subscription?.isTrial ?? false,
      freeTrialEndAt: subscription?.freeTrialEndAt ?? "",
      notes: subscription?.notes ?? "",
    },
  });

  const billingCycle = watch("billingCycle");
  const isTrial = watch("isTrial");
  const showInterval = billingCycle === "custom_days" || billingCycle === "custom_months";

  const onSubmit = async (values: FieldValues) => {
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "edit" && subscription) {
        await updateSubscription(subscription.id, values as unknown as SubscriptionPatch);
      } else {
        await createSubscription(values as unknown as SubscriptionInput);
      }
      onDone();
    } catch {
      setError("Couldn't save. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
      <Field label="Name" error={errors.name?.message as string | undefined} required>
        <input className={inputClass} placeholder="e.g. Netflix" required {...register("name")} />
      </Field>

      <Field label="Provider" hint="optional">
        <input className={inputClass} placeholder="e.g. Netflix, Inc." {...register("provider")} />
      </Field>

      <Field label="Category">
        <select className={inputClass} {...register("category")}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_META[c].label}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount" error={errors.amount?.message as string | undefined} required>
          <input
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            className={inputClass}
            placeholder="0.00"
            required
            {...register("amount", { setValueAs: (v) => (v === "" ? undefined : Number(v)) })}
          />
        </Field>
        <Field label="Currency">
          <select className={inputClass} {...register("currency")}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className={cn("grid gap-3", showInterval ? "grid-cols-2" : "grid-cols-1")}>
        <Field label="Billing cycle">
          <select className={inputClass} {...register("billingCycle")}>
            {BILLING_CYCLES.map((c) => (
              <option key={c} value={c}>
                {BILLING_CYCLE_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        {showInterval && (
          <Field
            label={billingCycle === "custom_days" ? "Every (days)" : "Every (months)"}
            error={errors.intervalCount?.message as string | undefined}
          >
            <input
              type="number"
              min="1"
              inputMode="numeric"
              className={inputClass}
              {...register("intervalCount", { setValueAs: (v) => (v === "" ? undefined : Number(v)) })}
            />
          </Field>
        )}
      </div>

      <Field label="Start date" error={errors.startDate?.message as string | undefined} required>
        <input type="date" className={inputClass} required {...register("startDate")} />
      </Field>

      <label className="flex cursor-pointer items-center justify-between rounded-xl border border-border/60 bg-surface/30 px-3 py-2.5">
        <span className="text-sm">
          <span className="font-medium">Free trial</span>
          <span className="ml-2 text-xs text-muted-foreground">converts to paid after the trial</span>
        </span>
        <input
          type="checkbox"
          className="size-4 accent-primary"
          {...register("isTrial")}
        />
      </label>

      {isTrial && (
        <Field label="Trial ends on" error={errors.freeTrialEndAt?.message as string | undefined}>
          <input
            type="date"
            className={inputClass}
            {...register("freeTrialEndAt", {
              setValueAs: (v) => (v === "" ? undefined : v),
            })}
          />
        </Field>
      )}

      <Field label="Notes" hint="optional">
        <textarea
          rows={2}
          className={cn(inputClass, "h-auto py-2.5 resize-none")}
          placeholder="Anything worth remembering…"
          {...register("notes")}
        />
      </Field>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onDone} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting} aria-busy={submitting} className="gap-1.5">
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {mode === "edit" ? "Save changes" : "Add subscription"}
        </Button>
      </div>

      {subscription ? (
        <LifecycleActions subscription={subscription} onDone={onDone} />
      ) : null}
    </form>
  );
}

function LifecycleActions({
  subscription,
  onDone,
}: {
  subscription: Subscription;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onDone();
    } catch {
      setErr("Couldn’t update. Please try again.");
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-border/60 pt-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Manage
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => run(() => setSubscriptionPaused(subscription.id, !subscription.isPaused))}
        >
          {subscription.isPaused ? (
            <>
              <Play className="size-3.5" /> Resume
            </>
          ) : (
            <>
              <Pause className="size-3.5" /> Pause
            </>
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            run(() => setSubscriptionCancelled(subscription.id, !subscription.isCancelled))
          }
        >
          {subscription.isCancelled ? (
            <>
              <RotateCcw className="size-3.5" /> Restore
            </>
          ) : (
            <>
              <Ban className="size-3.5" /> Cancel
            </>
          )}
        </Button>
        {confirmingDelete ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => run(() => deleteSubscription(subscription.id))}
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}{" "}
              Confirm delete
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmingDelete(false)}
            >
              Keep
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 className="size-3.5" /> Delete
          </Button>
        )}
      </div>
      {err ? (
        <div
          role="alert"
          className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs text-danger"
        >
          {err}
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2 text-sm font-medium">
        {label}
        {required ? <span className="text-danger">*</span> : null}
        {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
      </span>
      {children}
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </label>
  );
}
