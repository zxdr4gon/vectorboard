// Generates the app icons with no dependencies: a tiny SDF rasteriser + PNG encoder.
// Run: node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(out, { recursive: true });

// Classic is teal on graphite; Studio is emerald on deep green, so the two read apart on a home screen.
let BG = [22, 23, 27], GRID = [44, 47, 54], TEAL = [53, 224, 198], WHITE = [236, 237, 239];

// The mark, in a 0..1 unit square: a faint grid, a smooth vector curve, two anchor nodes.
function bezier(p0, p1, p2, p3, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
  }
  return pts;
}
const A = [0.26, 0.70], B = [0.74, 0.30];
const curve = bezier(A, [0.30, 0.30], [0.70, 0.70], B, 64);
function segDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  let t = l ? ((px - a[0]) * dx + (py - a[1]) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}
function curveDist(x, y) { let d = 1e9; for (let i = 0; i < curve.length - 1; i++) d = Math.min(d, segDist(x, y, curve[i], curve[i + 1])); return d; }
function roundRectSDF(x, y, r) { // square 0..1 with corner radius r, negative inside
  const qx = Math.abs(x - 0.5) - (0.5 - r), qy = Math.abs(y - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Returns RGBA for a sample in unit space. `inset` shrinks the mark (maskable safe zone).
function shade(x, y, { rounded, inset }) {
  if (rounded && roundRectSDF(x, y, 0.22) > 0) return [0, 0, 0, 0];
  // map into mark space
  const mx = (x - 0.5) / inset + 0.5, my = (y - 0.5) / inset + 0.5;
  let c = BG.slice();
  const g = 1 / 6, lw = 0.006;
  for (let k = 1; k < 6; k++) {
    if (Math.abs(mx - k * g) < lw || Math.abs(my - k * g) < lw) { c = GRID.slice(); break; }
  }
  const mix = (col, a) => { c = c.map((v, i) => v + (col[i] - v) * a); };
  const aa = 0.004 / inset;
  const cov = (d) => Math.max(0, Math.min(1, 0.5 - d / aa));
  // handles
  mix(GRID.map((v) => v + 40), cov(segDist(mx, my, A, [0.30, 0.30]) - 0.012) * 0.9);
  mix(GRID.map((v) => v + 40), cov(segDist(mx, my, B, [0.70, 0.70]) - 0.012) * 0.9);
  mix(TEAL, cov(curveDist(mx, my) - 0.05));
  for (const p of [A, B]) {
    const d = Math.max(Math.abs(mx - p[0]), Math.abs(my - p[1])) - 0.055;
    mix(WHITE, cov(d));
    mix(BG, cov(Math.max(Math.abs(mx - p[0]), Math.abs(my - p[1])) - 0.028));
  }
  for (const p of [[0.30, 0.30], [0.70, 0.70]]) mix(WHITE, cov(Math.hypot(mx - p[0], my - p[1]) - 0.03));
  return [...c, 255];
}

function render(size, opts) {
  const buf = Buffer.alloc(size * size * 4), S = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const c = shade((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size, opts);
      acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3];
    }
    const i = (y * size + x) * 4, a = acc[3];
    buf[i] = a ? acc[0] / a : 0; buf[i + 1] = a ? acc[1] / a : 0; buf[i + 2] = a ? acc[2] / a : 0; buf[i + 3] = a / (S * S);
  }
  return buf;
}

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const jobs = [
  ['icon-192.png', 192, { rounded: true, inset: 0.86 }],
  ['icon-512.png', 512, { rounded: true, inset: 0.86 }],
  ['maskable-512.png', 512, { rounded: false, inset: 0.66 }],
  ['apple-touch-icon.png', 180, { rounded: false, inset: 0.78 }],
];
for (const [name, size, opts] of jobs) { writeFileSync(join(out, name), png(size, render(size, opts))); console.log('wrote', name); }

BG = [6, 29, 23]; GRID = [18, 58, 47]; TEAL = [52, 229, 168]; WHITE = [228, 246, 238];
const studioJobs = [
  ['studio-192.png', 192, { rounded: true, inset: 0.86 }],
  ['studio-512.png', 512, { rounded: true, inset: 0.86 }],
  ['studio-maskable-512.png', 512, { rounded: false, inset: 0.66 }],
  ['studio-apple-touch.png', 180, { rounded: false, inset: 0.78 }],
];
for (const [name, size, opts] of studioJobs) { writeFileSync(join(out, name), png(size, render(size, opts))); console.log('wrote', name); }
