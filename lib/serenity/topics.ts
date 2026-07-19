import type { NameView, SerenityTheme, Topic } from "./types";

/**
 * The post topic taxonomy (19 areas, from the user's two reference images + their
 * renaming rules). Used to categorize + filter Serenity's X posts. The universe
 * themes (SerenityTheme) are a subset of these (the hardware/AI ones) and share
 * their names, so a tweet's tickers map straight to topics via the universe.
 */
export const TOPICS: Topic[] = [
  "Mega-Cap Tech & Semiconductors",
  "Memory, Storage & Servers",
  "Optics / Silicon Photonics",
  "Advanced Packaging & Semicap",
  "Networking",
  "Data Center & Cloud",
  "Energy, Nuclear & Battery",
  "Rare Earth Materials",
  "Drones & Airbus",
  "Space & Satellites",
  "Robot / Humanoid",
  "Quantum",
  "Fintech & Crypto",
  "SaaS",
  "Medical / Healthcare",
  "Cybersecurity",
  "Meme",
  "Core / Keystone",
  "Macro & Market Analysis",
];

/** Universe theme → post topic (the 8 universe themes are a subset of the 19). */
export function themeToTopic(theme: SerenityTheme): Topic {
  // Names were aligned in the rename, so the universe theme IS the topic for the
  // 8 hardware themes; everything else maps onto the closest taxonomy bucket.
  switch (theme) {
    case "Optics / Silicon Photonics":
      return "Optics / Silicon Photonics";
    case "Memory, Storage & Servers":
      return "Memory, Storage & Servers";
    case "Advanced Packaging & Semicap":
      return "Advanced Packaging & Semicap";
    case "Energy, Nuclear & Battery":
      return "Energy, Nuclear & Battery";
    case "Data Center & Cloud":
      return "Data Center & Cloud";
    case "Drones & Airbus":
      return "Drones & Airbus";
    case "Space & Satellites":
      return "Space & Satellites";
    case "Robot / Humanoid":
      return "Robot / Humanoid";
    case "Fintech & Crypto":
      return "Fintech & Crypto";
    default:
      return "Mega-Cap Tech & Semiconductors";
  }
}

// Keyword rules for the topics NOT fully covered by ticker→theme (software, macro,
// materials, etc.). First match per topic wins; a post can match several.
const KEYWORD_RULES: { topic: Topic; re: RegExp }[] = [
  { topic: "Optics / Silicon Photonics", re: /photon|optical|laser|\binp\b|co-packaged|\bcpo\b|transceiv|silicon photonic|waveguide|dfb|lumentum|aaoi|\blite\b/i },
  { topic: "Memory, Storage & Servers", re: /memory|\bdram\b|\bnand\b|\bhbm\b|micron|hynix|sandisk|\bsndk\b|\bmu\b|storage|ssd|server rack/i },
  { topic: "Advanced Packaging & Semicap", re: /packag|\bosat\b|amkor|towe|towa|glass.?core|interpos|\bxfab\b|tower semi|substrate|metrology|aehr/i },
  { topic: "Networking", re: /network|switch|router|\bbroadcom\b|\bmarvell\b|mrvl|astera|alab|ethernet|infiniband|400g|800g/i },
  { topic: "Data Center & Cloud", re: /data.?center|neocloud|hyperscaler|coreweave|\bnbis\b|cloud|aws|azure|\bgcp\b|stargate/i },
  { topic: "Mega-Cap Tech & Semiconductors", re: /nvidia|\bnvda\b|jensen|tesla|apple|\baapl\b|google|alphabet|\bgoogl\b|\bmeta\b|amd|\barm\b|tsm|\btsmc\b|intel|\bintc\b|jensen huang|gpu|cpu|accelerator|rubin|blackwell/i },
  { topic: "Energy, Nuclear & Battery", re: /power|grid|nuclear|reactor|smr|uranium|battery|ev battery|gallium nitride|\bgan\b|silicon carbid|\bsic\b|\bxlu\b|transformer|data.?center power|energy/i },
  { topic: "Rare Earth Materials", re: /rare earth|稀土|gallium|germanium|lithium|cobalt|nickel|graphite|tungsten|magnesium|materials|mining/i },
  { topic: "Drones & Airbus", re: /drone|uav|aerial|airbus|boeing|aerovironment|\bavav\b|defense platform|fighter|aircraft/i },
  { topic: "Space & Satellites", re: /space|satellite|rocket|rocket lab|\brklb\b|ast space|\basts\b|blue origin|starlink|orbit|spacex/i },
  { topic: "Robot / Humanoid", re: /robot|humanoid|agility|apptronik|boston dynamics|atlas|optimus|actuator|harmonic|\bfigure ai\b|1x|\btesla optimus\b/i },
  { topic: "Quantum", re: /quantum|qubit|ionq|\brgti\b|d-wave|rigetti|\bqs\b/i },
  { topic: "Fintech & Crypto", re: /crypto|bitcoin|\bbtc\b|ethereum|coinbase|\bcoin\b|fintech|\bhood\b|robinhood|circle|\bcrcl\b|stablecoin|defi/i },
  { topic: "SaaS", re: /\bsaas\b|cloud software|enterprise software|crm|snowflake|databricks|palantir|plt/i },
  { topic: "Medical / Healthcare", re: /biotech|pharma|fda|clinical|drug|medical|healthcare|medtech|diagnostic|medicube/i },
  { topic: "Cybersecurity", re: /cyber|security|crowdstrike|\bcrwd\b|palo alto|sentinelone|zero trust/i },
  { topic: "Meme", re: /\bmeme\b|gamestop|\bgme\b|amc|\bdog\b|doge|shib|wallstreetbets|wsb/i },
  { topic: "Macro & Market Analysis", re: /market|selloff|sell.?off|rally|\bdip\b|drawdown|crash|correction|\bfed\b|interest rate|\bcpi\b|inflation|recession|tariff|macro|sentiment|valuation|\bpe\b multiple|earnings|guidance|bull market|bear market|capitulation/i },
];

/**
 * Deterministic topic tagging — the always-on, no-LLM baseline. Combines:
 *  - ticker → universe theme → topic (the strongest signal)
 *  - keyword rules over the post text (covers software / macro / materials)
 *  - "Core / Keystone" when a mentioned ticker is one of his anchor holdings
 * Always returns at least one topic (defaults to Macro & Market Analysis).
 */
export function tagTweetTopics(
  text: string,
  tickers: string[],
  byTicker: Map<string, NameView>,
): Topic[] {
  const out = new Set<Topic>();

  for (const tk of tickers) {
    const v = byTicker.get(tk.toUpperCase());
    if (v) {
      out.add(themeToTopic(v.theme));
      if (v.core) out.add("Core / Keystone");
    }
  }

  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(text)) out.add(rule.topic);
  }

  if (out.size === 0) out.add("Macro & Market Analysis");
  // Preserve the canonical TOPICS order for stable display.
  return TOPICS.filter((t) => out.has(t));
}
