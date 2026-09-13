/**
 * Vocal language as a first-class serving attribute.
 *
 * ADR-0009 deliberately refused to model language, on the reasoning that fixing
 * seed coverage would let a measured ~18% Chinese taste surface on its own with
 * no language-aware code. That was the right call for the bug it faced — the
 * pool really was mis-sourced upstream — but it left the system unable to
 * *measure* what it was doing. Availability, exposure and acceptance per
 * language are all invisible without a label, so "Chinese never appears" and
 * "Chinese appears and is always skipped" are indistinguishable, and neither
 * can be learned from.
 *
 * This module adds the label and the learned mix. It does not add a quota:
 * ADR-0009's rejection of a hardcoded one-third split still stands, and the
 * targets here are learned from deliberate positive behaviour with a floor that
 * protects minority interests rather than freezing a ratio.
 *
 * Inference rules, stated as constraints rather than heuristics:
 *
 *   - Evidence is weighted by how much it actually narrows the answer, and the
 *     resulting confidence is carried forward rather than discarded. Kana is
 *     near-decisive; Han leaves a real Chinese/Japanese ambiguity; Latin script
 *     barely narrows anything, since most of the world writes in it. A weak
 *     signal therefore produces a LOW-CONFIDENCE label, not a false certainty.
 *   - Confidence gates use differ. A merely-probable label may balance a slate;
 *     only a corroborated or near-decisive one may train the long-term target,
 *     because a wrong learned target reinforces itself.
 *   - Artist identity, region and a genre tag are proxies, never sufficient on
 *     their own: `j-pop` contributes evidence and cannot by itself carry a
 *     track past the learning threshold.
 *   - `instrumental` and `unknown` are real answers. Forcing every track into
 *     zh/ja/en manufactures data that later looks like preference.
 */

export type VocalLanguage =
  | "zh"
  | "ja"
  | "en"
  | "ko"
  | "other"
  | "instrumental"
  | "unknown";

/** Languages we actively balance. `unknown`/`instrumental` are not targets. */
export const TARGET_LANGUAGES: readonly VocalLanguage[] = ["zh", "ja", "en", "ko", "other"];

export type EvidenceSource = "script" | "tag" | "declared" | "channel";

export interface LanguageEvidence {
  source: EvidenceSource;
  language: VocalLanguage;
  /** Contribution toward the confidence total. */
  weight: number;
  /** Human-readable reason, kept so a label is always inspectable. */
  note: string;
}

export interface LanguageLabel {
  language: VocalLanguage;
  /** 0..1. Below `MIN_CONFIDENCE` the label is forced to `unknown`. */
  confidence: number;
  evidence: LanguageEvidence[];
}

/**
 * Two thresholds, because the two uses tolerate different error rates.
 *
 * Balancing a slate with a merely-probable label costs little — the worst case
 * is a slightly off mix. LEARNING a long-term taste target from the same label
 * is different: a wrong label there becomes a self-reinforcing target, so it
 * demands corroboration or a near-decisive script.
 */
export const MIN_CONFIDENCE = 0.5;
export const LEARNING_CONFIDENCE = 0.65;

const HIRAGANA = /[぀-ゟ]/;
const KATAKANA = /[゠-ヿ]/;
const HANGUL = /[가-힯ᄀ-ᇿ]/;
const HAN = /[一-鿿㐀-䶿]/;
const CYRILLIC = /[Ѐ-ӿ]/;
const THAI = /[฀-๿]/;
const LATIN_WORD = /[A-Za-z]{2,}/;

const INSTRUMENTAL_HINTS = [
  "instrumental",
  "off vocal",
  "offvocal",
  "karaoke",
  "backing track",
  "inst.",
  "(inst)",
  "bgm",
  "no vocal",
];

/** Genre tags that carry a language implication, and how strongly. */
const TAG_LANGUAGE: Record<string, { language: VocalLanguage; weight: number }> = {
  // Deliberately mid-weight: a genre is a scene, not a lyric language. A J-pop
  // tag on a kanji-only title should tip it to Japanese; on its own it must not.
  "j-pop": { language: "ja", weight: 0.45 },
  "k-pop": { language: "ko", weight: 0.45 },
  latin: { language: "other", weight: 0.25 },
  classical: { language: "instrumental", weight: 0.2 },
  ambient: { language: "instrumental", weight: 0.2 },
  "lo-fi": { language: "instrumental", weight: 0.15 },
};

