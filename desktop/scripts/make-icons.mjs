/**
 * Generates the tray/app icons so the repo carries no opaque binary blobs that
 * nobody can regenerate. Run with `node scripts/make-icons.mjs` from `desktop/`.
 *
 * Draws the DuitSini mark: a rounded ringgit-green square with a white "D".
 * Deliberately dependency-free — a hand-rolled PNG encoder (zlib is built in)
 * beats pulling an image library into the desktop build for two files.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, "..", "assets");

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Ringgit green, matching the app's primary accent.
const FG = [16, 185, 129];

/** Rounded-square mask with a carved "D" glyph. */
function pixel(x, y, size) {
  const s = size;
  const r = s * 0.22;
  const inset = s * 0.06;
  const x0 = inset;
  const y0 = inset;
  const x1 = s - inset;
  const y1 = s - inset;

  // Outside the rounded rect → transparent.
  const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  const inside =
    x + 0.5 >= x0 && x + 0.5 <= x1 && y + 0.5 >= y0 && y + 0.5 <= y1 && dx * dx + dy * dy <= r * r + 0.01;
  if (!inside) return [0, 0, 0, 0];

  // "D": vertical stem plus an outer bowl, cut by an inner bowl.
  const gx = (x + 0.5 - x0) / (x1 - x0);
  const gy = (y + 0.5 - y0) / (y1 - y0);
  const inGlyphBox = gx > 0.26 && gx < 0.76 && gy > 0.24 && gy < 0.76;
  if (inGlyphBox) {
    const stem = gx < 0.38;
    const ny = (gy - 0.5) / 0.26;
    const nxOuter = (gx - 0.34) / 0.42;
    const nxInner = (gx - 0.34) / 0.26;
    const inOuter = nxOuter * nxOuter + ny * ny <= 1;
    const inInner = nxInner * nxInner + ny * ny <= 0.62;
    if (stem || (inOuter && !inInner)) return [255, 255, 255, 255];
  }
  return [FG[0], FG[1], FG[2], 255];
}

mkdirSync(ASSETS, { recursive: true });
for (const size of [16, 32, 256, 512]) {
  const name = size <= 32 ? (size === 16 ? "tray.png" : "tray@2x.png") : `icon-${size}.png`;
  writeFileSync(join(ASSETS, name), encodePng(size, pixel));
  console.log(`wrote assets/${name} (${size}x${size})`);
}
// electron-builder's default icon lookup.
writeFileSync(join(ASSETS, "icon.png"), encodePng(512, pixel));
console.log("wrote assets/icon.png (512x512)");
