"use client";

import { findIssuer, PAYMENT_KIND_COLOR, PAYMENT_KIND_META } from "@/lib/payment-methods";
import type { PaymentMethod } from "@/types/payment-method";
import { ProviderMark } from "./provider-mark";
import { cn } from "@/lib/utils";

/**
 * Compact pill showing a subscription's payment instrument — issuer logo (via
 * the `ProviderMark` cascade) + name. Cards append the kind (Credit / Debit)
 * since no card number or network is stored. Callers gate on
 * `sub.paymentMethod` being non-null.
 */
export function PaymentMethodBadge({
  method,
  className,
}: {
  method: PaymentMethod;
  className?: string;
}) {
  const issuer = findIssuer(method.issuerSlug);
  const color = issuer?.color ?? PAYMENT_KIND_COLOR[method.kind];
  const isCard = method.kind === "credit_card" || method.kind === "debit_card";
  const text = isCard
    ? `${method.issuerName} · ${PAYMENT_KIND_META[method.kind].short}`
    : method.issuerName;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-surface/60 py-0.5 pl-1 pr-2 text-xs text-muted-foreground",
        className,
      )}
      title={text}
    >
      <ProviderMark
        name={method.issuerName}
        color={color}
        logoUrl={issuer?.logoUrl}
        slug={issuer?.icon}
        domain={issuer?.domain}
        size="xs"
      />
      <span className="max-w-35 truncate">{text}</span>
    </span>
  );
}
