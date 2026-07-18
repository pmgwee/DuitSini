export const CATEGORIES = [
  "streaming",
  "utilities",
  "telecom",
  "saas",
  "ai",
  "music",
  "gaming",
  "productivity",
  "finance",
  "education",
  "cloud",
  "news",
  "health",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_META: Record<Category, { label: string; colorVar: string }> = {
  streaming: { label: "Streaming", colorVar: "var(--cat-streaming)" },
  utilities: { label: "Utilities", colorVar: "var(--cat-utilities)" },
  telecom: { label: "Telecom", colorVar: "var(--cat-telecom)" },
  saas: { label: "SaaS", colorVar: "var(--cat-saas)" },
  ai: { label: "AI", colorVar: "var(--cat-ai)" },
  music: { label: "Music", colorVar: "var(--cat-music)" },
  gaming: { label: "Gaming", colorVar: "var(--cat-gaming)" },
  productivity: { label: "Productivity", colorVar: "var(--cat-productivity)" },
  finance: { label: "Finance", colorVar: "var(--cat-finance)" },
  education: { label: "Education", colorVar: "var(--cat-education)" },
  cloud: { label: "Cloud", colorVar: "var(--cat-cloud)" },
  news: { label: "News", colorVar: "var(--cat-news)" },
  health: { label: "Health", colorVar: "var(--cat-health)" },
  other: { label: "Other", colorVar: "var(--cat-other)" },
};

/**
 * Literal category colors (mirror of the CSS tokens in globals.css) for contexts
 * that need real color values instead of CSS vars — e.g. Recharts `<Cell fill>`,
 * which renders an SVG attribute that can't resolve `var(...)`.
 */
export const CATEGORY_COLOR: Record<Category, string> = {
  streaming: "oklch(0.72 0.16 15)",
  utilities: "oklch(0.8 0.12 75)",
  telecom: "oklch(0.72 0.14 195)",
  saas: "oklch(0.72 0.13 248)",
  ai: "oklch(0.74 0.15 292)",
  music: "oklch(0.74 0.17 342)",
  gaming: "oklch(0.77 0.15 150)",
  productivity: "oklch(0.79 0.11 205)",
  finance: "oklch(0.78 0.14 142)",
  education: "oklch(0.83 0.13 96)",
  cloud: "oklch(0.79 0.1 232)",
  news: "oklch(0.58 0.14 257)",
  health: "oklch(0.74 0.14 165)",
  other: "oklch(0.72 0.02 265)",
};

/**
 * Emoji marker for each category — used as the group header icon in Telegram
 * reminder digests. Telegram text messages can't render the brand-logo images
 * the web UI uses (Simple Icons glyph / favicon), so a category emoji is the
 * inline visual marker instead.
 */
export const CATEGORY_EMOJI: Record<Category, string> = {
  streaming: "🎬",
  utilities: "🛠️",
  telecom: "📱",
  saas: "💼",
  ai: "🤖",
  music: "🎵",
  gaming: "🎮",
  productivity: "🗂️",
  finance: "💰",
  education: "📚",
  cloud: "☁️",
  news: "📰",
  health: "💪",
  other: "📦",
};

export const BILLING_CYCLES = [
  "weekly",
  "monthly",
  "quarterly",
  "semiannual",
  "annual",
  "custom_days",
  "custom_months",
  "one_off",
] as const;

export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const BILLING_CYCLE_LABELS: Record<BillingCycle, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Semi-annual",
  annual: "Annual",
  custom_days: "Every N days",
  custom_months: "Every N months",
  one_off: "One-off",
};

/** Default reminder offsets (days before renewal). */
export const DEFAULT_REMINDER_OFFSETS = [7, 3, 1] as const;

export const CURRENCIES = ["USD", "EUR", "GBP", "SGD", "MYR", "AUD", "JPY", "INR"] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];