export interface LanguageInput {
  title: string;
  channel?: string;
  /** Constrained-vocabulary tags from `tags.ts`, when cached. */
  tags?: readonly string[];
  /** A label supplied by a trustworthy upstream source, if one ever exists. */
  declared?: VocalLanguage | null;
}

function scriptEvidence(text: string): LanguageEvidence[] {
  const evidence: LanguageEvidence[] = [];
  const hasKana = HIRAGANA.test(text) || KATAKANA.test(text);
  const hasHan = HAN.test(text);

  // Weights are calibrated to how much each script actually narrows the answer,
  // which is very different per script. This is the part that must not be
  // flattened into "script is one signal": kana all but settles it, Han leaves
  // a real Chinese/Japanese ambiguity, and Latin barely narrows anything.
  if (hasKana) {
    // No other language uses kana.
    evidence.push({ source: "script", language: "ja", weight: 0.75, note: "kana in title" });
  } else if (hasHan) {
    // Genuinely ambiguous: Japanese titles are routinely kanji-only. Weighted
    // to label, but low enough that a corroborating tag moves the confidence.
    evidence.push({ source: "script", language: "zh", weight: 0.6, note: "Han script, no kana" });
  }
  if (HANGUL.test(text)) {
    evidence.push({ source: "script", language: "ko", weight: 0.75, note: "hangul in title" });
  }
  if (CYRILLIC.test(text) || THAI.test(text)) {
    evidence.push({ source: "script", language: "other", weight: 0.6, note: "non-CJK, non-Latin script" });
  }
  if (!hasKana && !hasHan && !HANGUL.test(text) && LATIN_WORD.test(text)) {
    // The weakest signal in the set: most of the world's languages use Latin
    // script. It clears the serving threshold and not the learning one, which
    // is exactly the confidence it deserves.
    evidence.push({ source: "script", language: "en", weight: 0.45, note: "Latin-only title" });
  }
  return evidence;
}

/**
 * Label one track. Returns `unknown` whenever the evidence does not clear
 * `MIN_CONFIDENCE` — an honest absence, not a guess.
 */
export function inferLanguage(input: LanguageInput): LanguageLabel {
  const title = input.title ?? "";
  const haystack = `${title} ${input.channel ?? ""}`.toLowerCase();
  const evidence: LanguageEvidence[] = [];

  if (input.declared) {
    evidence.push({
      source: "declared",
      language: input.declared,
      weight: 0.9,
      note: "declared upstream",
    });
  }

  if (INSTRUMENTAL_HINTS.some((hint) => haystack.includes(hint))) {
    evidence.push({
      source: "script",
      language: "instrumental",
      weight: 0.65,
      note: "instrumental marker in title",
    });
  }

  evidence.push(...scriptEvidence(title));

  for (const tag of input.tags ?? []) {
    const mapped = TAG_LANGUAGE[tag];
    if (mapped) {
      evidence.push({
        source: "tag",
        language: mapped.language,
        weight: mapped.weight,
        note: `tag:${tag}`,
      });
    }
  }

  if (evidence.length === 0) {
    return { language: "unknown", confidence: 0, evidence };
  }

  const totals = new Map<VocalLanguage, number>();
  for (const item of evidence) {
    totals.set(item.language, (totals.get(item.language) ?? 0) + item.weight);
  }

  let best: VocalLanguage = "unknown";
  let bestWeight = 0;
  let runnerUp = 0;
  for (const [language, weight] of totals) {
    if (weight > bestWeight) {
      runnerUp = bestWeight;
      bestWeight = weight;
      best = language;
    } else if (weight > runnerUp) {
      runnerUp = weight;
    }
  }

  // Contested evidence lowers confidence: two sources pointing different ways
  // is precisely the case where a confident label would be a fabrication.
  const margin = bestWeight - runnerUp;
  const confidence = Math.min(1, bestWeight * 0.9 + margin * 0.3);
  if (confidence < MIN_CONFIDENCE) {
    return { language: "unknown", confidence, evidence };
  }
  return { language: best, confidence, evidence };
}

/** A positive listening event reduced to what language learning needs. */
export interface LanguageObservation {
  language: VocalLanguage;
  at: number;
  /** How strong a positive this was, 0..1. Autoplay should arrive pre-damped. */
  weight: number;
}

