import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import type { PaymentKind } from "@/lib/payment-methods";
import type { PaymentMethod } from "@/types/payment-method";
import type { PaymentMethodInput, PaymentMethodPatch } from "@/lib/validation/payment-method";
import type { PaymentMethodRepository } from "../types";

type PmRow = Database["public"]["Tables"]["payment_methods"]["Row"];
type PmInsert = Database["public"]["Tables"]["payment_methods"]["Insert"];
type PmUpdate = Database["public"]["Tables"]["payment_methods"]["Update"];

/**
 * Map a raw payment_methods row (snake_case) to the domain `PaymentMethod`
 * (camelCase). Exported so the subscriptions repo can resolve the nested-select
 * join (`payment_method:payment_methods(*)`) without duplicating the mapping.
 */
export function rowToPaymentMethod(row: PmRow): PaymentMethod {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as PaymentKind,
    issuerSlug: row.issuer_slug,
    issuerName: row.issuer_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Supabase-backed repository. RLS enforces ownership; we additionally filter by
 * user_id as defense in depth. Requires an authenticated server client.
 */
export function createSupabasePaymentMethodRepository(
  client: SupabaseClient<Database>,
): PaymentMethodRepository {
  const table = () => client.from("payment_methods");

  return {
    async list(userId) {
      const { data, error } = await table()
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(rowToPaymentMethod);
    },

    async create(userId, input: PaymentMethodInput) {
      const insert: PmInsert = {
        user_id: userId,
        kind: input.kind,
        issuer_slug: input.issuerSlug ?? null,
        issuer_name: input.issuerName,
      };
      const { data, error } = await table().insert(insert).select("*").single();
      if (error) throw error;
      return rowToPaymentMethod(data);
    },

    async update(userId, id, patch: PaymentMethodPatch) {
      const update: PmUpdate = {};
      if (patch.kind !== undefined) update.kind = patch.kind;
      if (patch.issuerSlug !== undefined) update.issuer_slug = patch.issuerSlug ?? null;
      if (patch.issuerName !== undefined) update.issuer_name = patch.issuerName;
      const { data, error } = await table()
        .update(update)
        .eq("id", id)
        .eq("user_id", userId)
        .select("*")
        .maybeSingle();
      if (error) throw error;
      return data ? rowToPaymentMethod(data) : null;
    },

    async remove(userId, id) {
      const { data, error } = await table()
        .delete()
        .eq("id", id)
        .eq("user_id", userId)
        .select("id");
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    },
  };
}
