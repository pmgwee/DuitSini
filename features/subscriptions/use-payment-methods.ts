"use client";

import { useEffect, useState } from "react";
import { createPaymentMethod, listPaymentMethods } from "@/lib/data/actions";
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

  return { methods, loaded, create };
}
