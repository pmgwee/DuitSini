import { mockSubscriptionRepository } from "./mock/mock-repo";
import type { SubscriptionRepository } from "./types";

export { DEMO_USER_ID } from "./types";
export type { SubscriptionRepository } from "./types";

const dataSource = process.env.NEXT_PUBLIC_DATA_SOURCE ?? "mock";

export function isSupabaseEnabled(): boolean {
  return dataSource === "supabase";
}

/**
 * Returns the active subscription repository. With `NEXT_PUBLIC_DATA_SOURCE=supabase`
 * it builds a Supabase-backed repo bound to the request's auth cookies; otherwise
 * it returns the in-memory mock seeded with demo data. Both satisfy the same
 * `SubscriptionRepository` contract, so callers never change.
 */
export async function getSubscriptionRepository(): Promise<SubscriptionRepository> {
  if (isSupabaseEnabled()) {
    const [{ createSupabaseServerClient }, { createSupabaseSubscriptionRepository }] =
      await Promise.all([
        import("@/lib/supabase/server"),
        import("./supabase/supabase-repo"),
      ]);
    const client = await createSupabaseServerClient();
    return createSupabaseSubscriptionRepository(client);
  }
  return mockSubscriptionRepository;
}
