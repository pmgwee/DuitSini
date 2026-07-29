# DuitSini — UI Elevation Plan

> Take the dashboard from "works" to **Awwwards / Linear / Vercel-tier premium**: clean visual hierarchy, ONE premium motion language, free community components where they earn their place.
>
> **Hard rule:** data-dense surfaces stay fast and readable. The "wow" vocabulary (shader backgrounds, magnetic buttons, kinetic type, scroll-scrub) is reserved for **non-data surfaces** — login, empty states, onboarding, an optional marketing strip. The dashboard itself follows the *functional* gold standard (Stripe / Vercel / Linear / Mercury), not the *portfolio* standard (Awwwards).

**Target:** `subscription-agent` (DuitSini) — Next.js 15 App Router · React 19 · Tailwind v4 · shadcn-style `components/ui` · **framer-motion v12 (installed, used on 1/5 surfaces)** · recharts · next-themes (dark-first).

**Sources:** 10-agent audit + research workflow + 3 targeted toolbox agents (React Bits/21st, Spline/Unicorn, MotionSites/Awwwards/Space-Type). All recommendations are evidence-based with `file:line`.

---

## 0. Diagnosis — what's actually wrong

| # | Finding | Evidence |
|---|---|---|
| 1 | **framer-motion is installed but used on only 1 of 5 surfaces** (Stocks). AI Usage, Bills, Reports, Settings + the entire shared layer (Button/Card/Dialog/Select/AppShell) are **static**. | `package.json` → `framer-motion ^12.42.2`; imports only in `features/serenity/*` (19 hits). Grep across `features/{dashboard,subscriptions,reports,settings}` + `components/ui` → 0. |
| 2 | **No page has a hero KPI.** The one number each page exists for is the same size as siblings, lacks `tabular-nums` (jitters on refresh), never count-ups. | AI Usage: clock is hero, utilization % is `text-sm` (`ai-usage/page.tsx:16-18`, `claude-usage-tracker.tsx:306`). Bills: no money hero (`bills/page.tsx:26-35`). Reports: hero total missing tabular-nums + no count-up (`reports/[periodKey]/page.tsx:237`). Settings: flat equal stack. |
| 3 | **Overlays hard-cut.** Dialog, Select, UserMenu, tab panels swap with no transition. | `components/ui/dialog.tsx:140-180` (early-returns null → no exit anim possible without restructure), `select.tsx`, `subscriptions-view.tsx:80-89`. |
| 4 | **Button press = 1.5% CSS squish**, no hover lift, no spring. | `components/ui/button.tsx:9` (`active:scale-[0.985]`). |
| 5 | **Duplicated recipes / radius drift.** ~20 hand-rolled card class strings; 6 different radii on Bills alone. | `card.tsx:8` vs `telegram-card.tsx:92`, `subscription-statistics.tsx:220/196/307`. |
| 6 | **Dev/admin content mixed into user cards; placeholder scaffolding left in.** | `telegram-card.tsx:151-164` (curl/env in user card); `app-shell.tsx:69-72` ("Beta Versions 0.1" card). |
| 7 | **Copy bugs on a finance page** (erode trust). | Reports yearly caption says "this month" (`[periodKey]/page.tsx:46`); "charges" tile counts months (`:435`). |
| 8 | **Stocks is the only route without `loading.tsx`** (force-dynamic + blocking fetches → blank screen on slow nets). | absent; template exists at `reports/loading.tsx:7-37`. |

**One-liner:** the Stocks page already feels premium *because it has motion* — everything else doesn't, and no page leads with its hero number. Fix those two things and the whole app lifts.

---

## 1. Principles (govern every choice)

