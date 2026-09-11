import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { CODEX_ACCOUNT_SLOTS, sortCodexAccounts, type CodexAccountMetadata } from "@/lib/claude-usage/codex-accounts";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const accountKeySchema = z.string().min(1).max(80).refine(
  (value) => CODEX_ACCOUNT_SLOTS.some((slot) => slot.account_key === value),
  "unknown account key",
);
const metadataSchema = z.object({
  account_key: accountKeySchema,
  email: z.string().email().max(320).nullable().optional(),
  member_id: z.string().max(160).nullable().optional(),
  workspace_id: z.string().max(160).nullable().optional(),
  workspace_name: z.string().max(120).nullable().optional(),
  plan_type: z.string().max(80).nullable().optional(),
});

const privateEnrollment = new Map([
  ["leeahming199@gmail.com", { business: "perminggwee@gmail.com", member: "leeahming199@gmail.com" }],
  ["perminggwee@gmail.com", { business: "perminggwee@gmail.com", member: "leeahming199@gmail.com" }],
]);

function fallbackAccounts(viewerEmail: string | null): CodexAccountMetadata[] {
  const enrollment = viewerEmail ? privateEnrollment.get(viewerEmail) : undefined;
  return CODEX_ACCOUNT_SLOTS.map((slot) => ({
    account_key: slot.account_key,
    slot: slot.slot,
    label: slot.label,
    email: enrollment?.[slot.slot] ?? null,
    member_id: null,
    workspace_id: null,
    workspace_name: null,
    plan_type: null,
    connected: false,
    verified: false,
    status: "needs_sign_in" as const,
    device_id: null,
    last_seen_at: null,
  }));
}

function sameSite(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "same-site" || site === "none";
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const viewerEmail = user.email?.trim().toLowerCase() ?? null;
  const { data, error } = await supabase
    .from("codex_accounts")
    .select("account_key, slot, label, email, member_id, workspace_id, workspace_name, plan_type, verified, status, device_id, last_seen_at")
    .eq("user_id", user.id);
  if (error) {
    // The additive migration may not have reached a self-hosted copy yet. Keep
    // the dashboard usable with two explicit, unconnected account shells.
    if (/codex_accounts|relation|column/i.test(error.message)) {
      return NextResponse.json({ accounts: fallbackAccounts(viewerEmail), devices: [], migration_pending: true });
    }
    return NextResponse.json({ error: "db", message: error.message }, { status: 500 });
  }
  const rows = new Map(
    (data ?? []).flatMap((row) => {
      const catalog = CODEX_ACCOUNT_SLOTS.find((slot) => slot.account_key === row.account_key);
      if (!catalog) return [];
      return [[row.account_key, {
        account_key: row.account_key,
        slot: catalog.slot,
        label: catalog.label,
        email: row.email,
        member_id: row.member_id,
        workspace_id: row.workspace_id,
        workspace_name: row.workspace_name,
        plan_type: row.plan_type,
        connected: row.status === "connected",
        verified: row.verified,
        status: row.status,
        device_id: row.device_id,
        last_seen_at: row.last_seen_at,
      } satisfies CodexAccountMetadata] as const];
    }),
  );
  const accounts = fallbackAccounts(viewerEmail).map((fallback) => rows.get(fallback.account_key) ?? fallback);
  const { data: devices } = await supabase
    .from("codex_devices")
    .select("id, device_name, protocol_version, switch_supported, active_account_key, active_email, active_workspace_id, active_workspace_name, heartbeat_at, generation, updated_at")
    .eq("user_id", user.id)
    .order("heartbeat_at", { ascending: false });
  return NextResponse.json({ accounts: sortCodexAccounts(accounts), devices: devices ?? [] });
}

export async function POST(req: NextRequest) {
  if (!sameSite(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = metadataSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad body" }, { status: 400 });
  const slot = CODEX_ACCOUNT_SLOTS.find((candidate) => candidate.account_key === parsed.data.account_key)!;
  const { data, error } = await supabase
    .from("codex_accounts")
    .upsert({
      user_id: user.id,
      account_key: slot.account_key,
      slot: slot.slot,
      label: slot.label,
      email: parsed.data.email ?? null,
      member_id: parsed.data.member_id ?? null,
      workspace_id: parsed.data.workspace_id ?? null,
      workspace_name: parsed.data.workspace_name ?? null,
      plan_type: parsed.data.plan_type ?? null,
      status: "needs_sign_in",
    }, { onConflict: "user_id,account_key" })
    .select("account_key, slot, label, email, member_id, workspace_id, workspace_name, plan_type, verified, status, device_id, last_seen_at")
    .single();
  if (error) return NextResponse.json({ error: "db", message: error.message }, { status: 500 });
  return NextResponse.json({
    account: {
      account_key: data.account_key,
      slot: data.slot,
      label: data.label,
      email: data.email,
      member_id: data.member_id,
      workspace_id: data.workspace_id,
      workspace_name: data.workspace_name,
      plan_type: data.plan_type,
      connected: data.status === "connected",
      verified: data.verified,
      status: data.status,
      device_id: data.device_id,
      last_seen_at: data.last_seen_at,
    } satisfies CodexAccountMetadata,
  });
}
