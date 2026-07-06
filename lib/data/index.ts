import { mockSubscriptionRepository } from "./mock/mock-repo";
import { DEMO_USER_ID, type SubscriptionRepository } from "./types";

export { DEMO_USER_ID };
export type { SubscriptionRepository } from "./types";

const dataSource = process.env.NEXT_PUBLIC_DATA_SOURCE ?? "mock";

export function isSupabaseEnabled(): boolean {
  return dataSource === "supabase";
}

/**
 * The user id to scope data queries with. Real `auth.uid()` in Supabase mode
 * (so RLS returns the signed-in user's rows); the fixed demo id in mock mode
 * (so the seeded demo data shows regardless of who's signed in). Call from
 * server components / route handlers only.
 */
export async function getEffectiveUserId(): Promise<string> {
  if (!isSupabaseEnabled()) return DEMO_USER_ID;
  const { createSupabaseServerClient } = await import("@/lib/supabase/server");
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? DEMO_USER_ID;
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
