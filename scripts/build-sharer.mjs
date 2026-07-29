// Bundles lib/bridge/sharer/index.ts into a single self-contained .mjs template
// (ADR-0001 / ADR-0005). The output carries the four identity placeholders
// verbatim; buildMemberBridge substitutes them at request time. The artifact is
// COMMITTED to the repo; CI asserts it's fresh via check-sharer-fresh.mjs.
//
// Run: pnpm build:sharer
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "lib/bridge/sharer/index.ts");
const outDir = resolve(root, "lib/bridge/sharer/generated");
const outFile = resolve(outDir, "sharer.template.mjs");

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: outFile,
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
  // Non-minified so PR reviewers can read the exact shipped-script diff
  // (ADR-0005 §1) — this is the file members download and run.
  minify: false,
  legalComments: "none",
  logLevel: "info",
});

// Sanity: the four identity placeholders must be present in the artifact, or
// buildMemberBridge's substitution would silently no-op.
const written = await readFile(outFile, "utf8");
const required = ["__INGEST_URL__", "__PULL_URL__", "__BRIDGE_TOKEN__", "__ACCOUNT_EMAIL__"];
const missing = required.filter((p) => !written.includes(p));
if (missing.length) {
  console.error("build:sharer — placeholders missing from artifact: " + missing.join(", "));
  process.exit(1);
}
console.log(`build:sharer — wrote ${outFile} (${written.length} bytes, placeholders intact)`);
