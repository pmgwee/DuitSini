# Subscription Agent Blueprint

## Product goal
Build a premium web application that helps public users track subscriptions, free trials, renewals, recurring bills, AI plan usage, and a lightweight personal dashboard.

The product should feel like a design-led luxury SaaS product: clean, high-contrast, minimal, calm motion, polished empty states, and top-tier readability. The user's attached references suggest a dark premium product direction with a calendar-first flow, circular spending analytics, and simple add/edit modals.[cite:3][cite:4][cite:5][cite:6][cite:7][cite:8][cite:9]

## Primary users
- Individuals with many software, streaming, utility, and AI subscriptions.
- Power users who want reminders before trial conversion and renewals.
- Users who want Telegram or WhatsApp notifications.
- Users who also want a small personal dashboard with Claude usage windows, music playback, and a flip clock.

## Recommended platform
Build this as a responsive web app plus installable PWA.

Why:
- No need for iOS App Store publishing.
- Faster iteration and public rollout.
- Works across desktop and mobile.
- Easier to integrate auth, cron jobs, bot messaging, and web dashboards.

## Suggested stack
### Frontend
- Next.js 15 with App Router.
- TypeScript.
- Tailwind CSS + shadcn/ui or a custom design system.
- Framer Motion for tasteful micro-interactions.
- React Hook Form + Zod for forms.
- TanStack Query for client data fetching.
- Zustand for small UI state.
- Recharts or Visx for charts.
- FullCalendar or a custom calendar grid for the subscription calendar.

### Backend
- Supabase for Postgres, Auth, Row Level Security, storage, and edge functions.
- Prisma optional if a separate backend is preferred; otherwise direct typed Supabase access is acceptable.
- Upstash Redis optional for rate limiting, job coordination, and short-lived reminder state.

### Messaging and jobs
- Trigger.dev, Inngest, or Supabase scheduled jobs for reminders and report generation.
- Telegram Bot API for the easiest first messaging channel; Telegram provides an HTTP Bot API including `sendMessage`.[cite:27][cite:25]
- WhatsApp Cloud API as the second messaging channel; Meta documents Cloud API as the cloud-hosted WhatsApp Business Platform option.[cite:10][cite:19]

### Authentication
- Email magic link or Google sign-in via Supabase Auth.
- Optional role support: user, admin, support.

## Core product areas
### Page 1: Subscription manager
This page has two tab panels and one sticky overview widget.

#### Tab 1: Calendar view
Main function: track every upcoming subscription, free trial conversion, and recurring bill in one visual place.

Required behaviors:
- Monthly calendar as the default view.
- Display charges on their renewal day.
- Highlight trial subscriptions differently from normal renewals.
- Clicking a calendar item opens a day detail popover or sheet.
- Clicking a subscription row opens its edit/detail page.
- Include a floating plus button for add subscription flow.
- Allow create, update, delete, pause, and unsubscribe state changes.
- Allow monthly, quarterly, yearly, custom cycle, and one-off recurring billing rules.
- Support custom icon, category, note, currency, and notification preferences.

Calendar UI inspired by the user's references:
- Dark elevated day cells.
- Small service icons inside the day cell.
- A daily popup with subscription list and total for the selected date.[cite:8][cite:9]

#### Tab 2: Statistics view
Main function: see monthly and yearly totals, category splits, and upcoming charges.

Required widgets:
- Current month spend.
- Current year spend.
- Average monthly spend.
- Upcoming 30-day charges.
- Category ring chart.
- Month-by-month spend chart.
- Trial conversions in next 30 days.
- Saved amount from cancelled subscriptions.

The user's references show both monthly/yearly forecasting and category-centric circular charts, which should be preserved in a more premium and readable form.[cite:3][cite:4][cite:5]

#### Sticky widget below both tabs
A persistent overview section should always remain visible near the lower area of the page.

Include:
- Category chips or cards.
- Count of active subscriptions per category.
- Category spend totals.
- Quick filters: streaming, utilities, SaaS, AI, gaming, productivity, finance, education, other.
- Quick-add shortcuts.

The attached reference indicates a compact categorized overview layout that can be elevated into a dock-like sticky widget.[cite:6]

### Page 2: Personal dashboard
A minimalist three-panel dashboard:
- Claude plan usage windows.
- YouTube Music now playing.
- Large flip clock.

#### Claude usage tracker
Track two windows:
- Rolling 5-hour session window.
- 7-day weekly window.

Important product note: the UI should present reset timers and user-entered or inferred session activity, but should not promise exact remaining messages because Anthropic says usage depends on factors such as message length, conversation length, files, and features used.[cite:29]

Suggested components:
- 5-hour circular countdown.
- 7-day progress bar.
- Session start marker.
- Estimated usage state: light, medium, heavy.
- Manual reset or “start session” button.
- Notes log to remember what caused heavy usage.

#### Music widget
Show:
- Album art.
- Track title.
- Artist.
- Play/pause.
- Next/previous.
- Open source app shortcut.

