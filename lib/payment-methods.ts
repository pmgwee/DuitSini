/**
 * Payment-method catalog + helpers.
 *
 * A "payment method" is the instrument a subscription is charged to — a credit
 * card, debit card, FPX (Malaysian online-banking) account, or e-wallet. The
 * user owns a small, fixed set of these (see the `payment_methods` table); this
 * module is the *catalog* of recognized issuers (banks / digital banks /
 * e-wallets) and card networks, plus the BIN-based card-network detection used
 * by the card-number field.
 *
 * Conventions mirror `lib/providers.ts` (the subscription-provider catalog):
 * each issuer carries up to three logo sources in priority order — `logoUrl`
 * (curated /public/logos/* file) → `icon` (Simple Icons slug) → `domain`
 * (favicon fallback) → monogram — resolved at render time with onError advance.
 * Almost every Malaysian bank/e-wallet is absent from Simple Icons, so most
 * entries lean on `domain` (Google-favicon fallback) and/or a curated `logoUrl`.
 */

// ─── Kinds ────────────────────────────────────────────────────────────────
export const PAYMENT_KINDS = [
  "credit_card",
  "debit_card",
  "fpx",
  "e_wallet",
  "other",
] as const;

export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/**
 * Which issuer list a kind draws from.
 * - "bank"   → cards + FPX pick from banks/digital banks (anything not a wallet)
 * - "wallet" → e-wallets pick from wallets only
 * - "any"    → "other" may pick anything (or nothing)
 */
export type IssuerGroup = "bank" | "wallet" | "any";

export interface PaymentKindMeta {
  label: string;
  /** Compact label for tight badges (e.g. the row pill). */
  short: string;
  colorVar: string;
  emoji: string;
  /** Card kinds carry a network + last4. */
  isCard: boolean;
  issuerGroup: IssuerGroup;
}

export const PAYMENT_KIND_META: Record<PaymentKind, PaymentKindMeta> = {
  credit_card: { label: "Credit card", short: "Credit", colorVar: "var(--pm-card)", emoji: "💳", isCard: true, issuerGroup: "bank" },
  debit_card: { label: "Debit card", short: "Debit", colorVar: "var(--pm-card)", emoji: "💳", isCard: true, issuerGroup: "bank" },
  fpx: { label: "Online banking (FPX)", short: "FPX", colorVar: "var(--pm-fpx)", emoji: "🏦", isCard: false, issuerGroup: "bank" },
  e_wallet: { label: "E-wallet", short: "E-wallet", colorVar: "var(--pm-ewallet)", emoji: "📱", isCard: false, issuerGroup: "wallet" },
  other: { label: "Other", short: "Other", colorVar: "var(--pm-other)", emoji: "💸", isCard: false, issuerGroup: "any" },
};

/**
 * Literal oklch mirror of the `--pm-*` CSS tokens in globals.css, for contexts
 * that need a real color value instead of a CSS var (e.g. Recharts `<Cell fill>`,
 * SVG). Keep in sync with the tokens.
 */
export const PAYMENT_KIND_COLOR: Record<PaymentKind, string> = {
  credit_card: "oklch(0.72 0.13 275)",
  debit_card: "oklch(0.72 0.13 275)",
  fpx: "oklch(0.7 0.12 195)",
  e_wallet: "oklch(0.74 0.15 150)",
  other: "oklch(0.72 0.02 265)",
};

// ─── Issuers (banks + digital banks + e-wallets) ──────────────────────────
export type IssuerType =
  | "traditional_bank"
  | "digital_bank"
  | "foreign_bank"
  | "intl_digital_bank"
  | "e_wallet";

export interface PaymentIssuer {
  /** Canonical id stored on `payment_methods.issuer_slug`. */
  slug: string;
  label: string;
  type: IssuerType;
  /** Brand accent (hex) — monogram background + fallback ring. */
  color: string;
  /** Curated local logo (/public/logos/...) — FIRST tier. */
  logoUrl?: string;
  /** Simple Icons slug — SECOND tier (rare for MY brands). */
  icon?: string;
  /** Website domain — favicon fallback, THIRD tier. */
  domain?: string;
  /** Aliases so "m2u" finds "Maybank", etc. */
  keywords?: string[];
}

