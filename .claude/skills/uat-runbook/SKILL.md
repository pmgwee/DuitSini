---
name: uat-runbook
description: Generate a setup + UAT runbook in the house format (TL;DR → Decision & Why → Prerequisites → Localhost UAT with TC tables → Production → Troubleshooting → Appendix), optionally published to Notion. Use for EVERY human-facing testing or setup document — phase testing guides, deploy verification steps, manual setup instructions (Telegram bots, webhooks, env vars, cron), or when the user says "写 testing guide", "UAT", "how do I test/deploy this". Never write an ad-hoc testing doc in any other format; phase-autopilot also invokes this automatically at every phase close.
---

# UAT Runbook — the house format

One format, every time, so the user can follow any runbook top-to-bottom
without re-learning its shape. The canonical reference is the Telegram
Reminder Integration runbook (Notion, 2026-07); `references/TEMPLATE.md` is
its skeleton — fill every `{{...}}`, delete optional blocks you don't need,
never invent new section types.

## Inputs — gather first, never invent

- The charter's Manual-prereq registry + DoD list for the phase.
- Every brief's UAT NOTES and MANUAL PREREQS (`handoff/NN-*.md`).
- STATE.md — what the autopilot already verified (with dates), and every
  failure actually hit (they seed Troubleshooting).
- **The real code** — routes, env var names, commands. Read them; a runbook
  command that 404s costs the user an evening and their trust in the doc.

## The eight writing rules

1. **TL;DR first**, as a callout: test order (localhost first, then prod),
   what is already verified green ✅ with the date, any blocker found & fixed
   during pre-flight, and the gate ("do NOT push until Phase 1 passes").
2. **Human-only filter.** A step appears only if a human must perform it —
   create a bot, paste a secret, click deploy, judge a UI. Everything the
   autopilot already proved compresses into the TL;DR's ✅ line. No filler
   tests, no re-testing what a machine already demonstrated.
3. **One step = one action + one ✅ Expected.** Numbered, checkboxed,
   followable by a non-technical reader with zero unstated context.
4. **Explain the why when a value matters** — "trial end = today + 3 days
   because reminder offsets are 7/3/1, so the 3-day reminder fires today."
   A reader who knows why can self-correct; one who doesn't just stalls.
5. **Copy-paste exactness.** Real env var names in a table, real routes,
   runnable commands; secrets as `<PLACEHOLDER>`. Windows note where curl
   appears: use `curl.exe` in PowerShell, not `curl`.
6. **TC tables** — `| # | Test | Command / action | Expected |` — numbered
   TC-01… continuously across localhost → production (never restart the
   numbering), each independently checkable, with a checkbox tracker line
   under every table so progress survives a coffee break.
7. **Localhost-first structure.** Prod-only flows get a local simulation
   step (e.g. replaying a webhook with one curl) plus the real check on
   prod — the user iterates in seconds locally, then confirms once live.
8. **Troubleshooting is earned, not imagined**: a Symptom | Cause → Fix
   table built from failures actually hit during the phase (STATE.md), plus
   the obvious env-missing cases. Appendix holds one-time SQL/backfills,
   a sample of what the feature's output looks like, and security notes.

## Who writes what (quota-aware split)

- **Inside a handoff plan:** the **executor** (GLM) drafts the runbook as
  the plan's second-to-last brief — it fills `TEMPLATE.md` from the inputs
  above; drafting is diligent assembly, not judgment. The **orchestrator
  (top-tier)** then verifies at phase close: check every command, route,
  and env-var name against the real code line by line (the drafter may
  hallucinate; the verifier may not), tighten wording per the eight rules,
  and publish to Notion — MCP connectors exist only on the desktop side,
  so publishing is always the orchestrator's job.
- **Standalone invocation** (no plan, user asks directly): do all of it
  yourself in this session.

## Produce

1. Read `references/TEMPLATE.md`; fill it per the rules above.
2. Write to `docs/runbooks/<phase-slug>-runbook.md` (docs/ is gitignored —
   local by the owner's choice).
3. **Notion** (when the Notion MCP is connected): create the page mirroring
   the structure — callouts for TL;DR/tips/warnings, tables as tables,
   checklists as to-dos; title `<emoji> <Phase name> — UAT Runbook`. First
   time: ask which parent page to file it under and record the answer in
   the charter; afterwards reuse it. Report the page URL.
4. **Master runbook** (project end, or on request): merge all phase
   runbooks — deduplicate prerequisites into one env table, one combined
   go-live checklist, and a TC index by phase. Same template, one level up.