Implementation note:
- Direct YouTube Music playback control is difficult without an official public playback API for generic third-party web apps, so treat this as an integration layer that may require a browser extension, local companion service, or fallback to read-only now-playing depending on the user's environment.

#### Flip clock
A large clean white-number flip clock with subtle animation.
- Full-width typography.
- Optional seconds toggle.
- Optional ambient blur or glass card.
- Time and date.

## Required features
### Subscription object fields
Each subscription record should support:
- id
- user_id
- name
- provider
- category
- amount
- currency
- billing_cycle_type
- billing_interval_count
- plan_type
- start_date
- next_renewal_at
- free_trial_end_at
- is_trial
- is_paused
- is_cancelled
- unsubscribe_url
- icon_type
- icon_url
- color
- notes
- reminder_offsets_days array
- reminder_time_local
- notification_channels array
- created_at
- updated_at

### Categories
Default categories:
- Streaming
- Utilities
- SaaS
- AI
- Music
- Gaming
- Productivity
- Finance
- Education
- Cloud
- Other

### Billing cycles
Support:
- Weekly
- Monthly
- Quarterly
- Semi-annual
- Annual
- Custom N-day
- Custom N-month

### Reminder logic
Required reminder timings:
- 7 days before renewal.
- 3 days before renewal.
- 1 day before renewal.
- Same-day optional.

Rules:
- Each subscription can override defaults.
- Trial subscriptions prioritize trial-end reminders.
- If next renewal changes, reminder jobs must be rescheduled.
- If paused or cancelled, future reminders stop.
- Deduplicate notifications per channel.
- Always store timezone-aware timestamps.

### Monthly report
Generate on the first day of each month.

Content:
- Title section.
- Total expected spend for the month.
- Upcoming charges by date.
- Charges grouped by category.
- Trials ending this month.
- Most expensive subscriptions.
- New subscriptions added last month.
- Cancelled subscriptions and savings.
- Clean “action needed” section.

Delivery:
- In-app report page.
- PDF or HTML export.
- Telegram and WhatsApp delivery where connected.

### Yearly report
Generate on the last day of the year or first day of the new year.

Content:
- Total spend for the year.
- Spend by category.
- Spend by provider.
- Trend by month.
- Biggest waste candidates.
- Biggest value subscriptions.
- New vs cancelled subscriptions.
- Year-over-year comparison when enough data exists.

## CRUD flows
### Add subscription flow
Two entry patterns:
1. Fast add from catalog.
2. Full manual add form.

Fast add flow:
- Search provider.
- Pick suggested icon/category.
- Prefill common billing cadence if known.
- Confirm amount, currency, date, reminders.

Manual form fields:
- Name
- Category
- Cost
- Currency
- Frequency
- Start date
- Trial toggle
- Trial end date
- Notifications toggle
- Reminder time
- Reminder day offsets
- Notes
- Icon

This aligns with the user's attached add-subscription references.[cite:1][cite:7][cite:8]

### Edit subscription flow
The detail page or modal should allow:
- Update amount.
- Update billing cycle.
- Update next renewal date.
- Toggle paused state.
- Mark cancelled/unsubscribed.
- Delete permanently.
- Edit notes and category.

The attached detail reference shows the needed mental model: amount, renewal date, edit action, pause, cancel, and delete in one tidy action sheet.[cite:9]

## Data model
### Tables
#### users
- id
- email
- full_name
- timezone
- created_at

#### user_profiles
- user_id
- preferred_currency
- theme
- telegram_chat_id
- telegram_enabled
- whatsapp_enabled
- whatsapp_phone
- monthly_report_enabled
- yearly_report_enabled
- created_at
- updated_at

#### subscriptions
- id
- user_id
- name
- provider
- category
- amount
- currency
- billing_cycle_type
- billing_interval_count
- plan_type
- start_date
- next_renewal_at
- free_trial_end_at
- is_trial
- is_paused
- is_cancelled
- unsubscribe_url
- icon_url
- color
- notes
- created_at
- updated_at

#### subscription_notifications
- id
- subscription_id
- channel
- reminder_offset_days
- reminder_time_local
- enabled
- created_at
- updated_at

#### notification_deliveries
- id
- user_id
- subscription_id
- channel
- scheduled_for
- sent_at
- status
- error_message
- payload_json

#### monthly_reports
- id
- user_id
- month_key
- report_html
- report_pdf_url
- delivered_channels_json
- created_at

#### yearly_reports
- id
- user_id
- year_key
- report_html
- report_pdf_url
- delivered_channels_json
- created_at

#### claude_usage_sessions
- id
- user_id
- session_started_at
- session_ends_at
- weekly_window_started_at
- weekly_window_ends_at
- usage_state
- notes
- created_at
- updated_at

#### music_presence
- id
- user_id
- source
- track_title
- artist_name
- album_name
- album_art_url
- is_playing
- updated_at

