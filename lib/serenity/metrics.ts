import type { Centrality, Rating, SerenityName, SerenityTheme } from "./types";

/**
 * Pure metric remap + theme classification.
 *
 * The source's two technical per-name signals are reframed into vocabulary a
 * normal investor already knows (see types.ts):
 *   - `conviction` (0–10)        → Rating (Strong Buy / Buy / Hold / Watch)
 *   - `centrality` (CORE/…)      → Core flag (⭐ on his anchor holdings)
 * Kept side-effect-free so it's trivially testable (mirrors lib/domain purity).
 */

// ── Rating (rebrand of 0–10 conviction → analyst-style recommendation) ─────────────────
export function rating(conviction: number): Rating {
  const c = Math.max(0, Math.min(10, conviction || 0));
  if (c >= 9) return "Strong Buy";
  if (c >= 7) return "Buy";
  if (c >= 5) return "Hold";
  return "Watch";
}

// ── Core holding (rebrand of centrality → "is this one of his anchors?") ───────────────
// Only the most central names (CORE in his thesis graph) get the ⭐ — a small,
// curated set of foundational positions, not a 4-tier ladder.
export function isCoreHolding(centrality: Centrality): boolean {
  return centrality === "CORE";
}

// ── US-investable filter ───────────────────────────────────────────────────────────────
// US-listed names, plus the handful of foreign names that trade US as ADRs /
// listings that a US retail investor can actually buy. Region alone misses these.
const US_ADR_TICKERS = new Set<string>([
  "SIVE", // Sivers → US OTC (SIVEF)
  "IQE", // IQE plc → US OTC (IQEF)
  "LPK", // LPKF → US OTC (LKFXF)
  "ASX", // ASE Group (Taiwan) → US ADR (ASX)
  "TSM", // Taiwan Semi → US ADR
  "SKHY", // SK Hynix → US-listed ADR (site uses SKHY)
  "ARM", // Arm Holdings → US-listed (NASDAQ)
  "SIVEF",
]);

export function isUsInvestable(name: { region: string; ticker: string }): boolean {
  return name.region === "US" || US_ADR_TICKERS.has(name.ticker);
}

// ── Theme classification ───────────────────────────────────────────────────────────────
// The source resolves each theme panel's tickers client-side (RSC `$L` refs), so the
// theme→ticker mapping is not in the static payload. We classify each name into one of
// the site's own seven themes from its company + thesis text. Priority order matters:
// photonics first (his flagship, most specific vocabulary), then down to the catch-all.
const THEME_RULES: { theme: SerenityTheme; re: RegExp }[] = [
  {
    theme: "Optics / Silicon Photonics",
    re: /photon|optical|laser|\binp\b|indium phosphid|co-packaged|\bcpo\b|transceiv|waveguide|\bdfb\b|silicon photonic|\bgaas\b|epiwafer|epitax|soitec|\biqe\b|axt[^a-z]|sive|aaoi|\blite\b|cohr|lumentum|aehr|\blpk\b|poet|ayar|lightmatter|lpth|\bflnc\b| fibre|fiber optic|semicap test/i,
  },
  {
    theme: "Memory, Storage & Servers",
    re: /memory|\bdram\b|\bnand\b|\bhbm\b|micron|hynix|samsung|sandisk|\bsndk\b|\bmu\b|win semi|nextronic|\b8147\b|2344|2337|supercycle|storage|ssd/i,
  },
  {
    theme: "Advanced Packaging & Semicap",
    re: /packag|\bosat\b|amkor|towe|towa|glass.?core|interpos|advanced pack|\bxfab\b|tower semi|shunsin|\b6451\b|\b6830\b|\b3363\b|foci|substrate|foundry|test & metro|metrology|\bmsscorp/i,
  },
  {
    theme: "Energy, Nuclear & Battery",
    re: /power|grid|nuclear|reactor|smr|uranium|battery|gallium nitride|\bgan\b|silicon carbid|\bsic\b|\bxlu\b|copper|\bamsc\b|hammond|\bhps\b|energy|utilit|transform|switchgear/i,
  },
  {
    theme: "Data Center & Cloud",
    re: /neocloud|gpu cloud|coreweave|\bnbis\b|hyperscaler|data.?center|cloud|\barm\b|\bmeta\b|\bgoogl\b|alphabet|stargate|\btsm\b|taiwan semi/i,
  },
  {
    theme: "Space & Satellites",
    re: /space|satellite|rocket|rocket lab|\brklb\b|ast space|\basts\b|blue origin|starlink|orbit|spacex|anduril/i,
  },
  {
    theme: "Drones & Airbus",
    re: /drone|uav|aerial|airbus|boeing|aerovironment|\bavav\b|fighter|aircraft|defense/i,
  },
  {
    theme: "Robot / Humanoid",
    re: /robot|humanoid|agility|apptronik|boston dynamics|atlas|optimus|actuator|harmonic drive|\bfigure ai\b/i,
  },
  {
    theme: "Fintech & Crypto",
    re: /crypto|bitcoin|ethereum|fintech|coinbase|\bcoin\b|reddit|\brddt\b|circle|\bcrcl\b|\bhood\b|robinhood|bank|insurance|compounder|stablecoin|defi/i,
  },
];

const FALLBACK_THEME: SerenityTheme = "Optics / Silicon Photonics";

export function classifyTheme(name: SerenityName): SerenityTheme {
  const blob = `${name.ticker} ${name.company} ${name.thesisSummary}`;
  for (const rule of THEME_RULES) {
    if (rule.re.test(blob)) return rule.theme;
  }
  return FALLBACK_THEME;
}

// ── Stance helpers (for the bullish filter on the posts + opportunity feeds) ───────────
export function isBullish(stance: string): boolean {
  return stance === "BULLISH";
}
