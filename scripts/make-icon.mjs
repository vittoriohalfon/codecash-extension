// Generates apps/extension/media/icon.png — a dependency-free brand mark for the VS Code Marketplace.
// No image libraries: we render RGBA pixels (2x supersampled for anti-aliasing) and hand-encode a PNG.
// Replace media/icon.png with a designed asset any time; this just guarantees a valid, on-brand default.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SIZE = 256;
const SS = 2; // supersample factor for cheap anti-aliasing
const W = SIZE * SS;

const lerp = (a, b, t) => a + (b - a) * t;

// brand gradient (indigo → violet), white mark
const TOP = [99, 91, 255];
const BOT = [124, 58, 237];
const INK = [255, 255, 255];

// broadcast/RSS mark: origin (lower-left) + two arcs + a dot, echoing the status-bar $(rss) icon
const ox = W * 0.3,
  oy = W * 0.7;
const dot = W * 0.066;
const arcs = [W * 0.22, W * 0.36];
const thick = W * 0.052;

function markCoverage(x, y) {
  const dx = x - ox,
    dy = y - oy;
  const r = Math.hypot(dx, dy);
  if (r <= dot) return 1; // filled dot
  if (dx > 0 && dy < 0) {
    // arcs only in the upper-right quadrant
    for (const R of arcs) if (Math.abs(r - R) <= thick / 2) return 1;
  }
  return 0;
}

// render supersampled RGB
const hi = new Uint8ClampedArray(W * W * 3);
for (let y = 0; y < W; y++) {
  const t = y / (W - 1);
  const bg = [lerp(TOP[0], BOT[0], t), lerp(TOP[1], BOT[1], t), lerp(TOP[2], BOT[2], t)];
  for (let x = 0; x < W; x++) {
    const cov = markCoverage(x, y);
    const i = (y * W + x) * 3;
    hi[i] = lerp(bg[0], INK[0], cov);
    hi[i + 1] = lerp(bg[1], INK[1], cov);
    hi[i + 2] = lerp(bg[2], INK[2], cov);
  }
}

// box-downsample SS×SS → final RGBA (opaque), one filter byte (0) per scanline
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (1 + SIZE * 4);
  raw[rowStart] = 0;
  for (let x = 0; x < SIZE; x++) {
    let r = 0,
      g = 0,
      b = 0;
    for (let sy = 0; sy < SS; sy++)
      for (let sx = 0; sx < SS; sx++) {
        const j = ((y * SS + sy) * W + (x * SS + sx)) * 3;
        r += hi[j];
        g += hi[j + 1];
        b += hi[j + 2];
      }
    const n = SS * SS;
    const o = rowStart + 1 + x * 4;
    raw[o] = Math.round(r / n);
    raw[o + 1] = Math.round(g / n);
    raw[o + 2] = Math.round(b / n);
    raw[o + 3] = 255;
  }
}

// --- minimal PNG encoder ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "media");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "icon.png");
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${SIZE}x${SIZE})`);