export const PAYMENT_ISSUERS: PaymentIssuer[] = [
  // ── Malaysian traditional banks ───────────────────────────────────────
  { slug: "maybank", label: "Maybank", type: "traditional_bank", color: "#0a2a66", domain: "maybank2u.com.my", keywords: ["malayan banking", "m2u", "m2u pay", "maybank2u"] },
  { slug: "cimb", label: "CIMB Bank", type: "traditional_bank", color: "#122e6e", domain: "cimb.com.my", keywords: ["cimb clicks", "cimb bank"] },
  { slug: "public_bank", label: "Public Bank", type: "traditional_bank", color: "#0072bb", logoUrl: "/logos/public-bank.png", domain: "pbebank.com", keywords: ["public bank berhad", "pbe", "pb engage"] },
  { slug: "rhb", label: "RHB Bank", type: "traditional_bank", color: "#005d7e", domain: "rhbgroup.my", keywords: ["rhb bank", "rhb now"] },
  { slug: "hong_leong", label: "Hong Leong Bank", type: "traditional_bank", color: "#e60012", domain: "hlb.com.my", keywords: ["hong leong", "hlb", "hlb connect"] },
  { slug: "ambank", label: "AmBank", type: "traditional_bank", color: "#6a1f9d", domain: "ambankgroup.com", keywords: ["am bank", "ambank online"] },
  { slug: "bank_islam", label: "Bank Islam", type: "traditional_bank", color: "#006a4e", domain: "bankislam.com", keywords: ["bank islam malaysia"] },
  { slug: "bank_rakyat", label: "Bank Rakyat", type: "traditional_bank", color: "#e2231a", domain: "bankrakyat.com.my", keywords: ["bank kerjasama rakyat"] },
  { slug: "affin", label: "Affin Bank", type: "traditional_bank", color: "#003a78", domain: "affinbank.com.my", keywords: ["affin bank", "affin2u"] },
  { slug: "alliance", label: "Alliance Bank", type: "traditional_bank", color: "#c8102e", domain: "alliancefg.com", keywords: ["alliance bank", "aob"] },
  { slug: "bsn", label: "BSN", type: "traditional_bank", color: "#f37021", domain: "bsn.com.my", keywords: ["bank simpanan nasional"] },
  { slug: "agrobank", label: "Agro Bank", type: "traditional_bank", color: "#007a45", domain: "agrobank.gov.my", keywords: ["agro bank", "agrobank"] },
  { slug: "bank_muamalat", label: "Bank Muamalat", type: "traditional_bank", color: "#006341", domain: "bankmuamalat.com.my", keywords: ["bank muamalat malaysia"] },

  // ── Foreign banks in Malaysia ─────────────────────────────────────────
  { slug: "hsbc", label: "HSBC", type: "foreign_bank", color: "#db0011", domain: "hsbc.com.my", keywords: ["hsbc malaysia"] },
  { slug: "standard_chartered", label: "Standard Chartered", type: "foreign_bank", color: "#16697a", domain: "sc.com", keywords: ["scb malaysia", "stanchart"] },
  { slug: "ocbc", label: "OCBC Bank", type: "foreign_bank", color: "#d31145", domain: "ocbc.com.my", keywords: ["ocbc malaysia"] },
  { slug: "uob", label: "UOB", type: "foreign_bank", color: "#00359f", domain: "uob.com.my", keywords: ["united overseas bank", "uob malaysia"] },
  { slug: "citibank", label: "Citibank", type: "foreign_bank", color: "#003b70", domain: "citibank.com.my", keywords: ["citi malaysia"] },
  { slug: "boc", label: "Bank of China (M)", type: "foreign_bank", color: "#a8121f", domain: "boc.my", keywords: ["bank of china malaysia"] },
  { slug: "kfhl", label: "Kuwait Finance House", type: "foreign_bank", color: "#007a33", domain: "kfh.com.my", keywords: ["kfh malaysia", "kfh"] },

  // ── Malaysian digital banks (5 BNM licensees) ─────────────────────────
  { slug: "gx_bank", label: "GX Bank", type: "digital_bank", color: "#7c1d6f", domain: "gxbank.com.my", keywords: ["gxbank"] },
  { slug: "boost_bank", label: "Boost Bank", type: "digital_bank", color: "#f7941d", domain: "myboost.com.my", keywords: ["boost bank"] },
  { slug: "aeon_bank", label: "AEON Bank", type: "digital_bank", color: "#d50032", domain: "aeonbank.com.my", keywords: ["aeon bank malaysia"] },
  { slug: "kaf_digital", label: "KAF Digital Bank", type: "digital_bank", color: "#0d4d3a", domain: "kafdigitalbank.com", keywords: ["kaf digital", "kaf"] },
  { slug: "ryt_bank", label: "Ryt Bank", type: "digital_bank", color: "#0a5cae", domain: "rytbank.com.my", keywords: ["ryt bank", "ytl bank", "sea bank"] },

  // ── International digital bank ────────────────────────────────────────
  { slug: "wise", label: "Wise", type: "intl_digital_bank", color: "#163300", domain: "wise.com", keywords: ["wise malaysia", "transferwise"] },

  // ── Malaysian e-wallets ───────────────────────────────────────────────
  { slug: "tng_ewallet", label: "Touch 'n Go eWallet", type: "e_wallet", color: "#009a44", domain: "tngdigital.com.my", keywords: ["tng ewallet", "tng", "touch n go", "touch and go"] },
  { slug: "shopeepay", label: "ShopeePay", type: "e_wallet", color: "#ee4d2d", domain: "shopee.com.my", keywords: ["shopee pay"] },
  { slug: "lazada_wallet", label: "Lazada Wallet", type: "e_wallet", color: "#1368aa", domain: "lazada.com.my", keywords: ["lazada wallet"] },
  { slug: "grabpay", label: "GrabPay", type: "e_wallet", color: "#00b14f", domain: "grab.com", keywords: ["grab pay", "grabpay wallet"] },
  { slug: "bigpay", label: "BigPay", type: "e_wallet", color: "#e60029", domain: "bigpayme.com", keywords: ["big pay"] },
  { slug: "mae", label: "MAE by Maybank", type: "e_wallet", color: "#0a2a66", domain: "mae.com.my", keywords: ["mae"] },
  { slug: "boost_wallet", label: "Boost (wallet)", type: "e_wallet", color: "#f7941d", domain: "myboost.com.my", keywords: ["boost app", "boost wallet"] },
  { slug: "setel", label: "Setel", type: "e_wallet", color: "#009a44", domain: "setel.com", keywords: ["setel", "mesra"] },
  { slug: "aeon_wallet", label: "AEON Wallet", type: "e_wallet", color: "#d50032", domain: "aeonretail.com.my", keywords: ["aeon wallet"] },
];

