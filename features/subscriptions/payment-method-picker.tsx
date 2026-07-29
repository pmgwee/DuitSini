"use client";

import { useState, type ReactNode } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  PAYMENT_KINDS,
  PAYMENT_KIND_META,
  issuersForKind,
  type PaymentKind,
} from "@/lib/payment-methods";
import type { PaymentMethod } from "@/types/payment-method";
import type { PaymentMethodInput } from "@/lib/validation/payment-method";
import { usePaymentMethods } from "./use-payment-methods";

const ADD_NEW = "__add_new__";
const CUSTOM_ISSUER = "__custom__";

const inputClass =
  "h-11 w-full rounded-xl border border-border/60 bg-input/50 px-3 text-sm outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 focus:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40";

function methodLabel(m: PaymentMethod): string {
  const isCard = m.kind === "credit_card" || m.kind === "debit_card";
  return isCard ? `${m.issuerName} · ${PAYMENT_KIND_META[m.kind].short}` : m.issuerName;
}

/**
 * Payment-method selector for the subscription form. Shows the user's existing
 * methods in a dropdown plus an "Add new…" entry that expands an inline authoring
 * panel (kind → issuer). A new method is created via a server action before the
 * main form submits, and the returned id flows back through `onChange` into the
 * form's `paymentMethodId`.
 *
 * No card number or nickname is collected — a method is just its kind + the
 * issuing bank/wallet.
 */
export function PaymentMethodPicker({
  value,
  onChange,
  id,
  required,
}: {
  value: string;
  onChange: (id: string) => void;
  id?: string;
  required?: boolean;
}) {
  const { methods, create } = usePaymentMethods();

  // Inline "add new" panel state.
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<PaymentKind>("credit_card");
  const [issuerSlug, setIssuerSlug] = useState("");
  const [issuerName, setIssuerName] = useState("");
  const [customIssuer, setCustomIssuer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const onKindChange = (k: string) => {
    setKind(k as PaymentKind);
    setIssuerSlug("");
    setIssuerName("");
    setCustomIssuer(false);
    setError(null);
  };

  const onIssuerChange = (v: string) => {
    setError(null);
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

  const onSelectChange = (v: string) => {
    if (v === ADD_NEW) {
      setAdding(true);
      return;
    }
    onChange(v);
  };

  const resetPanel = () => {
    setAdding(false);
    setKind("credit_card");
    setIssuerSlug("");
    setIssuerName("");
    setCustomIssuer(false);
    setError(null);
  };

  const handleCreate = async () => {
    setError(null);
    const name = issuerName.trim();
    if (!name) {
      setError("Pick the bank / wallet — or type a name.");
      return;
    }
    const input: PaymentMethodInput = {
      kind,
      issuerSlug: issuerSlug || null,
      issuerName: name,
    };
    setBusy(true);
    try {
      const created = await create(input);
      onChange(created.id);
      resetPanel();
    } catch {
      setError("Couldn't save the payment method. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const selectOptions = [
    ...methods.map((m) => ({ value: m.id, label: methodLabel(m) })),
    { value: ADD_NEW, label: "＋ Add new payment method…" },
  ];

  return (
    <div className="flex flex-col gap-2">
      <Select
        id={id}
        ariaLabel="Payment method"
        value={adding ? ADD_NEW : value}
        onChange={onSelectChange}
        options={selectOptions}
        searchable={false}
      />
      {required && !value && !adding ? (
        <p className="text-[11px] text-muted-foreground">Pick or add the card / account this charges.</p>
      ) : null}

      {adding && (
        <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-surface/40 p-3">
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

          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
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
      )}
    </div>
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
