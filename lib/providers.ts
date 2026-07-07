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
  /**
   * Simple Icons slug (https://simpleicons.org) used to render the real brand
   * logo as a white glyph on the brand-color circle. Omitted for brands that
   * Simple Icons doesn't carry (then we fall back to a brand-color monogram).
   * Resolved to a URL via `providerIconUrl`.
   */
  icon?: string;
  /** Extra search terms (aliases) so "gpt" finds "ChatGPT", etc. */
  keywords?: string[];
}

/** Base URL for the keyless Simple Icons CDN; `{slug}/white` is a white glyph. */
const PROVIDER_ICON_BASE = "https://cdn.simpleicons.org/";

/** Build the logo URL for a Simple Icons slug (white glyph variant). */
export function providerIconUrl(slug: string): string {
  return `${PROVIDER_ICON_BASE}${slug}/white`;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ── AI ──────────────────────────────────────────────────────────────
  { name: "ChatGPT", category: "ai", color: "#10a37f", keywords: ["openai", "gpt", "chat gpt"] },
  { name: "Claude", category: "ai", color: "#d97757", icon: "claude", keywords: ["anthropic"] },
  { name: "Perplexity", category: "ai", color: "#20808d", icon: "perplexity", keywords: ["perplexity ai"] },
  { name: "GitHub Copilot", category: "ai", color: "#6e40c9", icon: "githubcopilot", keywords: ["copilot"] },
  { name: "Midjourney", category: "ai", color: "#4b4bff", keywords: [] },
  { name: "Cursor", category: "ai", color: "#000000", icon: "cursor", keywords: ["cursor ai"] },
  { name: "Google Gemini", category: "ai", color: "#4285f4", icon: "googlegemini", keywords: ["gemini", "bard"] },
  { name: "z.ai", category: "ai", color: "#3b6ef2", keywords: ["glm", "zhipu", "z ai"] },

  // ── Streaming ───────────────────────────────────────────────────────
  { name: "Netflix", category: "streaming", color: "#e50914", icon: "netflix", keywords: [] },
  { name: "Disney+", category: "streaming", color: "#113ccf", keywords: ["disney plus", "disney"] },
  { name: "YouTube Premium", category: "streaming", color: "#ff0000", icon: "youtube", keywords: ["youtube"] },
  { name: "Amazon Prime Video", category: "streaming", color: "#00a8e1", keywords: ["prime video", "prime"] },
  { name: "HBO Max", category: "streaming", color: "#7b2ff7", icon: "hbomax", keywords: ["max", "hbo"] },
  { name: "Hulu", category: "streaming", color: "#1ce783", keywords: [] },
  { name: "Apple TV+", category: "streaming", color: "#000000", icon: "appletv", keywords: ["apple tv"] },
  { name: "Crunchyroll", category: "streaming", color: "#f47521", icon: "crunchyroll", keywords: ["anime"] },
  { name: "Twitch", category: "streaming", color: "#9146ff", icon: "twitch", keywords: [] },

  // ── Music ───────────────────────────────────────────────────────────
  { name: "Spotify", category: "music", color: "#1db954", icon: "spotify", keywords: [] },
  { name: "Apple Music", category: "music", color: "#fa243c", icon: "applemusic", keywords: [] },
  { name: "YouTube Music", category: "music", color: "#ff0000", icon: "youtubemusic", keywords: ["yt music"] },
  { name: "SoundCloud", category: "music", color: "#ff5500", icon: "soundcloud", keywords: [] },
  { name: "Tidal", category: "music", color: "#000000", icon: "tidal", keywords: [] },

  // ── Productivity ────────────────────────────────────────────────────
  { name: "Notion", category: "productivity", color: "#000000", icon: "notion", keywords: [] },
  { name: "Microsoft 365", category: "productivity", color: "#d83b01", keywords: ["office", "office 365", "microsoft office"] },
  { name: "Google One", category: "productivity", color: "#4285f4", keywords: ["google storage", "google workspace"] },
  { name: "Todoist", category: "productivity", color: "#e44332", icon: "todoist", keywords: [] },
  { name: "Evernote", category: "productivity", color: "#00a82d", icon: "evernote", keywords: [] },
  { name: "Grammarly", category: "productivity", color: "#15c39a", icon: "grammarly", keywords: [] },
  { name: "1Password", category: "productivity", color: "#0572ec", icon: "1password", keywords: ["password"] },
  { name: "Obsidian", category: "productivity", color: "#7c3aed", icon: "obsidian", keywords: [] },

  // ── SaaS / Design / Dev ─────────────────────────────────────────────
  { name: "Figma", category: "saas", color: "#f24e1e", icon: "figma", keywords: [] },
  { name: "Adobe Creative Cloud", category: "saas", color: "#da1f26", keywords: ["adobe", "photoshop", "creative cloud"] },
  { name: "Canva", category: "saas", color: "#00c4cc", keywords: [] },
  { name: "Slack", category: "saas", color: "#4a154b", keywords: [] },
  { name: "Zoom", category: "saas", color: "#2d8cff", icon: "zoom", keywords: [] },
  { name: "Linear", category: "saas", color: "#5e6ad2", icon: "linear", keywords: [] },
  { name: "Vercel", category: "cloud", color: "#000000", icon: "vercel", keywords: [] },
  { name: "GitHub", category: "saas", color: "#181717", icon: "github", keywords: [] },

  // ── Cloud / Hosting ─────────────────────────────────────────────────
  { name: "iCloud+", category: "cloud", color: "#3693f3", icon: "icloud", keywords: ["icloud", "apple icloud"] },
  { name: "Dropbox", category: "cloud", color: "#0061ff", icon: "dropbox", keywords: [] },
  { name: "AWS", category: "cloud", color: "#ff9900", keywords: ["amazon web services"] },

  // ── Gaming ──────────────────────────────────────────────────────────
  { name: "PlayStation Plus", category: "gaming", color: "#0070d1", icon: "playstation", keywords: ["ps plus", "psn", "playstation"] },
  { name: "Xbox Game Pass", category: "gaming", color: "#107c10", keywords: ["game pass", "xbox"] },
  { name: "Nintendo Switch Online", category: "gaming", color: "#e60012", keywords: ["nintendo"] },
  { name: "Steam", category: "gaming", color: "#1b2838", icon: "steam", keywords: [] },
  { name: "Discord Nitro", category: "gaming", color: "#5865f2", icon: "discord", keywords: ["discord"] },

  // ── Education ───────────────────────────────────────────────────────
  { name: "Duolingo", category: "education", color: "#58cc02", icon: "duolingo", keywords: [] },
  { name: "Coursera", category: "education", color: "#0056d2", icon: "coursera", keywords: [] },
  { name: "Udemy", category: "education", color: "#a435f0", icon: "udemy", keywords: [] },
  { name: "LinkedIn Premium", category: "education", color: "#0a66c2", keywords: ["linkedin"] },

  // ── Finance ─────────────────────────────────────────────────────────
  { name: "YNAB", category: "finance", color: "#3b5eda", keywords: ["you need a budget"] },

  // ── Utilities ───────────────────────────────────────────────────────
  { name: "NordVPN", category: "utilities", color: "#4687ff", icon: "nordvpn", keywords: ["vpn"] },
  { name: "ExpressVPN", category: "utilities", color: "#da3940", icon: "expressvpn", keywords: ["vpn"] },
];

/** Normalize a name for tolerant matching (case/space/punctuation-insensitive). */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Find a preset by an exact-ish name or keyword match. Used to auto-fill the
 * brand color + logo slug for a subscription whose name matches a known provider.
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
