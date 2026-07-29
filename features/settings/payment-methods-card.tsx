"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Loader2, Plus, Trash2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { ProviderMark } from "@/features/subscriptions/provider-mark";
import { usePaymentMethods } from "@/features/subscriptions/use-payment-methods";
import { getPaymentMethodUsageCounts } from "@/lib/data/actions";
import {
  PAYMENT_KINDS,
  PAYMENT_KIND_COLOR,
  PAYMENT_KIND_META,
  findIssuer,
  issuersForKind,
  type PaymentKind,
} from "@/lib/payment-methods";
import type { PaymentMethod } from "@/types/payment-method";
import type { PaymentMethodInput } from "@/lib/validation/payment-method";

const CUSTOM_ISSUER = "__custom__";

const inputClass =
  "h-11 w-full rounded-xl border border-border/60 bg-input/50 px-3 text-sm outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 focus:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40";

/** Card kinds append "· Credit"/"· Debit"; others show the issuer name alone. */
function methodLabel(m: PaymentMethod): string {
  const isCard = m.kind === "credit_card" || m.kind === "debit_card";
  return isCard ? `${m.issuerName} · ${PAYMENT_KIND_META[m.kind].short}` : m.issuerName;
}

/**
 * The "Payment methods" management card on /settings. Lists every saved method
 * with its issuer logo + a "used by N subscriptions" hint, lets the user add a
 * new one (kind → issuer, mirroring the subscription-form picker), and delete
 * with a per-row confirm. Deleting a method in use is safe — the FK is
 * `ON DELETE SET NULL`, so the linked subscriptions stay and just lose the tag;
 * the confirm copy says so.
 *
 * Self-fetches through the repo abstraction (the `usePaymentMethods` session
 * cache + the `getPaymentMethodUsageCounts` action) so it works in both mock and
 * Supabase modes, independent of the settings page's direct Supabase reads.
 */
