# {{EMOJI}} {{Feature / Phase name}} — UAT Runbook

> **TL;DR — Test on localhost FIRST, then push to {{prod platform}}.**
> {{One sentence: what is fully testable locally and what needs prod.}}
> {{Already verified green ✅ (build/lint/types/autopilot browser pass) + date.}}
> Do NOT push until Phase 1 below passes.

{{OPTIONAL blocker callout:}}
> ⚠️ **Blocker found & fixed during pre-flight:** {{what silently broke, what
> the fix was, and the one-time backfill (link to Appendix) if any.}}

---

# 🎯 Decision & Why

1. **Localhost first** — {{why: iterate in seconds, real DB, real side
   effects from your machine; what can't reach localhost and how we simulate
   it locally}}.
2. **Push second** — {{what shipping takes: commit + push, N env vars, the
   one-time external command, then re-run the same TCs against prod}}.

---

# 🧰 Prerequisites ({{X}} minutes, one time)

- [ ] **{{Create the external thing}}** — {{exact clicks/commands, where the
      credential appears, what to copy}}.
- [ ] **Generate {{N}} secrets** — run {{N}} times:

```
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

- [ ] **Fill `.env.local`** (never commit this file):

| Variable | Value |
|---|---|
| `{{VAR}}` | {{source / "(existing)"}} |

- [ ] Restart the dev server: `pnpm dev`

> 💡 On Windows PowerShell, always use `curl.exe` (not `curl`, which aliases
> Invoke-WebRequest and breaks `-H` headers).

---

# 🖥️ Phase 1 — Localhost UAT

## Step A · {{One-time local wiring}}

1. {{One action}}. *({{expected quirk and why it's fine, if any}})*
2. {{One action, exact command in a fenced block if runnable}}.

✅ **Expected:** {{the single observable result that proves Step A}}.

> ⏱️ {{Timing/expiry note if a code or token is involved.}}

## Step B · Create the test data (in the UI)

| Field | Value |
|---|---|
| {{Field}} | {{value}} |

Why {{the key value}}: {{the reason this exact value makes today's test
fire — e.g. offsets 7/3/1 → trial end today+3}}.

## Step C · Test cases

| # | Test | Command / action | Expected |
|---|---|---|---|
| TC-01 | {{Auth guard}} | `{{command}}` | {{status + body}} |
| TC-02 | {{Dry run}} | `{{command}}` | {{fields that must appear; nothing sent/written}} |
| TC-03 | 🔥 {{Real action}} | {{command/action}} | {{the real-world side effect arrives}} |

- [ ] TC-01 · - [ ] TC-02 · - [ ] TC-03

---

# 🚀 Phase 2 — {{Prod platform}} (production)

## Step 1 · Ship
- [ ] Commit + push (you do this manually). {{What auto-deploys / registers.}}

## Step 2 · Environment variables ({{where exactly}}, **Production**)
- [ ] {{VARS list}}. **Redeploy** after adding.

> 💡 {{Platform behavior worth knowing — e.g. CRON_SECRET auto-attached.}}

## Step 3 · {{One-time external pointing command}}

```
{{command with <PLACEHOLDERS>}}
```

Verify: `{{verification command}}` → {{expected}}.

> ⚠️ {{What stops working locally after this, and why that's fine.}}

## Step 4 · Production test cases

| # | Test | Expected |
|---|---|---|
| TC-{{next}} | {{Real end-to-end flow, no simulation this time}} | {{expected}} |
| TC-{{next}} | Repeat TC-01..03 against `https://{{app}}` | Same results as localhost |
| TC-{{next}} | Scheduled run | {{when it fires, where to see the log}} |

- [ ] TC-{{n}} · - [ ] TC-{{n}} · - [ ] TC-{{n}}

> ⏰ {{Plan-tier timing caveat if any (e.g. Hobby cron fires within the hour).}}

---

# 🧯 Troubleshooting

| Symptom | Cause → Fix |
|---|---|
| {{exact error/status}} | {{cause}} → {{fix}} |
| {{observable misbehavior}} | {{cause}} → {{fix or Appendix link}} |

---

# 📎 Appendix

**{{One-time SQL / backfill}}** (run once in {{where}}):

```sql
{{sql}}
```

**What the {{output/message}} looks like:** {{one-line description of the
real artifact so the tester recognizes success}}.

**Security notes 🔐**
- {{secret-handling rule}}
- {{auth-gate summary: what blocks unauthenticated access}}
- {{multi-tenant guarantee: why other users can't be affected}}
