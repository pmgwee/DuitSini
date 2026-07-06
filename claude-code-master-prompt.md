# Claude Code Master Prompt

Copy everything below into Claude Code, and attach the blueprint file alongside it.

---

You are acting as a principal product engineer, staff full-stack architect, senior AI product engineer, and award-level UI/UX implementation lead.

Your task is to build a production-quality web application called **Subscription Agent** using the attached blueprint as the source of truth.

## Mission
Create a premium, public-ready subscription management web app and personal dashboard that helps users:
- Track subscriptions, recurring bills, and free trials.
- Get reminder notifications before renewals.
- View monthly and yearly spending analytics.
- See categorized subscription overviews.
- Generate elegant monthly and yearly reports.
- Track Claude Pro usage with 5-hour and 7-day windows.
- View a personal dashboard including now-playing music and a large flip clock.

The app must feel high-end, minimal, calm, precise, and design-led — not like a generic startup dashboard.

## Non-negotiable instruction
Read the attached blueprint carefully and implement from it in a disciplined way.

If there is any conflict between this prompt and the blueprint:
1. Prefer the blueprint for product requirements.
2. Prefer this prompt for implementation discipline and delivery workflow.

## Build objective
Deliver a complete working application scaffold with polished UI, strong architecture, and a clear path to production.

Do not produce vague plans only.
Do not stop at wireframes.
Do not create a toy demo.
Build real code.

## Product requirements
Use the attached blueprint to implement:
- Page 1 subscription manager with two tabs and sticky overview widget.
- Page 2 personal dashboard with Claude usage, music widget, and flip clock.
- Auth.
- Database schema.
- Subscription CRUD.
- Reminder system.
- Report generation structure.
- Telegram first, WhatsApp second.
- Responsive desktop and mobile experiences.

## Technical stack
Unless there is a strong reason to adjust, use this stack:
- Next.js 15 App Router
- TypeScript
- Tailwind CSS
- shadcn/ui or carefully customized primitives
- Supabase Auth + Postgres + RLS
- Server actions and route handlers where appropriate
- Framer Motion for restrained motion
- Recharts or Visx for charts
- Zod for validation
- React Hook Form for forms

If you choose an alternative for any major layer, explain the reason briefly and ensure it still satisfies the blueprint.

## Design direction
The visual quality bar is extremely high.

The design language should be:
- Dark-first premium UI.
- Refined minimal luxury.
- High readability.
- Strong spacing discipline.
- Soft elevation and subtle blur where useful.
- Clean typography.
- Restrained accents.
- Elegant micro-interactions.
- Beautiful empty states.
- Calm, premium chart styling.

Avoid:
- Generic SaaS templates.
- Harsh neon gradient look.
- Cheap glassmorphism everywhere.
- Overcrowded widgets.
- Random colors.
- Repetitive card layouts with no hierarchy.

## Working style
You must work in phases and keep output structured.

### Phase 1: Understand and plan
- Read the blueprint.
- Extract core product modules.
- Extract data entities.
- Extract page structure.
- Extract integrations.
- Produce a short implementation plan.

### Phase 2: Architecture
- Define folder structure.
- Define app routes.
- Define core components.
- Define data model and migration plan.
- Define service boundaries.

### Phase 3: Foundation
- Set up app shell.
- Set up theme tokens.
- Set up typography.
- Set up layout system.
- Set up auth.
- Set up Supabase.
- Set up database schema.

### Phase 4: Page 1 implementation
Build the subscription manager first:
- calendar tab
- analytics tab
- sticky overview widget
- add subscription flow
- edit subscription flow
- delete/pause/cancel actions
- upcoming charges logic

### Phase 5: Page 2 implementation
Build the personal dashboard:
- Claude usage tracker
- flip clock
- now-playing music widget shell
- responsive layout

### Phase 6: Background features
- reminder scheduling architecture
- Telegram integration
- WhatsApp integration abstraction
- monthly report generation
- yearly report generation

### Phase 7: Polish
- skeleton states
- empty states
- error handling
- accessibility pass
- mobile refinement
- visual polish pass

## Required delivery format
At each major step, output these sections:
1. What is being built.
2. Files created or changed.
3. Important implementation notes.
4. Next step.

When writing code:
- Prefer complete files over fragments when possible.
- If updating a file, show the full updated file when practical.
- Keep naming clean and consistent.
- Keep logic modular.
- Avoid unnecessary abstractions.

## Code quality rules
- Use TypeScript strictly.
- Avoid `any` unless absolutely necessary.
- Validate all inputs.
- Separate UI, business logic, and data access.
- Use server-side logic for sensitive operations.
- Use timezone-aware date handling.
- Make reminder logic deterministic.
- Build components for reuse, not one-off hacks.
- Keep styles coherent through design tokens.

## UX rules
- Prioritize clarity over novelty.
- Every action must feel obvious.
- Forms must be fast and low-friction.
- Calendar interactions must be intuitive.
- Analytics must be readable at a glance.
- Page 2 must feel like a clean personal command center.
- Mobile layout must feel intentionally designed, not merely shrunken.

## Architecture requirements
Implement or scaffold these layers cleanly:
- app routes
- components
- features
- lib utilities
- integrations
- database schema
- background jobs
- report templates
- API or route handlers

Recommended structure example:
- `app/`
- `components/`
- `features/subscriptions/`
- `features/analytics/`
- `features/dashboard/`
- `features/reports/`
- `features/integrations/`
- `lib/`
- `types/`
- `supabase/`

## Data requirements
Use the blueprint to define tables and types for:
- users and profiles
- subscriptions
- notification preferences
- notification deliveries
- reports
- Claude usage sessions
- music presence

Generate:
- SQL schema or migrations
- TypeScript types
- validation schemas
- seed data

## Integration requirements
### Telegram
Implement Telegram first.
- Create connection flow.
- Add test message action.
- Add reminder delivery method.
- Add delivery logging.

### WhatsApp
Design the integration boundary now, even if some parts are stubbed initially.
- Keep provider abstraction clean.
- Make WhatsApp pluggable beside Telegram.

### Claude usage
Build the tracker in a way that clearly distinguishes:
- rolling 5-hour session window
- weekly 7-day window
- manual session start/reset events
- confidence limits around exact usage estimation

### Music widget
If full playback control is not realistically possible in the current environment, implement:
- now-playing UI shell
- integration adapter interface
- mock provider
- safe fallback state

## Reporting requirements
Build monthly and yearly report generation as real templates.
Include:
- elegant layout
- readable sections
- totals
- grouped charges
- action-needed summary
- future export capability

## What to optimize for
Optimize for:
- maintainability
- premium user experience
- clean architecture
- future monetization
- public launch readiness

## What not to do
Do not:
- dump all code into a few giant files
- ignore mobile
- ignore loading/error states
- hardcode sample-only logic into production paths
- use ugly default charts
- leave TODO-heavy unfinished core flows
- create inconsistent design between pages

## Execution rule
Start by doing these tasks in order:
1. Summarize the blueprint into modules.
2. Propose final architecture.
3. Create project structure.
4. Create design system foundations.
5. Create database schema.
6. Build Page 1 core flow.
7. Build Page 2 core flow.
8. Build integrations and reports.
9. Run polish and QA pass.

## Output rule
Be decisive.
Make strong implementation choices.
When ambiguity exists, choose the option that best supports a premium, scalable, production-grade web app.

Now begin with:
- a concise blueprint digestion,
- the architecture plan,
- and the initial file tree.