export function PaymentMethodsCard() {
  const { methods, loaded, create, remove } = usePaymentMethods();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [countsLoaded, setCountsLoaded] = useState(false);

  const refreshCounts = async () => {
    try {
      setCounts(await getPaymentMethodUsageCounts());
    } catch {
      /* keep last known counts */
    } finally {
      setCountsLoaded(true);
    }
  };

  useEffect(() => {
    void refreshCounts();
  }, []);

  // ── Inline "add" panel state (mirrors the picker's authoring panel) ──────
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<PaymentKind>("credit_card");
  const [issuerSlug, setIssuerSlug] = useState("");
  const [issuerName, setIssuerName] = useState("");
  const [customIssuer, setCustomIssuer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const kindOptions = PAYMENT_KINDS.map((k) => ({
    value: k,
    label: PAYMENT_KIND_META[k].label,
    color: PAYMENT_KIND_META[k].colorVar,
  }));
  const issuerPool = issuersForKind(kind);
  const issuerOptions = [
    { value: CUSTOM_ISSUER, label: "Other (type a name)…", keywords: ["other", "custom", "type"] },
    ...issuerPool.map((i) => ({ value: i.slug, label: i.label, keywords: i.keywords })),
  ];

  const resetPanel = () => {
    setAdding(false);
    setKind("credit_card");
    setIssuerSlug("");
    setIssuerName("");
    setCustomIssuer(false);
    setAddError(null);
  };

  const onKindChange = (k: string) => {
    setKind(k as PaymentKind);
    setIssuerSlug("");
    setIssuerName("");
    setCustomIssuer(false);
    setAddError(null);
  };

  const onIssuerChange = (v: string) => {
    setAddError(null);
    if (v === CUSTOM_ISSUER) {
      setCustomIssuer(true);
      setIssuerSlug("");
      return;
    }
    const issuer = issuerPool.find((i) => i.slug === v);
    setCustomIssuer(false);
    setIssuerSlug(v);
    setIssuerName(issuer?.label ?? "");
  };

  const handleCreate = async () => {
    setAddError(null);
    const name = issuerName.trim();
    if (!name) {
      setAddError("Pick the bank / wallet — or type a name.");
      return;
    }
    const input: PaymentMethodInput = {
      kind,
      issuerSlug: issuerSlug || null,
      issuerName: name,
    };
    setBusy(true);
    try {
      await create(input);
      resetPanel();
    } catch {
      setAddError("Couldn't save the payment method. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border/60 bg-surface/40 p-6">
      <div className="mb-1 flex items-center gap-2">
        <Wallet className="size-4 text-primary" />
        <h2 className="text-sm font-medium">Payment methods</h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Saved cards, accounts, and wallets your subscriptions charge to.
      </p>

      {!loaded ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : methods.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No saved payment methods yet — add one below.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/50">
          {methods.map((m) => (
            <MethodRow
              key={m.id}
              method={m}
              count={counts[m.id] ?? 0}
              countsLoaded={countsLoaded}
              remove={remove}
              onRemoved={refreshCounts}
            />
          ))}
        </ul>
      )}

      {adding ? (
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border/60 bg-surface/40 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              New payment method
            </span>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={resetPanel}
            >
              Cancel
            </button>
          </div>

          <PanelField label="Type">
            <Select ariaLabel="Payment type" value={kind} onChange={onKindChange} options={kindOptions} />
          </PanelField>

          <PanelField label="Bank / wallet">
            <Select
              ariaLabel="Issuer"
              value={customIssuer ? CUSTOM_ISSUER : issuerSlug}
              onChange={onIssuerChange}
              options={issuerOptions}
            />
          </PanelField>

          {customIssuer && (
            <PanelField label="Name">
              <input
                className={inputClass}
                placeholder="e.g. Maybank"
                value={issuerName}
                onChange={(e) => setIssuerName(e.target.value)}
              />
            </PanelField>
          )}

          {addError ? (
            <p role="alert" className="text-xs text-danger">
              {addError}
            </p>
          ) : null}

          <Button
            type="button"
            size="sm"
            onClick={handleCreate}
            disabled={busy}
            className="gap-1.5 self-start"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            Save method
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-4 gap-1.5"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-3.5" /> Add payment method
        </Button>
      )}
    </section>
  );
}

function MethodRow({
  method,
  count,
  countsLoaded,
  remove,
  onRemoved,
}: {
  method: PaymentMethod;
  count: number;
  countsLoaded: boolean;
  remove: (id: string) => Promise<boolean>;
  onRemoved: () => Promise<void> | void;
}) {
  const issuer = findIssuer(method.issuerSlug);
  const color = issuer?.color ?? PAYMENT_KIND_COLOR[method.kind];
  const label = methodLabel(method);

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleDelete = async () => {
    setBusy(true);
    setErr(null);
    const ok = await remove(method.id);
    setBusy(false);
    if (ok) {
      // Row is gone from the list; refresh the usage tally so counts stay honest.
      await onRemoved();
    } else {
      setErr("Couldn't delete. Try again.");
      setConfirming(false);
    }
  };

  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <ProviderMark
        name={method.issuerName}
        color={color}
        logoUrl={issuer?.logoUrl}
        slug={issuer?.icon}
        domain={issuer?.domain}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">
          {countsLoaded ? (count > 0 ? `${count} subscription${count === 1 ? "" : "s"}` : "Unused") : "…"}
        </div>
        {confirming && count > 0 ? (
          <div className="mt-1 text-[11px] text-warning">
            {count} subscription{count === 1 ? "" : "s"} will be unlinked (not deleted).
          </div>
        ) : null}
        {err ? (
          <div role="alert" className="mt-1 text-[11px] text-danger">
            {err}
          </div>
        ) : null}
      </div>

      {confirming ? (
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={handleDelete}
            aria-label={`Confirm delete ${label}`}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            Confirm
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              setErr(null);
            }}
          >
            Keep
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-danger hover:bg-danger/10"
          onClick={() => setConfirming(true)}
          aria-label={`Delete ${label}`}
        >
          <Trash2 className="size-3.5" /> Delete
        </Button>
      )}
    </li>
  );
}

function PanelField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
