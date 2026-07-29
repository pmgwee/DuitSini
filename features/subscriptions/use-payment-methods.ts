"use client";

import { useEffect, useState } from "react";
import {
  createPaymentMethod,
  deletePaymentMethod,
  listPaymentMethods,
} from "@/lib/data/actions";
import type { PaymentMethod } from "@/types/payment-method";
import type { PaymentMethodInput } from "@/lib/validation/payment-method";

// Module-level session cache so re-opening the add/edit dialog doesn't refetch,
// and so a method created inline is instantly visible to the picker (and to any
// badge rendered from the same cache) within the session.
let cache: PaymentMethod[] | null = null;

export function usePaymentMethods() {
  const [methods, setMethods] = useState<PaymentMethod[]>(cache ?? []);
  const [loaded, setLoaded] = useState<boolean>(cache != null);

  useEffect(() => {
    let active = true;
    if (cache) {
      setMethods(cache);
      setLoaded(true);
      return;
    }
    listPaymentMethods()
      .then((m) => {
        if (!active) return;
        cache = m;
        setMethods(m);
        setLoaded(true);
      })
      .catch(() => {
        /* swallow — the picker still lets the user add a new method */
      });
    return () => {
      active = false;
    };
  }, []);

  const create = async (input: PaymentMethodInput): Promise<PaymentMethod> => {
    const created = await createPaymentMethod(input);
    cache = [...(cache ?? []), created];
    setMethods(cache);
    return created;
  };

  // Deletes via the server action and, on success, drops the method from the
  // shared session cache — so the subscription-form picker reflects it too on
  // the next open. Returns false (without mutating state) on failure so the
  // caller can surface the error and keep the row.
  const remove = async (id: string): Promise<boolean> => {
    try {
      await deletePaymentMethod(id);
    } catch {
      return false;
    }
    cache = (cache ?? []).filter((m) => m.id !== id);
    setMethods(cache);
    return true;
  };

  return { methods, loaded, create, remove };
}
