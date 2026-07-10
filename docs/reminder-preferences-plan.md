# Global Reminder Preferences + Quiet Presets (Implementation Plan)

> **Audience:** the implementing model (Sonnet 5). This is a *plan* written by the
> advisor pass — none of this feature's code has been written yet. Read CLAUDE.md
> first; its conventions (repo switch via `getSubscriptionRepository()`, civil
> dates, RLS vs service-role split, no test runner → `pnpm typecheck`) all apply.
>
> **Standing user constraint: do NOT commit any work.** Leave everything in the
> working tree. The user commits manually.

---

## 1. What we're building (product decision, already made)

One **"Reminder schedule" card on the Settings page** that controls reminder
timing for **ALL** of the user's subscriptions (active + trial) in one place:

```
┌─ ⏰ Reminder schedule ────────────────────────────────┐
│  How often should we remind you before each charge?   │
│                                                        │
│  [ Standard ]  [ Minimal ]        ← preset chips       │
│                                                        │
│  ☑ 7 days before   ☑ 3 days before   ☑ 1 day before   │
│                                                        │
│  You'll get one morning digest on each reminder day.  │
└────────────────────────────────────────────────────────┘
```

- **Preset chips are shortcuts, not state**: *Standard* ticks {7,3,1};
  *Minimal* ticks {1} (the "quiet mode" — research says the 1-day reminder is
  the one that actually prevents surprise charges). Any hand-made combination
  simply means neither chip is highlighted (implicit "Custom" — do NOT render a
  third chip; the checkboxes themselves are the custom UI).
