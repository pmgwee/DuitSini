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
   * Simple Icons doesn't carry (then we fall back to a favicon-by-domain, then
   * a monogram). Resolved to a URL via `providerIconUrl`.
   */
  icon?: string;
  /**
   * Website domain (e.g. "openai.com") used to fetch a full-color logo favicon
   * for brands that aren't on Simple Icons (the `icon` slug). Keyless; works as
   * a plain <img src>. The second-tier fallback before the monogram.
   */
  domain?: string;
  /** Extra search terms (aliases) so "gpt" finds "OpenAI", etc. */
  keywords?: string[];
}

/** Base URL for the keyless Simple Icons CDN; `{slug}/white` is a white glyph. */
const PROVIDER_ICON_BASE = "https://cdn.simpleicons.org/";

/** Build the logo URL for a Simple Icons slug (white glyph variant). */
export function providerIconUrl(slug: string): string {
  return `${PROVIDER_ICON_BASE}${slug}/white`;
}

/**
 * Keyless favicon lookup (Google Favicons) — a full-color logo for brands not
 * carried by Simple Icons. Works for any website domain as a plain <img src>
 * (CORS isn't required for <img>). Used as the second-tier fallback before the
 * monogram, so EVERY provider can show a real logo.
 */
export function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ── AI ──────────────────────────────────────────────────────────────
  { name: "OpenAI", category: "ai", color: "#10a37f", domain: "openai.com", keywords: ["chatgpt", "gpt", "chat gpt", "dall-e"] },
  { name: "Anthropic", category: "ai", color: "#d97757", icon: "anthropic", domain: "anthropic.com", keywords: ["claude"] },
  { name: "Google", category: "ai", color: "#4285f4", icon: "google", domain: "google.com", keywords: ["gemini", "bard", "youtube", "youtube premium", "youtube music", "yt music", "google one", "google workspace", "google storage"] },
  { name: "Microsoft", category: "productivity", color: "#0078d4", domain: "microsoft.com", keywords: ["github", "copilot", "github copilot", "xbox", "xbox game pass", "game pass", "office", "office 365", "microsoft 365", "linkedin", "linkedin premium", "azure", "windows"] },
  { name: "Perplexity", category: "ai", color: "#20808d", icon: "perplexity", domain: "perplexity.ai", keywords: ["perplexity ai"] },
  { name: "Cursor", category: "ai", color: "#000000", icon: "cursor", domain: "cursor.com", keywords: ["cursor ai"] },
  { name: "Midjourney", category: "ai", color: "#4b4bff", domain: "midjourney.com", keywords: [] },
  { name: "Hyper3D", category: "ai", color: "#6d28d9", domain: "hyper3d.ai", keywords: ["hyper3d", "3d", "text to 3d"] },
  { name: "Z.ai", category: "ai", color: "#3b6ef2", domain: "z.ai", keywords: ["z ai", "zai", "glm", "zhipu"] },
  { name: "Mistral AI", category: "ai", color: "#fa520f", icon: "mistralai", domain: "mistral.ai", keywords: ["mistral", "le chat"] },
  { name: "Hugging Face", category: "ai", color: "#ffd21e", icon: "huggingface", domain: "huggingface.co", keywords: ["huggingface"] },
  { name: "ElevenLabs", category: "ai", color: "#000000", icon: "elevenlabs", domain: "elevenlabs.io", keywords: ["eleven labs", "voice ai"] },
  { name: "Suno", category: "ai", color: "#000000", icon: "suno", domain: "suno.com", keywords: ["suno ai", "music ai"] },
  { name: "Runway", category: "ai", color: "#18181b", domain: "runwayml.com", keywords: ["runwayml", "video ai"] },

  // ── Streaming ───────────────────────────────────────────────────────
  { name: "Netflix", category: "streaming", color: "#e50914", icon: "netflix", domain: "netflix.com", keywords: [] },
  { name: "Apple", category: "streaming", color: "#000000", icon: "apple", domain: "apple.com", keywords: ["apple music", "apple tv", "appletv", "apple tv+", "icloud", "icloud+", "apple one", "apple arcade", "apple news", "apple fitness", "appleCare"] },
  { name: "Amazon", category: "streaming", color: "#ff9900", domain: "amazon.com", keywords: ["prime", "prime video", "amazon prime", "aws", "amazon web services", "audible", "twitch", "amazon music", "kindle unlimited"] },
  { name: "Disney+", category: "streaming", color: "#113ccf", domain: "disneyplus.com", keywords: ["disney plus", "disney"] },
  { name: "Max", category: "streaming", color: "#002be7", icon: "hbo", domain: "max.com", keywords: ["hbo", "hbo max", "warner"] },
  { name: "Hulu", category: "streaming", color: "#1ce783", domain: "hulu.com", keywords: [] },
  { name: "Paramount+", category: "streaming", color: "#0064ff", icon: "paramountplus", domain: "paramountplus.com", keywords: ["paramount", "paramount plus"] },
  { name: "Peacock", category: "streaming", color: "#000000", domain: "peacocktv.com", keywords: ["peacock tv", "nbc"] },
  { name: "Crunchyroll", category: "streaming", color: "#f47521", icon: "crunchyroll", domain: "crunchyroll.com", keywords: ["anime"] },

  // ── Music ───────────────────────────────────────────────────────────
  { name: "Spotify", category: "music", color: "#1db954", icon: "spotify", domain: "spotify.com", keywords: [] },
  { name: "Tidal", category: "music", color: "#000000", icon: "tidal", domain: "tidal.com", keywords: [] },
  { name: "SoundCloud", category: "music", color: "#ff5500", icon: "soundcloud", domain: "soundcloud.com", keywords: [] },
  { name: "Pandora", category: "music", color: "#3668ff", icon: "pandora", domain: "pandora.com", keywords: [] },
  { name: "Deezer", category: "music", color: "#a238ff", icon: "deezer", domain: "deezer.com", keywords: [] },

  // ── Productivity / SaaS ─────────────────────────────────────────────
  { name: "Notion", category: "productivity", color: "#000000", icon: "notion", domain: "notion.so", keywords: [] },
  { name: "Adobe", category: "saas", color: "#eb1000", domain: "adobe.com", keywords: ["creative cloud", "photoshop", "illustrator", "lightroom", "acrobat"] },
  { name: "Canva", category: "saas", color: "#00c4cc", domain: "canva.com", keywords: [] },
  { name: "Slack", category: "saas", color: "#611f69", domain: "slack.com", keywords: [] },
  { name: "Zoom", category: "saas", color: "#2d8cff", icon: "zoom", domain: "zoom.us", keywords: [] },
  { name: "Linear", category: "saas", color: "#5e6ad2", icon: "linear", domain: "linear.app", keywords: [] },
  { name: "Dropbox", category: "cloud", color: "#0061ff", icon: "dropbox", domain: "dropbox.com", keywords: [] },
  { name: "Box", category: "cloud", color: "#0061d5", icon: "box", domain: "box.com", keywords: [] },
  { name: "Todoist", category: "productivity", color: "#e44332", icon: "todoist", domain: "todoist.com", keywords: [] },
  { name: "Evernote", category: "productivity", color: "#00a82d", icon: "evernote", domain: "evernote.com", keywords: [] },
  { name: "Grammarly", category: "productivity", color: "#15c39a", icon: "grammarly", domain: "grammarly.com", keywords: [] },
  { name: "1Password", category: "productivity", color: "#0572ec", icon: "1password", domain: "1password.com", keywords: ["password"] },
  { name: "Obsidian", category: "productivity", color: "#7c3aed", icon: "obsidian", domain: "obsidian.md", keywords: [] },
  { name: "Proton", category: "productivity", color: "#6d4aff", icon: "proton", domain: "proton.me", keywords: ["protonmail", "protonvpn", "proton drive", "proton pass"] },

  // ── Design / Dev / Cloud / Marketing ────────────────────────────────
  { name: "Figma", category: "saas", color: "#f24e1e", icon: "figma", domain: "figma.com", keywords: [] },
  { name: "Cloudflare", category: "cloud", color: "#f38020", icon: "cloudflare", domain: "cloudflare.com", keywords: ["cf", "workers", "pages"] },
  { name: "Vercel", category: "cloud", color: "#000000", icon: "vercel", domain: "vercel.com", keywords: [] },
  { name: "Manychat", category: "saas", color: "#00c2b2", domain: "manychat.com", keywords: ["many chat", "instagram automation", "messenger bot"] },
  { name: "DigitalOcean", category: "cloud", color: "#0080ff", icon: "digitalocean", domain: "digitalocean.com", keywords: ["do"] },
  { name: "Supabase", category: "cloud", color: "#3ecf8e", icon: "supabase", domain: "supabase.com", keywords: [] },
  { name: "Replit", category: "saas", color: "#f26207", icon: "replit", domain: "replit.com", keywords: [] },
  { name: "Zapier", category: "saas", color: "#ff4f00", icon: "zapier", domain: "zapier.com", keywords: [] },

  // ── Gaming ──────────────────────────────────────────────────────────
  { name: "Steam", category: "gaming", color: "#1b2838", icon: "steam", domain: "steampowered.com", keywords: [] },
  { name: "PlayStation", category: "gaming", color: "#0070d1", icon: "playstation", domain: "playstation.com", keywords: ["playstation plus", "ps plus", "psn"] },
  { name: "Nintendo", category: "gaming", color: "#e60012", domain: "nintendo.com", keywords: ["nintendo switch online", "switch online"] },
  { name: "Discord", category: "gaming", color: "#5865f2", icon: "discord", domain: "discord.com", keywords: ["discord nitro"] },
  { name: "EA", category: "gaming", color: "#000000", icon: "ea", domain: "ea.com", keywords: ["ea play", "electronic arts"] },
  { name: "Nvidia", category: "gaming", color: "#76b900", icon: "nvidia", domain: "nvidia.com", keywords: ["geforce now", "geforce"] },

  // ── Education ───────────────────────────────────────────────────────
  { name: "Duolingo", category: "education", color: "#58cc02", icon: "duolingo", domain: "duolingo.com", keywords: [] },
  { name: "Coursera", category: "education", color: "#0056d2", icon: "coursera", domain: "coursera.org", keywords: [] },
  { name: "Udemy", category: "education", color: "#a435f0", icon: "udemy", domain: "udemy.com", keywords: [] },
  { name: "Khan Academy", category: "education", color: "#14bf96", icon: "khanacademy", domain: "khanacademy.org", keywords: ["khan"] },
  { name: "Skillshare", category: "education", color: "#002333", icon: "skillshare", domain: "skillshare.com", keywords: [] },
  { name: "MasterClass", category: "education", color: "#000000", domain: "masterclass.com", keywords: [] },

  // ── Finance / Creators ──────────────────────────────────────────────
  { name: "YNAB", category: "finance", color: "#0033ff", domain: "ynab.com", keywords: ["you need a budget"] },
  { name: "Patreon", category: "finance", color: "#ff5900", icon: "patreon", domain: "patreon.com", keywords: [] },

  // ── Utilities / Security ────────────────────────────────────────────
  { name: "NordVPN", category: "utilities", color: "#4687ff", icon: "nordvpn", domain: "nordvpn.com", keywords: ["vpn"] },
  { name: "ExpressVPN", category: "utilities", color: "#da3940", icon: "expressvpn", domain: "expressvpn.com", keywords: ["vpn"] },
  { name: "Mullvad", category: "utilities", color: "#44475a", icon: "mullvad", domain: "mullvad.net", keywords: ["mullvad vpn"] },
  { name: "Bitwarden", category: "utilities", color: "#175ddc", icon: "bitwarden", domain: "bitwarden.com", keywords: ["password"] },

  // ── News / Reading ──────────────────────────────────────────────────
  { name: "New York Times", category: "news", color: "#000000", icon: "newyorktimes", domain: "nytimes.com", keywords: ["nyt"] },
  { name: "Medium", category: "news", color: "#000000", icon: "medium", domain: "medium.com", keywords: [] },
  { name: "Substack", category: "news", color: "#ff6719", icon: "substack", domain: "substack.com", keywords: [] },

  // ── Health / Fitness ────────────────────────────────────────────────
  { name: "Calm", category: "health", color: "#3653b3", domain: "calm.com", keywords: ["meditation"] },
  { name: "Headspace", category: "health", color: "#f47d20", icon: "headspace", domain: "headspace.com", keywords: ["meditation"] },
  { name: "Strava", category: "health", color: "#fc5200", icon: "strava", domain: "strava.com", keywords: [] },
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