## Key backend services
### Renewal engine
Responsibilities:
- Calculate next renewal date.
- Handle custom intervals.
- Handle trial conversion into paid plan.
- Skip cancelled or paused subscriptions.

### Reminder scheduler
Responsibilities:
- Generate pending reminder events.
- Cancel outdated reminders.
- Retry failed sends.
- Prevent duplicates.

### Report generator
Responsibilities:
- Compile month/year subscription data.
- Produce polished HTML.
- Optionally render PDF.
- Deliver to enabled channels.

### Claude usage tracker service
Responsibilities:
- Start a new 5-hour window.
- Maintain a weekly reset window.
- Show live countdowns.
- Preserve manual logs and states.

## API routes
### Auth
- /api/auth/session
- /api/auth/callback

### Subscriptions
- GET /api/subscriptions
- POST /api/subscriptions
- GET /api/subscriptions/:id
- PATCH /api/subscriptions/:id
- DELETE /api/subscriptions/:id
- POST /api/subscriptions/:id/pause
- POST /api/subscriptions/:id/cancel

### Calendar and stats
- GET /api/calendar?month=YYYY-MM
- GET /api/stats/monthly
- GET /api/stats/yearly
- GET /api/stats/categories
- GET /api/upcoming

### Notifications
- POST /api/integrations/telegram/connect
- POST /api/integrations/telegram/test
- POST /api/integrations/whatsapp/connect
- POST /api/integrations/whatsapp/test

### Reports
- GET /api/reports/monthly/:monthKey
- GET /api/reports/yearly/:yearKey
- POST /api/reports/monthly/generate
- POST /api/reports/yearly/generate

### Claude dashboard
- GET /api/claude-usage
- POST /api/claude-usage/start-session
- POST /api/claude-usage/reset-week
- PATCH /api/claude-usage/:id

### Music widget
- GET /api/music/now-playing
- POST /api/music/play-pause
- POST /api/music/next
- POST /api/music/previous

## UX requirements
### Design principles
- Premium, minimal, luxurious.
- Dark mode first with excellent contrast.
- Sparse use of saturated accent colors.
- Large clean typography.
- Soft depth, not heavy neon.
- Motion should be elegant and rare.
- The interface must feel closer to Apple Design Award, Awwwards-quality product craft, and refined desktop utility apps than generic SaaS templates.

### Layout principles
- Desktop: bento dashboard grid.
- Mobile: bottom navigation or segmented control.
- Calendar first on Page 1.
- Sticky overview widget below both tabs.
- Page 2 should feel like a personal command center.

### States
Design complete states for:
- Empty subscription list.
- Loading skeletons.
- Reminder sent success.
- Integration disconnected.
- Trial ending soon alert.
- Failed delivery.
- No music playing.
- No Claude session active.

## Security and privacy
- Row Level Security for all user data.
- Encrypt integration secrets.
- Store minimal bot credentials.
- Audit log for notification actions.
- Clear privacy messaging because financial subscriptions are sensitive.

## Monetization ideas
- Free tier: up to 10 subscriptions, Telegram reminders, monthly summary.
- Pro tier: unlimited subscriptions, WhatsApp, yearly reports, AI insights, custom themes, export, advanced analytics.
- Team or family tier later.

## MVP scope
### Must-have
- Auth
- Subscription CRUD
- Calendar page
- Monthly/yearly analytics
- Sticky category overview
- Reminder engine
- Telegram notifications
- Monthly report
- Claude usage tracker
- Flip clock

### Nice-to-have later
- WhatsApp integration
- Music playback control
- Smart import from email receipts
- OCR from screenshots
- Duplicate subscription detection
- Savings recommendations
- Family shared account

## Suggested milestones
### Milestone 1
- Project setup
- Auth
- Database schema
- Basic dashboard shell

### Milestone 2
- Subscription CRUD
- Add/edit modals
- Calendar rendering
- Sticky widget

### Milestone 3
- Monthly/yearly statistics
- Chart components
- Upcoming charges logic

### Milestone 4
- Reminder scheduler
- Telegram integration
- Notification history

### Milestone 5
- Monthly report generation
- Yearly report generation
- PDF or shareable HTML export

### Milestone 6
- Claude usage tracker
- Flip clock
- Music widget scaffolding

### Milestone 7
- WhatsApp integration
- Advanced AI insights
- Performance and polish pass

## Quality bar
The build is only acceptable if it has:
- Strong visual hierarchy.
- Accessible contrast.
- Clean mobile experience.
- Smooth transitions.
- Zero cheap-looking template feel.
- Excellent empty, error, and loading states.
- Reliable renewal and reminder logic.

## Delivery expectation for implementation agent
The implementation agent should:
- Build production-quality code, not a prototype.
- Create reusable components.
- Keep the codebase typed and modular.
- Prefer clear architecture over hacks.
- Add seed data and demo content.
- Add a polished landing/dashboard experience from the start.
