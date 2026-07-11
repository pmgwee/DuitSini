# Autopilot skill suite

Three project skills that turn the old two-window manual loop (prompt Fable →
paste plan to GLM → manually check UI → paste bugs back → ad-hoc testing docs)
into one unattended pipeline. Adapted for this machine from
[pinjun99/Sildenafil_coding](https://github.com/pinjun99/Sildenafil_coding)
(orchestrator / advisor / handoff, MIT).

```
requirements ──► /phase-kickstart ──► docs/charter/PROJECT-CHARTER.md
   (user answers all questions ONCE)      handoff/  (manifest·contracts·briefs)
                                              │
                          ┌───────────────────▼──────────────────┐
                          │            /phase-autopilot          │
                          │  per brief:                          │
                          │   GLM (headless, via glm-run.mjs)    │
                          │     └► vet: diff·verify·MODEL_VERIFIED│
                          │     └► browser gate (UAT NOTES)      │
                          │   failure ladder: fix-packet → respawn│
                          │     once → absorb → rule (ADVISOR.md)│
                          │  final review (top-tier, in-session) │
                          └───────────────────┬──────────────────┘
                                              ▼
                    /uat-runbook ──► docs/runbooks/<phase>-runbook.md (+ Notion)
                    human does ONLY: manual prereqs + final UI review + deploy
```

## Quick start

- New project / next phase: `/phase-kickstart` with the requirements — stay
  at the keyboard for the interview; that is the one human-required stage.
- Run / resume unattended: `/phase-autopilot` — safe to walk away; any new
  session resumes from `handoff/00-MANIFEST.md`'s `NEXT:` line.
- Check the GLM wiring anytime: `node scripts/autopilot/glm-run.mjs --probe`
  (expects `MODEL_VERIFIED=true`, model `glm-*`, provider read live from
  cc-switch without touching its current switch position).
- Standalone testing doc: `/uat-runbook` for any feature, any time.

## Division of labor (and spend)

| Role | Who | Pays with |
|---|---|---|
| Interview, charter, plan, briefs | top-tier session (Fable/Opus) | judgment tokens |
| Implementation of every brief | GLM Max via `claude -p` headless | GLM subscription |
| Vetting, browser gates, rulings, final review, runbook | top-tier session | judgment tokens |
| Manual prereqs, final UI look, deploy click | the human | ~minutes per phase |

## Notes

- `/handoff` and `/docs` are gitignored — plans, logs, charters and runbooks
  stay local (owner's choice); commits carry code only.
- `glm-run.mjs` feeds the prompt via stdin (Windows shell arg concatenation
  mangles quotes) and exits 3 when the answering model isn't GLM — wiring
  drift fails loud, never silently burns the wrong quota.
- Executor behavior contract: `phase-autopilot/references/EXECUTOR-PROTOCOL.md`.
- Runbook shape: `uat-runbook/references/TEMPLATE.md` (mirrors the Telegram
  Reminder UAT Runbook reference on Notion).