// ─── Lookups + search ──────────────────────────────────────────────────────
export function findIssuer(slug: string | null | undefined): PaymentIssuer | undefined {
  if (!slug) return undefined;
  return PAYMENT_ISSUERS.find((i) => i.slug === slug);
}

export function findPaymentKind(value: string | null | undefined): PaymentKind | undefined {
  if (!value) return undefined;
  return (PAYMENT_KINDS as readonly string[]).includes(value) ? (value as PaymentKind) : undefined;
}

/** Issuers selectable for a given kind (banks for cards/FPX, wallets for e-wallet). */
export function issuersForKind(kind: PaymentKind): PaymentIssuer[] {
  const group = PAYMENT_KIND_META[kind].issuerGroup;
  if (group === "bank") return PAYMENT_ISSUERS.filter((i) => i.type !== "e_wallet");
  if (group === "wallet") return PAYMENT_ISSUERS.filter((i) => i.type === "e_wallet");
  return PAYMENT_ISSUERS;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Rank issuers against a free-text query for the picker. An EMPTY query returns
 * the WHOLE list (scrolls). A typed query matches on PREFIXES / WORD BOUNDARIES
 * (never loose mid-word substrings), mirroring `searchProviderPresets`.
 */
export function searchIssuers(query: string, pool?: PaymentIssuer[], limit = 64): PaymentIssuer[] {
  const source = pool ?? PAYMENT_ISSUERS;
  const q = normalize(query);
  if (!q) return source.slice(0, limit);
  const scored: Array<{ issuer: PaymentIssuer; score: number }> = [];
  for (const issuer of source) {
    const fullName = normalize(issuer.label);
    const tokens = [...tokenize(issuer.label), ...(issuer.keywords ?? []).flatMap(tokenize)];
    let best = Infinity;
    if (fullName.startsWith(q)) best = 0;
    else if (tokens.some((t) => t.startsWith(q))) best = 1;
    if (best !== Infinity) scored.push({ issuer, score: best });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.issuer);
}