- **At least one box must stay ticked.** Unticking the last box is blocked in
  the UI (the checkbox is disabled when it's the only one left) AND rejected by
  the API (min 1). "No reminders at all" is what the existing *Reminders on/off*
  toggle is for — two different intents, two different controls.
- **Per-sub overrides global; `NULL` per-sub = "use my default".** The global
  card sets the DEFAULT schedule; each subscription's own `reminder_offsets_days`
  wins where set, and `NULL` inherits the global. *(DECIDED — supersedes this
  plan's original "global overrides per-sub" premise, which assumed per-sub
  offsets had no UI. A backfill nulls rows still on the old `{7,3,1}` default; the
  form has a "Use my default" reset so NULL is a state users can return to.)*

## 2. Current state (verified 2026-07-10 against live DB + working tree)

| Fact | Detail |
| --- | --- |
| Digest cron is LIVE in the tree | `app/api/cron/reminders/route.ts` bundles all of a user's due reminders into ONE message per due-date (`deliverDigest`, dedupe key `${userId}:telegram:digest:${dueISO}`); `buildDigestMessage` in `lib/notify/messages.ts`; deliveries list renders digest rows. **Build on this — do not resurrect per-reminder sends.** |
| Cron schedule | `vercel.json` → `0 2 * * *` (10:00 MYT). Not touched by this feature. |
| `user_profiles` columns (live) | user_id, full_name, timezone, preferred_currency, theme, telegram_chat_id, telegram_enabled, whatsapp_*, monthly/yearly_report_enabled, created_at, updated_at — **NO offsets column** (verified via information_schema 2026-07-10). Migration required. |
| Per-sub offsets | `subscriptions.reminder_offsets_days int[] default '{7,3,1}'` exists **and is now USER-EDITABLE**: `features/subscriptions/subscription-form.tsx` has a "Remind me" chip editor (Enhancement #3), defaulting trials to `[3,1,0]` and renewals to `[7,3,1]`. Rows are **no longer guaranteed to hold the default.** ⚠️ This contradicts this plan's original premise (§1 / D2) that per-sub offsets had no UI and could be safely overridden by a global setting — see the **Precedence decision** note below. |
| Engine | `lib/reminders/engine.ts` `deriveDueReminders(subs, todayISO)` is pure and reads `sub.reminderOffsetsDays`. **Keep it pure — override at the call site, not inside.** |
| Settings page | `app/(app)/settings/page.tsx` (server component) already reads the profile + deliveries and passes initial state to client cards — mirror that pattern. |
| CSRF/auth pattern | `app/api/integrations/telegram/toggle/route.ts` is the exact template: session-authed POST + `Sec-Fetch-Site` guard + zod body + `user_profiles` upsert. |

## 3. Architecture decisions

### D1 — Storage: ONE new column, no preset column
`user_profiles.reminder_offsets_days int[] NOT NULL DEFAULT '{7,3,1}'`.
The preset is **derived** ({7,3,1} → Standard highlighted; {1} → Minimal
highlighted; anything else → no chip highlighted), never stored — storing both
would create two sources of truth that can disagree. Same name as the per-sub
column on purpose: same meaning, different scope.

Migration `supabase/migrations/0010_global_reminder_prefs.sql` (applied):
```sql
alter table public.user_profiles
  add column if not exists reminder_offsets_days int[] not null default '{7,3,1}';
alter table public.subscriptions alter column reminder_offsets_days drop default;
alter table public.subscriptions alter column reminder_offsets_days drop not null;
-- Backfill: rows still on the old '{7,3,1}' default were never deliberately
-- chosen → NULL (inherit the global). Trial '{3,1,0}' + real customs are KEPT.
update public.subscriptions set reminder_offsets_days = null where reminder_offsets_days = '{7,3,1}';
```
Then regenerate `lib/supabase/types.ts` (manually or via `generate_typescript_types`).

### D2 — Precedence: per-sub overrides global; NULL = inherit (DECIDED)
In the cron route, include `reminder_offsets_days` in the existing profiles
select. Before calling the engine, resolve each sub: a sub with its own offsets
uses them; a sub with `NULL` inherits the global default.
```ts
const globalOffsets = sanitizeOffsets(p.reminder_offsets_days); // see D3
const effective = subs.map((s) => ({
  ...s,
  reminderOffsetsDays: s.reminderOffsetsDays == null ? globalOffsets : s.reminderOffsetsDays,
}));
const reminders = deriveDueReminders(effective, todayISO);
```
The engine stays pure and untouched. `sanitizeOffsets` lives in
`lib/reminders/engine.ts` (exported, pure): keep ints 0–60, dedupe, sort desc;
if the result is empty (corrupt/legacy row) fall back to `[7, 3, 1]`
(`DEFAULT_REMINDER_OFFSETS` from `lib/constants.ts`) — the sweep must never
silently go mute because of bad data.

### D3 — API: `POST /api/settings/reminders`
New route `app/api/settings/reminders/route.ts`, cloned from the toggle route's
skeleton (session auth via `createSupabaseServerClient`, `crossSiteBlocked`
Sec-Fetch-Site guard, zod body, upsert, structured JSON):
- Body schema: `{ offsets: z.array(z.number().int().min(0).max(60)).min(1).max(10) }`
  — **min(1) enforces the "at least one" rule server-side**.
- Normalize before writing: dedupe + sort desc (canonical form keeps preset
  detection trivial on read).
- Upsert `user_profiles.reminder_offsets_days` + `updated_at` for the signed-in
  user (RLS-scoped client — no service role here).
- The UI only offers {7,3,1} checkboxes today, but the schema accepts any valid
  offsets so a future "custom days" input needs no API change.

### D4 — UI: `features/settings/reminder-schedule-card.tsx` (client)
Mirror `telegram-card.tsx`'s conventions exactly (state + flash pattern,
`Button`, `cn`, section/card classes):
- Props: `{ initialOffsets: number[] }` from the server page.
- Two preset chips (`Standard`, `Minimal`) — small pill buttons; highlighted
  (primary style) when the current set equals the preset exactly. Clicking one
  sets the checkbox state AND saves immediately.
- Three checkboxes: 7 / 3 / 1 days before. Toggling saves immediately
  (optimistic: update state → POST → revert + error flash on failure). Disable
  a ticked checkbox when it is the last one ticked (tooltip/hint: "Keep at
  least one — use the Reminders toggle to turn everything off").
- One summary line under the checkboxes, e.g. "You'll be reminded **7, 3 and
  1 days** before each charge, bundled into one morning digest." — regenerate
  from state so it always matches.
- Note under the card when Telegram isn't connected yet: preferences still
  save; they take effect once connected (do NOT disable the card).
- Checkboxes: native `<input type="checkbox">` styled with Tailwind (no new
  dependency; there is no checkbox primitive in `components/ui/`).

### D5 — Settings page wiring
In `app/(app)/settings/page.tsx`: extend the existing profile select with
`reminder_offsets_days`, default to `[7,3,1]` when null/absent (mock mode /
fresh profile), render `<ReminderScheduleCard initialOffsets={...} />` between
the Telegram card and Recent reminders. Update `loading.tsx` with a matching
skeleton block.

### D6 — What this feature does NOT touch
The digest logic, dedupe keys, retry logic, message wording, cron schedule,
Telegram routes, and the pure engine internals. The per-sub
`reminder_offsets_days` column and its validation stay as-is (future per-sub
override = Phase C; out of scope). WhatsApp untouched.

## 4. Execution order (tasks for the implementer)

Work top-to-bottom; each task ends with `pnpm typecheck` green. **No commits.**

| # | Task | Files | Acceptance |
| --- | --- | --- | --- |
| 1 | Migration + types | `supabase/migrations/0010_user_reminder_offsets.sql`; apply via MCP `apply_migration`; regen `lib/supabase/types.ts` via `generate_typescript_types` | live column exists with default `{7,3,1}`; types compile |
| 2 | `sanitizeOffsets` helper (pure, exported) | `lib/reminders/engine.ts` | ints 0–60 only, dedupe, sort desc, empty→`DEFAULT_REMINDER_OFFSETS` fallback |
| 3 | Sweep honors global offsets | `app/api/cron/reminders/route.ts` | profiles select includes the column; subs mapped per D2 before `deriveDueReminders`; dry-run reflects the override |
| 4 | Prefs API route | `app/api/settings/reminders/route.ts` | 401 unauthenticated; 403 cross-site; 400 on empty/invalid offsets; canonicalizes + upserts; returns `{ok:true, offsets}` |
| 5 | Reminder schedule card | `features/settings/reminder-schedule-card.tsx` | presets + checkboxes + last-box guard + optimistic save + summary line per D4 |
| 6 | Page wiring + skeleton | `app/(app)/settings/page.tsx`, `app/(app)/settings/loading.tsx` | card renders with server-loaded offsets; graceful `[7,3,1]` default in mock mode |
| 7 | Docs touch-up | `docs/phase-3-user-testing-guide.md` (add a short "choose your reminder schedule" note in Part B/C) | guide mentions the new card |

## 5. Tools the implementer should use

- Supabase MCP: `apply_migration`, `generate_typescript_types`, `execute_sql`
  (verify the column after applying). Project `ldsxmigqfgfcisweqckk`.
- `pnpm typecheck` after every task; `pnpm build` once at the end.
- No new env vars, no new dependencies.

## 6. Verification checklist (definition of done)

1. `pnpm typecheck` + `pnpm build` pass.
2. API: unauthenticated POST → 401; `{offsets:[]}` → 400; `{offsets:[1,1,3]}` →
   saved as `[3,1]` and echoed canonicalized.
3. Settings card: clicking **Minimal** ticks only "1 day", persists across a
   refresh; unticking down to one box blocks the last untick.
4. Sweep honors it: with the test user set to `[1]`, a sub renewing in 3 days
   derives NOTHING in `?dry=1`; set back to `[7,3,1]` → the 3-day reminder
   derives again. (Reuse the Layer-2 seed from `docs/phase-3-testing-guide.md`.)
5. Legacy safety: a profile row predating the migration (null → default) and a
   mock-mode render both behave as `[7,3,1]` with no crash.
6. Digest unaffected: multiple due reminders still arrive as ONE message.
