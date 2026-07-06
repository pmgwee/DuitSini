export const CATEGORIES = [
  "streaming",
  "utilities",
  "saas",
  "ai",
  "music",
  "gaming",
  "productivity",
  "finance",
  "education",
  "cloud",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_META: Record<Category, { label: string; colorVar: string }> = {
  streaming: { label: "Streaming", colorVar: "var(--cat-streaming)" },
  utilities: { label: "Utilities", colorVar: "var(--cat-utilities)" },
  saas: { label: "SaaS", colorVar: "var(--cat-saas)" },
  ai: { label: "AI", colorVar: "var(--cat-ai)" },
  music: { label: "Music", colorVar: "var(--cat-music)" },
  gaming: { label: "Gaming", colorVar: "var(--cat-gaming)" },
  productivity: { label: "Productivity", colorVar: "var(--cat-productivity)" },
  finance: { label: "Finance", colorVar: "var(--cat-finance)" },
  education: { label: "Education", colorVar: "var(--cat-education)" },
  cloud: { label: "Cloud", colorVar: "var(--cat-cloud)" },
  other: { label: "Other", colorVar: "var(--cat-other)" },
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
