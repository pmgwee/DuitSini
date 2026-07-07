import type { Category } from "@/lib/constants";

/**
 * A curated catalog of well-known subscription providers so users can pick a
 * recognizable preset (which auto-fills category + brand color) instead of
 * typing everything by hand — the pattern Wallos and SubAlert use. The list is
 * intentionally opinionated and finite; anything not here is still fully
 * supported as free-text (see `findProviderPreset`).
 */
export interface ProviderPreset {
  /** Canonical display name, e.g. "Netflix". */
  name: string;
  category: Category;
  /** Brand accent (hex) used for the subscription's icon chip. */
  color: string;
  /** Extra search terms (aliases) so "gpt" finds "ChatGPT", etc. */
  keywords?: string[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ── AI ──────────────────────────────────────────────────────────────
  { name: "ChatGPT", category: "ai", color: "#10a37f", keywords: ["openai", "gpt", "chat gpt"] },
  { name: "Claude", category: "ai", color: "#d97757", keywords: ["anthropic"] },
  { name: "Perplexity", category: "ai", color: "#20808d", keywords: ["perplexity ai"] },
  { name: "GitHub Copilot", category: "ai", color: "#6e40c9", keywords: ["copilot"] },
  { name: "Midjourney", category: "ai", color: "#4b4bff", keywords: [] },
  { name: "Cursor", category: "ai", color: "#000000", keywords: ["cursor ai"] },
  { name: "Google Gemini", category: "ai", color: "#4285f4", keywords: ["gemini", "bard"] },
  { name: "z.ai", category: "ai", color: "#3b6ef2", keywords: ["glm", "zhipu", "z ai"] },

  // ── Streaming ───────────────────────────────────────────────────────
  { name: "Netflix", category: "streaming", color: "#e50914", keywords: [] },
  { name: "Disney+", category: "streaming", color: "#113ccf", keywords: ["disney plus", "disney"] },
  { name: "YouTube Premium", category: "streaming", color: "#ff0000", keywords: ["youtube"] },
  { name: "Amazon Prime Video", category: "streaming", color: "#00a8e1", keywords: ["prime video", "prime"] },
  { name: "HBO Max", category: "streaming", color: "#7b2ff7", keywords: ["max", "hbo"] },
  { name: "Hulu", category: "streaming", color: "#1ce783", keywords: [] },
  { name: "Apple TV+", category: "streaming", color: "#000000", keywords: ["apple tv"] },
  { name: "Crunchyroll", category: "streaming", color: "#f47521", keywords: ["anime"] },
  { name: "Twitch", category: "streaming", color: "#9146ff", keywords: [] },

  // ── Music ───────────────────────────────────────────────────────────
  { name: "Spotify", category: "music", color: "#1db954", keywords: [] },
  { name: "Apple Music", category: "music", color: "#fa243c", keywords: [] },
  { name: "YouTube Music", category: "music", color: "#ff0000", keywords: ["yt music"] },
  { name: "SoundCloud", category: "music", color: "#ff5500", keywords: [] },
  { name: "Tidal", category: "music", color: "#000000", keywords: [] },

  // ── Productivity ────────────────────────────────────────────────────
  { name: "Notion", category: "productivity", color: "#000000", keywords: [] },
  { name: "Microsoft 365", category: "productivity", color: "#d83b01", keywords: ["office", "office 365", "microsoft office"] },
  { name: "Google One", category: "productivity", color: "#4285f4", keywords: ["google storage", "google workspace"] },
  { name: "Todoist", category: "productivity", color: "#e44332", keywords: [] },
  { name: "Evernote", category: "productivity", color: "#00a82d", keywords: [] },
  { name: "Grammarly", category: "productivity", color: "#15c39a", keywords: [] },
  { name: "1Password", category: "productivity", color: "#0572ec", keywords: ["password"] },
  { name: "Obsidian", category: "productivity", color: "#7c3aed", keywords: [] },

  // ── SaaS / Design / Dev ─────────────────────────────────────────────
  { name: "Figma", category: "saas", color: "#f24e1e", keywords: [] },
  { name: "Adobe Creative Cloud", category: "saas", color: "#da1f26", keywords: ["adobe", "photoshop", "creative cloud"] },
  { name: "Canva", category: "saas", color: "#00c4cc", keywords: [] },
  { name: "Slack", category: "saas", color: "#4a154b", keywords: [] },
  { name: "Zoom", category: "saas", color: "#2d8cff", keywords: [] },
  { name: "Linear", category: "saas", color: "#5e6ad2", keywords: [] },
  { name: "Vercel", category: "cloud", color: "#000000", keywords: [] },
  { name: "GitHub", category: "saas", color: "#181717", keywords: [] },

  // ── Cloud / Hosting ─────────────────────────────────────────────────
  { name: "iCloud+", category: "cloud", color: "#3693f3", keywords: ["icloud", "apple icloud"] },
  { name: "Dropbox", category: "cloud", color: "#0061ff", keywords: [] },
  { name: "AWS", category: "cloud", color: "#ff9900", keywords: ["amazon web services"] },

  // ── Gaming ──────────────────────────────────────────────────────────
  { name: "PlayStation Plus", category: "gaming", color: "#0070d1", keywords: ["ps plus", "psn", "playstation"] },
  { name: "Xbox Game Pass", category: "gaming", color: "#107c10", keywords: ["game pass", "xbox"] },
  { name: "Nintendo Switch Online", category: "gaming", color: "#e60012", keywords: ["nintendo"] },
  { name: "Steam", category: "gaming", color: "#1b2838", keywords: [] },
  { name: "Discord Nitro", category: "gaming", color: "#5865f2", keywords: ["discord"] },

  // ── Education ───────────────────────────────────────────────────────
  { name: "Duolingo", category: "education", color: "#58cc02", keywords: [] },
  { name: "Coursera", category: "education", color: "#0056d2", keywords: [] },
  { name: "Udemy", category: "education", color: "#a435f0", keywords: [] },
  { name: "LinkedIn Premium", category: "education", color: "#0a66c2", keywords: ["linkedin"] },

  // ── Finance ─────────────────────────────────────────────────────────
  { name: "YNAB", category: "finance", color: "#3b5eda", keywords: ["you need a budget"] },

  // ── Utilities ───────────────────────────────────────────────────────
  { name: "NordVPN", category: "utilities", color: "#4687ff", keywords: ["vpn"] },
  { name: "ExpressVPN", category: "utilities", color: "#da3940", keywords: ["vpn"] },
];

/** Normalize a name for tolerant matching (case/space/punctuation-insensitive). */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Find a preset by an exact-ish name or keyword match. Used to auto-fill the
 * brand color for a subscription whose name matches a known provider.
 */
export function findProviderPreset(name: string | null | undefined): ProviderPreset | null {
  if (!name) return null;
  const n = normalize(name);
  if (!n) return null;
  for (const p of PROVIDER_PRESETS) {
    if (normalize(p.name) === n) return p;
    if (p.keywords?.some((k) => normalize(k) === n)) return p;
  }
  return null;
}

/**
 * Rank presets against a free-text query for the combobox. Empty query returns
 * the full list (in catalog order). Prefix matches rank above substring matches.
 */
export function searchProviderPresets(query: string, limit = 8): ProviderPreset[] {
  const q = normalize(query);
  if (!q) return PROVIDER_PRESETS.slice(0, limit);

  const scored: Array<{ p: ProviderPreset; score: number }> = [];
  for (const p of PROVIDER_PRESETS) {
    const haystacks = [p.name, ...(p.keywords ?? [])].map(normalize);
    let best = Infinity;
    for (const h of haystacks) {
      if (h.startsWith(q)) best = Math.min(best, 0);
      else if (h.includes(q)) best = Math.min(best, 1);
    }
    if (best !== Infinity) scored.push({ p, score: best });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.p);
}
