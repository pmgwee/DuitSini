// CI freshness gate (ADR-0005 §1). Regenerates the sharer artifact in-memory and
// compares it byte-for-byte to the committed file. Fails if a sharer module
// changed without a paired `pnpm build:sharer` + commit. Run on a fresh checkout
// (where on-disk == committed).
//
// Run: pnpm check:sharer
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "lib/bridge/sharer/index.ts");
const committed = resolve(root, "lib/bridge/sharer/generated/sharer.template.mjs");

const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
  minify: false,
  legalComments: "none",
  write: false,
  logLevel: "silent",
});

const regenerated = result.outputFiles[0].text;

let committedText;
try {
  committedText = await readFile(committed, "utf8");
} catch {
  console.error("check:sharer — committed artifact not found.");
  console.error("  Run `pnpm build:sharer` and commit lib/bridge/sharer/generated/sharer.template.mjs.");
  process.exit(1);
}

if (regenerated !== committedText) {
  console.error("check:sharer — committed artifact is STALE.");
  console.error("  Run `pnpm build:sharer` and commit the regenerated file.");
  console.error(`  regenerated ${regenerated.length} bytes vs committed ${committedText.length} bytes`);
  process.exit(1);
}

console.log(`check:sharer — artifact is fresh (${committedText.length} bytes)`);