- **Two motion budgets.** Marketing/login/onboarding = HIGH (expo-out 0.16,1,0.3,1; 500-900ms; magnets; shaders; kinetic type). **Dashboard = RESTRAINT** (Material `cubic-bezier(0.4,0,0.2,1)`; 120-250ms; no scroll-jacking; no WebGL behind data; charts animate on first-load + data-change only). (Vercel/Linear/Stripe.)
- **Restraint wins.** One accent (DuitSini's existing **violet** `--primary`), hairline borders by default, shadows only on interaction, `tabular-nums` on every figure.
- **Hero = the psychologically motivating number**, top-left. Mercury = balance + trend; Ramp = savings. Max 4 KPI cards above the fold.
- **One spring language.** Baseline `stiffness:380, damping:30, mass:0.8` via `<MotionConfig reducedMotion="user">`.
- **One primary action per surface.** Secondary actions → ghost/icon or a menu.
- **Atmosphere, not pure black.** Already OKLCH `0.155` (~#16161c). Add a subtle **SVG grain overlay (~2%)** — the single cheapest "premium" upgrade; kills the flat-plastic feel without runtime cost.
- **Loading = per-card skeleton, never a full-page spinner.** Every live panel shows "Updated X ago."

---

## 2. Phase 0 — Motion & design-system foundation  *(prerequisite · zero-risk · ~1 session)*

All additive — no behavior change, no removed features. Unblocks every page.

| # | Change | File(s) |
|---|---|---|
| 0.1 | **`lib/motion.ts`** — spring presets (`spring`, `springGentle`, `springPop`, `tweenStandard`) + reusable `<Reveal>`, `<Stagger>`, variants. Extracts the serenity pattern so every page reuses it instead of hand-rolling. | new `lib/motion.ts` |
| 0.2 | **Wrap app in `<MotionConfig reducedMotion="user" transition={spring}>`.** One spring feel app-wide; auto-respects prefers-reduced-motion. | `app/providers.tsx` |
| 0.3 | **Motion + atmosphere tokens in `globals.css`** — `--dur-fast/base/slow` (`120/200/300ms`), `--ease-out` (`cubic-bezier(0.4,0,0.2,1)`), `--ease-expo` (marketing only); SVG grain overlay utility (`.grain`); reduced-motion guard for view-transitions. | `app/globals.css` |
| 0.4 | **`<CountUp>` primitive** for currency/numbers. Default: free `useMotionValue + animate()`; **recommend adopting `@number-flow/react` (MIT)** for clean MYR formatting + directional tweening. Used on every hero/KPI. | new `components/ui/count-up.tsx` (+ `pnpm add @number-flow/react`) |
| 0.5 | **`<Surface variant="flat\|glass\|elevated">` + `<SectionHeader icon title action>`** — collapse ~20 duplicated card/header class strings; lock one padding token + heading ladder. | new `components/ui/surface.tsx`, `section-header.tsx` |
| 0.6 | **`tabular-nums` sweep** — every RM figure, token/cost count, axis label, badge. Zero risk; stops digit jitter. | all `features/**` numeric displays |
| 0.7 | **Button press feel** — replace `active:scale-[0.985]` with `whileTap` spring (~0.96) + subtle hover lift. | `components/ui/button.tsx:9` |
| 0.8 | **Animate Dialog** (mobile slide-up `y:100%→0` + backdrop fade; desktop scale `0.96→1`) — requires restructuring the early-`return null` into an `AnimatePresence` so exit runs. **Highest perceived-quality jump** (every Add/Edit flow passes through it). Same treatment for Select listbox + UserMenu. | `components/ui/dialog.tsx`, `select.tsx`, `components/layout/user-menu.tsx` |

**Verify after Phase 0:** `pnpm typecheck` + `pnpm dev` (load each route, toggle a Dialog, toggle theme, tab through with keyboard, check `prefers-reduced-motion` in DevTools).

---

## 3. Phase 1 — Per-page hero + motion  *(highest impact)*

Each page: (a) one hero KPI w/ count-up + tabular-nums, (b) staggered `<Reveal>` section entrances, (c) chart enter animations, (d) the page-specific fixes below. Dashboard easing only.

### AI Usage *(worst hierarchy — do first)*
- **Demote FlipClock** to a slim date/time strip; promote **utilization %** to hero with count-up + animated ProgressRing draw-in. (`page.tsx:16-18`, `claude-usage-tracker.tsx:306,605-619`)
- **Restore the commented-out `PageHeader`** — there is currently no `<h1>`. (`page.tsx:10-13`)
- **Collapse ConnectClaudeCard wall-of-text** into one-line CTA; expand on click. (`connect-claude-card.tsx:93-153`)
- Stagger gauge grid; `AnimatePresence` on Live/Manual swap; dedupe the three "Live" badges → one. (`claude-usage-tracker.tsx:54-58,88-99,248-252`)

### Stocks *(has motion — fix hierarchy + add loading)*
- **Add `loading.tsx`** (only route missing one). (`reports/loading.tsx:7-37` as template)
- **Promote conviction-weighted return to hero**; HoldingsRing first, not the marketing banner. (`holdings-ring.tsx:91-105`)
- **Demote "Be greedy" banner**; stop misusing `border-danger/30` (cry-wolf vs the real unavailable state). (`opportunity-section.tsx:150,162`)
- Animate ring arcs draw-in (staggered ~40ms); `AnimatePresence` on ring-center swap; stagger the 5 sections instead of unison. (`holdings-ring.tsx:77-80,119-138,140-155`)

### Bills
- **Promote "Spent this month (MYR)" to real hero** (text-4xl/5xl, count-up, tabular-nums) above tabs. (`page.tsx:26-35`)
- **Sliding tab pill** via `layoutId`; `AnimatePresence` on Calendar/All/Statistics swap. (`subscriptions-view.tsx:80-89`)
- **Count-up** 4 StatCards + dock totals. (`subscription-statistics.tsx:118-144,313`; `category-dock.tsx`)
- Animate Dialog (bottom-sheet slide-up); stagger calendar cells (by row) + subscription rows.
- **Collapse 6 radii → 2** (rounded-2xl cards, rounded-full pills); pick ONE money framing per row (drop "≈ MYR/charge"). (`subscription-statistics.tsx:220/196/307`; `subscription-list.tsx:150-176`)

### Reports
- **Hero MYR total**: tabular-nums + count-up. (`[periodKey]/page.tsx:237`)
- **Re-enable chart enter**: `isAnimationActive` is explicitly `false` on the category donut — flip it (or motion-draw). Animate the 12 "Monthly spend" bars (staggered grow). (`report-category-chart.tsx:58`; `[periodKey]/page.tsx:442-459`)
- Bump StatTile values + tabular-nums; elevate hero card (`glass card-elevated`).
- **Fix 2 copy bugs**: yearly caption "this month"→"this year"; "charges" tile label. (`[periodKey]/page.tsx:46,435`)

### Settings
- **Promote Telegram connection to a hero banner** (gating status — currently a tiny corner badge). (`telegram-card.tsx:97-107`)
- **Move admin `<details>` (curl/env/webhook) out** into a demoted "Advanced" section. (`telegram-card.tsx:151-164`)
- Stagger 4 sections; replace 3 blink-on/off flash `<p>`s with one `AnimatePresence` inline-notification; springs on the report toggle + preset chips.
- Drop the double-wrapped Recent reminders card.

---

## 4. Phase 2 — Premium components & effects  *(your toolbox, by surface)*

**License discipline:** MIT sources only as deps — `@number-flow/react`, `cmdk`, `sonner`, `vaul`, MagicUI, shadcn registry, Tremor copy-paste. **React Bits** = MIT + Commons Clause (fine inside DuitSini; don't redistribute). **21st.dev** = per-component license — verify before ship; ~2 free copies/day on free tier. **Exclude Park UI** (Ark UI + Panda CSS conflicts with Tailwind v4).

### 4a. Dashboard interior (subtle · performant · OK behind data)
- **React Bits:** `Counter`/`CountUp` (KPIs), `SpotlightCard` (top KPI row — ≤6 cards), `StarBorder`/`BorderGlow` (one AI-CTA only), `TextType` (AI input placeholder), `ShinyText` (section headings), `AnimatedContent` (tab transitions), `ScrollReveal` (settings).
- **21st.dev:** Sean Hello **Data Grid Table** (transactions, 9 variants), Origin UI **TanStack Table** (AI-usage log), **Astryx App Shell** (chrome reference), Ephraim Duncan **Stats** (KPI row), shadcn **Command** (Cmd+K).
- **npm:** `@number-flow/react` (animated currency), `cmdk` (Cmd+K palette), `sonner` (toasts), `vaul` (mobile sheets) — all MIT, shadcn-compatible.

### 4b. Non-data surfaces only (login · empty states · optional marketing strip)
- **React Bits backgrounds:** `Aurora` or `Threads` (login), `Waves`/`Particles` (empty states). *(If a public marketing page ever exists: `Ferrofluid`/`LiquidChrome` — strictly one per page, lazy-loaded, paused off-screen, skipped on reduced-motion + mobile.)*
- **Optional `unicornstudio-react` on login only** — fps cap 24-30, `visibilitychange`→`destroy()`, reduced-motion skip, mobile skip. Commercial use = Legend tier (~$168/yr).
- **Premium feel at near-zero cost (the 80/20 — recommended over WebGL everywhere):** SVG grain overlay (`feTurbulence`, 2% dashboard / 4-6% marketing), CSS mesh gradients (Magic Pattern / Learn UI), **Lottie** empty/success states (8finance's approach — cheap, pausable, reduced-motion-safe).
- **Kinetic type (Space Type Generator):** `SHINE` (one-shot sheen on a login hero number) + `LAYERS` (login headline) only. Avoid `CRASH/POW/FLASH/DANGER/CLUTTER`. For in-app KPIs use framer-motion count-up, NOT kinetic type. ("Less rotation, fewer colors, slower motion, tighter crop.")

### 4c. Spline — verdict
~549 kB gzip runtime + free-tier watermark + commercial self-host needs Professional tier. **Login/register only**, `"use client"` + `next/dynamic ssr:false`. Skip for v1; revisit only if login needs a 3D moment.

---

## 5. Phase 3 — Polish
- **Route transitions:** `app/template.tsx` (framer-motion enter fade) and/or `experimental.viewTransition` + directional nav slides. Complements the existing route progress bar.
- **Mobile header:** add a page title (currently just the "DuitSini" wordmark). (`app-shell.tsx:97-106`)
- **Remove dead "Beta Versions 0.1" sidebar card** (or wire to real release info). (`app-shell.tsx:69-72`)
- **Unify focus-ring** to one `focus-ring` utility (replace ring/60, ring/50 drift).
- **Per-card "Updated X ago" staleness** on live panels (AI Usage, synced data).
- **Active-state parity** between desktop sidebar (filled pill) and mobile bottom-nav (text only). (`app-shell.tsx:148-149,181`)

---

## 6. What I will NOT do (restraint)
- ❌ No shader/WebGL backgrounds behind tables, charts, KPIs, lists, settings.
- ❌ No cursor-FX (BlobCursor/SplashCursor/ImageTrail), no Lenis smooth-scroll, no scroll-scrub inside the dashboard.
- ❌ No `expo-out` easings or 500ms+ transitions on dashboard surfaces (those are marketing-only).
- ❌ No Aceternity/React-Bits components copied into a shared/public kit (license).
- ❌ No bouncing springs on layout properties; no full-page loading spinners.

---

## 7. Suggested order & effort
1. **Phase 0** (foundation) — one session, zero-risk, unblocks everything. **← start here**
2. **AI Usage + Bills** (highest-impact hierarchy fixes; most-used pages).
3. **Reports + Settings** (cleanup + motion; incl. the copy-bug fixes).
4. **Stocks** (already good — hierarchy + `loading.tsx` polish).
5. **Phase 2** community components — adopt where they earn their place (tables, Cmd+K, login hero, SVG grain).
6. **Phase 3** polish.

---

## 8. References (verified)
- **Motion:** motion.dev docs; transitions.dev (pattern vocabulary); Vercel react-view-transitions-demo; GSAP hover-effects (cubic-bezier values).
- **Functional-dashboard gold standard:** Stripe Dashboard · Vercel Dashboard (2025-26 redesign + Web Interface Guidelines) · Mercury · Linear.
- **Design systems:** Linear DESIGN.md; IBM Carbon data-viz; Geist; Apple HIG.
- **Components:** shadcn/ui blocks & charts; Tremor; MagicUI; @number-flow/react; cmdk; sonner; vaul; Origin UI.
- **Toolbox (yours):** React Bits (reactbits.dev) · 21st.dev · Spline · Unicorn Studio · Space Type Generator · Awwwards (Elva SOTD'26, Igloo SOTY'24, Messenger SOTY'25) · MotionSites.
- **Feasibility:** Spline ~549 kB gzip + watermark (login only); Unicorn 38 kB + non-commercial free tier; CSS/SVG grain + mesh gradients = premium-cost winner.
