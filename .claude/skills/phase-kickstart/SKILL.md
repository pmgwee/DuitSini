---
name: phase-kickstart
description: Turn business requirements into an interrogated project charter and a self-executing handoff plan. Use at every project or phase start — whenever the user provides requirements, rubrics, success criteria, or a feature list; says "kickstart", "开始 phase N", "plan the next phase/feature"; or asks to plan work that cheaper models will implement later or unattended. Also use before ANY first implementation pass on a fresh project — never start coding a new project without running this first. Requires the user present to answer questions; planning runs on the strongest available model.
---

# Phase Kickstart — interrogate, charter, plan

Planner side of the pipeline (adapted from the `handoff` skill in
pinjun99/Sildenafil_coding, MIT). The whole point: **every question that would
otherwise surface as a UAT defect gets asked before the first line of code.**
An unasked question at kickstart is a bug report three days later.

## Roles and stand-down

Planning is top-tier work. If this session is not running the strongest
available model (Fable/Opus class), say so and ask the user to switch before
writing any plan — a mid-tier plan defends itself poorly, and unattended
executors inherit its blind spots. Executors never plan; sessions self-report
their model ID in everything they write.

## Stage 0 — Requirements interrogation (the user must be present)

Read everything provided (requirements docs, rubrics, the repo, prior
charters) **first**, so questions are informed, not lazy. Then interview in
rounds using the question tool: at most 4 questions per round, each with a
recommended option first. Cover every domain below for every phase — a domain
marked "obvious" is where UAT surprises live:

| Domain | You are hunting for |
|---|---|
| Users & devices | who uses this feature, when, on which device (mobile? iPad Safari quirks?) |
| Exact flows | happy path AND: first-run, empty states, error states, slow network, signed-out |
| Data rules | currencies + rounding, dates/timezones (this repo: MYR-home, civil dates), retention, backfill of existing rows |
| UI expectations | reference designs, dark mode, loading skeletons, what "polished" means to the user |
| Integrations | external services; **who creates each account/key/bot — those become Manual-prereq registry entries** |
| Non-functional | perf targets, stress profile (how many rows/users/concurrent), acceptable failure modes |
| Rubric mapping | each rubric line → which phase + which DoD gate will prove it |
| Release | deploy cadence, environments, rollback expectations, who performs UAT |

Exit rule: stop interviewing only when **no remaining answer would change
code**. Record every answer that changes code in the charter's "Decisions
locked at kickstart" section — that's what makes them binding on executors.

Save as you go: update the charter draft after **every** interview round —
an interrupted interview then loses nothing, and re-running phase-kickstart
resumes from the existing draft instead of re-asking answered questions.

## Stage 1 — The charter (`docs/charter/PROJECT-CHARTER.md`)

The stable spec. Phases and briefs are cheap derivatives; the charter changes
reluctantly. Template:

```markdown
# PROJECT CHARTER — <name>
Planner: <exact model ID> · <date>

## Goal / Users / Non-goals
## Requirements digest
<source docs + dates + one-paragraph summaries>

## Decisions locked at kickstart
<every interrogation answer that changes code, as one-liners with the why>

## Phases
| # | Feature | DoD gates (ids) | Manual prereqs | Status |

## Definition of Done — applies to EVERY phase
- Functional: every acceptance line for the phase demonstrably true
- UI: mobile 375px + desktop, dark + light, loading/empty/error states,
  zero console errors on the walked flows
- Domain: money converted per-sub to MYR and rounded once; civil dates via
  parseISODate; no hydration mismatches (SSR "now" passed down)
- Stress: <profile from interrogation — rows, concurrency, slow network>
- Security: RLS scoping verified, secrets server-side only
- Evidence: browser-walk screenshots + verification output in handoff/STATE.md
- Runbook: uat-runbook generated for the phase

## Manual-prereq registry
| Phase | Item | Why human-only | Runbook section |
```

**First-pass rule (why phase 0 exists):** a fresh project's initial scaffold
is planned and gated exactly like any phase — same DoD, same final review.
"Concept-quality first version, production-hardening later" is the expensive
loop this pipeline exists to kill.

## Stage 2 — The handoff plan (`handoff/`)

One plan per phase. Recognition rule: a directory is a handoff plan **iff**
`handoff/00-MANIFEST.md` exists and its first line is `handoff-plan v1`.

Planner protocol:

1. **Make every lock-in decision now** — stack, data model, published
   interfaces, naming, dependencies. Executors never face an architecture
   choice; anything genuinely undecidable today becomes an explicit re-plan
   checkpoint brief (max 2, or the task isn't handoff-shaped).
2. **Slice by feature, never by layer.** Every brief ends with something
   runnable, sized to one executor session, dependency-ordered.
3. **Premises are CHECK/EXPECT command pairs only** — a premise an executor
   can't run is a defect.
4. Brief 01 materializes contract stubs (real, compilable, committed code);
   the second-to-last brief is the **runbook draft** (executor work: fill
   the uat-runbook skill's TEMPLATE from the charter's Manual-prereq
   registry, every brief's UAT NOTES + MANUAL PREREQS, and STATE evidence —
   the orchestrator only verifies and publishes it at phase close); the
   last brief is always the **final review** (top-tier only — the
   phase-autopilot skill runs it in-session).
5. Confidence horizon: if you couldn't write the last brief today with the
   same confidence as the first, plan only the tranche you can see and end it
   with a re-plan checkpoint brief.

`00-MANIFEST.md` contains: first line `handoff-plan v1`; goal; planner model
ID; `PLAN REVISION: <int>`; architecture decisions; the **plan-wide regression
command** (this repo: `pnpm typecheck && pnpm build`); the brief ledger — one
row per brief: number, name, deps, status ∈ {pending, in-progress, paused,
done, blocked, deviation}, code-commit SHA; and a single **`NEXT:`** line —
the only line anyone has to read to resume.

`CONTRACTS.md`: index of stub files + genuinely non-compilable seams (error
conventions, endpoint semantics). Authoritative over any quote inside a brief.

`STATE.md`: append-only execution journal (executors write it; see the
phase-autopilot skill's EXECUTOR-PROTOCOL reference).

### Brief template (two house extensions: UAT NOTES, MANUAL PREREQS)

```
BRIEF NN — <name>
Plan revision: <R>

OBJECTIVE
One sentence: what done looks like.

PREMISES  (every premise is a CHECK/EXPECT pair; run all before starting)
- CHECK: head -1 handoff/00-MANIFEST.md && grep "PLAN REVISION" handoff/00-MANIFEST.md
  EXPECT: header "handoff-plan v1" and revision == <R>
- CHECK: grep "NEXT:" handoff/00-MANIFEST.md
  EXPECT: NEXT names this brief
- CHECK: git status --porcelain
  EXPECT: empty
- CHECK: <each dependency brief's Scoped verification, re-run against HEAD now>
  EXPECT: passes today ("marked done" is a claim; a passing check is a fact)

CONTEXT
Background the executor cannot infer, with code excerpts embedded.
Zero conversation history is assumed.

SCOPE
In scope: <exact work>
Out of scope: <the tempting adjacent work this brief must NOT do>

CONTRACTS
<stub file paths + the relevant signatures quoted. CONTRACTS.md and stubs
are authoritative; a mismatch here is a broken premise — blocked, not
improvised around.>

UAT NOTES
<what a browser walk must show when this brief is done — page → action →
expected visible result, one line each. The executor demonstrates each note
itself with evidence files (screenshots + console capture) saved under
handoff/evidence/; the orchestrator spot-checks them per brief and drives
everything first-hand once at final review; the uat-runbook skill turns the
human-only ones into TCs.>

MANUAL PREREQS
<"none", or human-only setup this brief assumes (bot created, key pasted).
Mirror each item into the charter's Manual-prereq registry.>

VERIFICATION
Scoped: <exact command + success criteria covering this brief's whole scope>
Regression: <the plan-wide command from 00-MANIFEST.md>
Both must pass for done-and-verified.

STOP CONDITIONS
Stop and report (deviation or blocked) — do not improvise — if:
- Any premise fails, or a premise has no runnable CHECK
- The code you find conflicts with CONTEXT or CONTRACTS
- Completing the objective requires an architecture/lock-in decision
- Verification has failed 3 runs total

CONDUCT
- Do exactly the scope; no drive-by fixes, no scope creep.
- When unsure, report the uncertainty instead of guessing.
- Never claim success without running both verification commands and
  quoting their real output.
- A useful failure report beats a fake success report.
```

## Lifecycle notes for this repo

- `/docs` and `/handoff` are **gitignored** here — charter and plan are
  local-only by the owner's choice; state persists on disk, commits carry
  code only (message convention `handoff: brief NN <state>` still applies).
- After writing a plan, confirm CLAUDE.md's Autopilot section still points at
  this pipeline, then hand over: tell the user the plan is ready and that
  `/phase-autopilot` runs it unattended — and **offer to start it now**: one
  confirmation and the user can walk away; the executor CLI is never
  prompted manually. Subsequent phases: re-enter at
  Stage 2 only (charter answers carry over); new questions that appear
  mid-project go back to Stage 0 — never guessed.
