import type { PaymentMethod } from "@/types/payment-method";
import type { PaymentMethodInput, PaymentMethodPatch } from "@/lib/validation/payment-method";
import type { PaymentMethodRepository } from "../types";
import { paymentMethodStore } from "./payment-method-store";

let sequence = paymentMethodStore.size;
function nextId(): string {
  return `pm_${(++sequence).toString().padStart(3, "0")}`;
}

function owned(userId: string, id: string): PaymentMethod | null {
  const method = paymentMethodStore.get(id);
  return method && method.userId === userId ? method : null;
}

export const mockPaymentMethodRepository: PaymentMethodRepository = {
  async list(userId) {
    return [...paymentMethodStore.values()]
      .filter((m) => m.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  async create(userId, input: PaymentMethodInput) {
    const timestamp = new Date().toISOString();
    const method: PaymentMethod = {
      id: nextId(),
      userId,
      kind: input.kind,
      issuerSlug: input.issuerSlug ?? null,
      issuerName: input.issuerName,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    paymentMethodStore.set(method.id, method);
    return method;
  },

  async update(userId, id, patch: PaymentMethodPatch) {
    const method = owned(userId, id);
    if (!method) return null;
    if (patch.kind !== undefined) method.kind = patch.kind;
    if (patch.issuerSlug !== undefined) method.issuerSlug = patch.issuerSlug ?? null;
    if (patch.issuerName !== undefined) method.issuerName = patch.issuerName;
    method.updatedAt = new Date().toISOString();
    paymentMethodStore.set(id, method);
    return method;
  },

  async remove(userId, id) {
    if (!owned(userId, id)) return false;
    // Subscriptions keep a (now-stale) paymentMethodId; the subscription repo
    // resolves missing ids to a null method on next read — mirroring the DB's
    // ON DELETE SET NULL without needing a cross-store cleanup hook.
    return paymentMethodStore.delete(id);
  },
};