export interface LanguageMixOptions {
  now: number;
  /** Horizon for durable taste. */
  longDays?: number;
  /** Horizon for the listener's current phase. */
  recentDays?: number;
  /** Weight given to the recent horizon when blending. */
  recentShare?: number;
  /**
   * Minimum share preserved for any language with sustained accepted evidence.
   * This is the anti-erasure rule: a dominant language must not be able to
   * squeeze a real minority interest to zero (Steck, 2018 — accuracy-optimal
   * ranking represents only the largest interest).
   */
  minorityFloor?: number;
  /** Observations needed before a language qualifies for the floor. */
  minorityEvidence?: number;
}

const DAY = 86_400_000;

/**
 * Learn a soft per-language target from deliberate positive behaviour.
 *
 * Two horizons, blended: a long one so an established minority taste survives a
 * quiet fortnight, and a short one so a genuine shift in what the listener is
 * reaching for is reflected within days. Returns shares summing to 1 over the
 * languages with evidence; an empty history returns an empty map, which callers
 * must treat as "no opinion" rather than "no interest".
 */
export function learnLanguageMix(
  observations: readonly LanguageObservation[],
  options: LanguageMixOptions,
): Map<VocalLanguage, number> {
  const {
    now,
    longDays = 90,
    recentDays = 14,
    recentShare = 0.4,
    minorityFloor = 0.08,
    minorityEvidence = 3,
  } = options;

  const long = new Map<VocalLanguage, number>();
  const recent = new Map<VocalLanguage, number>();
  const counts = new Map<VocalLanguage, number>();

  for (const observation of observations) {
    if (!TARGET_LANGUAGES.includes(observation.language)) continue;
    const ageDays = (now - observation.at) / DAY;
    if (ageDays < 0 || ageDays > longDays) continue;
    long.set(observation.language, (long.get(observation.language) ?? 0) + observation.weight);
    counts.set(observation.language, (counts.get(observation.language) ?? 0) + 1);
    if (ageDays <= recentDays) {
      recent.set(observation.language, (recent.get(observation.language) ?? 0) + observation.weight);
    }
  }

  if (long.size === 0) return new Map();

  const normalise = (source: Map<VocalLanguage, number>): Map<VocalLanguage, number> => {
    const total = [...source.values()].reduce((sum, value) => sum + value, 0);
    if (total <= 0) return new Map();
    return new Map([...source].map(([language, value]) => [language, value / total]));
  };

  const longShare = normalise(long);
  const recentShareMap = normalise(recent);
  const blended = new Map<VocalLanguage, number>();
  for (const language of new Set([...longShare.keys(), ...recentShareMap.keys()])) {
    const lo = longShare.get(language) ?? 0;
    const re = recentShareMap.get(language) ?? 0;
    // With no recent evidence the long-term share carries the language on its
    // own, so a fortnight of English does not erase a year of Mandarin.
    const value = recentShareMap.size === 0 ? lo : lo * (1 - recentShare) + re * recentShare;
    blended.set(language, value);
  }

  // Anti-erasure floor, applied only where the evidence is real.
  for (const [language, count] of counts) {
    if (count >= minorityEvidence && (blended.get(language) ?? 0) < minorityFloor) {
      blended.set(language, minorityFloor);
    }
  }

  return normalise(blended);
}

/**
 * How well a candidate's language serves the learned mix *given what has
 * already been placed*. Positive when a language is under-served, negative when
 * it is over-served. Soft by construction: this biases selection, it never
 * filters, so relevance can still win.
 */
export function languageFit(
  language: VocalLanguage,
  target: ReadonlyMap<VocalLanguage, number>,
  placed: ReadonlyMap<VocalLanguage, number>,
  slots: number,
): number {
  if (target.size === 0 || slots <= 0) return 0;
  if (language === "unknown" || language === "instrumental") return 0;
  const wanted = target.get(language) ?? 0;
  const placedCount = placed.get(language) ?? 0;
  const deficit = wanted - placedCount / slots;
  return Math.max(-1, Math.min(1, deficit * 2));
}

/**
 * Distribution of labels across a set of tracks, for the funnel diagnostics.
 * Reported at every stage (candidate → ranked → exposed → accepted) so a loss
 * can be attributed to metadata, retrieval, ranking or the listener.
 */
export function languageBreakdown(
  labels: readonly VocalLanguage[],
): Map<VocalLanguage, number> {
  const counts = new Map<VocalLanguage, number>();
  for (const language of labels) {
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return counts;
}
