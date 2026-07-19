import type { SerenityPost } from "./types";

/**
 * Defensive extractors for serenitytrades.com's payloads.
 *
 * The universe/performance data ships as flat JSON objects embedded inline in
 * the RSC stream; we lift them out with a string-aware brace-balanced scan
 * (handles escaped quotes inside `thesis_summary`) and let Zod (schema.ts)
 * decide what's real. The commentary feed is plain SSR HTML, so posts are
 * pulled with ordinary regexes over the rendered page.
 */

// ── HTML helpers ───────────────────────────────────────────────────────────────────────
const ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  trade: "™",
  reg: "®",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return ENTITIES[ent] ?? m;
  });
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

// ── Brace-balanced JSON object extractor ───────────────────────────────────────────────
/**
 * Find every occurrence of `marker` in `text`, walk back to its enclosing `{`,
 * then read the full balanced object (respecting string literals + escapes).
 * Returns parsed objects; unparseable slices are dropped. `marker` should match
 * a key that appears as the FIRST key of the target objects (true for both the
 * universe and holding records: `"ticker":`), so the nearest preceding `{` is
 * the object's own opening brace.
 */
export function extractObjects(text: string, marker: RegExp): object[] {
  const out: object[] = [];
  const re = new RegExp(marker.source, marker.flags.includes("g") ? marker.flags : `${marker.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    let open = -1;
    for (let i = match.index; i >= 0; i--) {
      const ch = text[i];
      if (ch === "{") {
        open = i;
        break;
      }
      if (ch === "}") break; // marker sits between objects, not inside one — skip
    }
    if (open < 0) continue; // regex auto-advances past this match
    const res = readBalancedObject(text, open);
    if (res) {
      out.push(res.obj);
      re.lastIndex = res.end; // skip past the whole object so we always progress
    }
  }
  return out;
}

function readBalancedObject(text: string, start: number): { obj: object; end: number } | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return { obj: JSON.parse(text.slice(start, i + 1)), end: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ── Commentary posts (from the SSR'd /commentary HTML) ─────────────────────────────────
/**
 * Each post is an `<h3><a href="/commentary/DATE">HEADLINE</a></h3>` followed by
 * a `<p class="muted">SUMMARY</p>` and a cluster of ticker chips (rendered as
 * `aria-label="…$TICKER…"`). We segment by headline and pull the pieces out of
 * each segment, so tickers are correctly attributed to their post.
 */
export function extractPosts(html: string): SerenityPost[] {
  const posts: SerenityPost[] = [];
  const headRe = /<h3[^>]*>\s*<a[^>]*href="\/commentary\/(\d{4}-\d{2}-\d{2})"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/g;
  const heads = [...html.matchAll(headRe)];
  for (let i = 0; i < heads.length; i++) {
    const date = heads[i][1];
    const headline = decodeEntities(stripTags(heads[i][2])).replace(/\s+/g, " ").trim();
    const segStart = (heads[i].index ?? 0) + heads[i][0].length;
    const segEnd = i + 1 < heads.length ? (heads[i + 1].index ?? html.length) : html.length;
    const seg = html.slice(segStart, segEnd);

    const sumM = seg.match(/<p[^>]*class="muted"[^>]*>([\s\S]*?)<\/p>/);
    const summary = sumM ? decodeEntities(stripTags(sumM[1])).replace(/\s+/g, " ").trim() : "";

    // Tickers come from the chip aria-labels ("$TICKER"); preserve first-seen order.
    const tickers: string[] = [];
    const seen = new Set<string>();
    for (const cm of seg.matchAll(/\$([A-Z][A-Z0-9.]{0,5})\b/g)) {
      const t = cm[1];
      if (!seen.has(t)) {
        seen.add(t);
        tickers.push(t);
      }
    }

    posts.push({ date, headline, summary, tickers, url: `/commentary/${date}` });
  }
  // Newest-first is the source order; cap to keep the payload bounded.
  return posts.slice(0, 60);
}

// ── Theme headings (sanity check against the hardcoded SERENITY_THEMES) ─────────────────
export function extractThemeHeadings(rsc: string): string[] {
  const block = rsc.split('"Themes"')[1] ?? "";
  return [...block.matchAll(/"fontSize":17\},"children":"([^"]+)"/g)].map((m) => m[1]);
}
