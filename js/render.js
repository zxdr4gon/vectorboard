/* Vector Plane — rendering
   Every function here draws world-space data into a 2D context that the
   caller has already transformed. The same code paints the live canvas,
   page thumbnails and PNG/PDF exports; SVG export mirrors it as markup. */

import {
  isShape, isMedia, getBBox, shapeRect, pathCache, strokeOutline, triangleVertices, diamondVertices,
  rectsIntersect, TEXT_TYPES,
} from './geometry.js';

export const FONT_STACK = '"Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif';

export const TEMPLATES = [
  { id: 'grid', label: 'Blueprint grid' },
  { id: 'dots', label: 'Dot grid' },
  { id: 'graph', label: 'Graph paper' },
  { id: 'lined', label: 'Lined paper' },
  { id: 'cornell', label: 'Cornell notes' },
  { id: 'isometric', label: 'Isometric grid' },
  { id: 'staves', label: 'Music staves' },
  { id: 'blank', label: 'Blank' },
];

export function themeColors(dark) {
  return dark ? {
    paper: '#121316', desk: '#0B0C0E', sheet: '#17181C', sheetEdge: 'rgba(255,255,255,0.14)',
    gridMajor: 'rgba(255,255,255,0.15)', gridMinor: 'rgba(255,255,255,0.065)',
    axisX: 'rgba(255,92,92,0.5)', axisY: 'rgba(53,224,198,0.5)',
    connector: 'rgba(199,201,209,0.75)', select: '#35E0C6', selectFill: 'rgba(53,224,198,0.12)',
  } : {
    paper: '#EDEEF1', desk: '#D5D8DE', sheet: '#FFFFFF', sheetEdge: 'rgba(20,21,26,0.12)',
    gridMajor: 'rgba(20,21,26,0.10)', gridMinor: 'rgba(20,21,26,0.045)',
    axisX: 'rgba(255,92,92,0.35)', axisY: 'rgba(61,92,255,0.35)',
    connector: 'rgba(20,21,26,0.55)', select: '#0FA390', selectFill: 'rgba(15,163,144,0.10)',
  };
}

// Near-black ink flips to near-white on dark paper so it stays readable.
const INKS = new Set(['#000000', '#14151a', '#121316', '#16171b', 'black']);
export function inkColor(color, dark) {
  if (!dark || !color) return color || '#14151A';
  return INKS.has(String(color).toLowerCase()) ? '#ECEDEF' : color;
}
function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) return { r: 20, g: 21, b: 26 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function withAlpha(hex, a) { const { r, g, b } = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }
export function stickyFill(hex) {
  const { r, g, b } = hexToRgb(hex);
  const mix = (v) => Math.round(v + (255 - v) * 0.62);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

// ---- grid spacing ---------------------------------------------------------
function niceSpacing(zoom, targetPx) {
  const raw = Math.max(targetPx / zoom, 1e-6);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return mag * (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10);
}
function hLine(c, x0, x1, y) { c.moveTo(x0, y); c.lineTo(x1, y); }
function vLine(c, x, y0, y1) { c.moveTo(x, y0); c.lineTo(x, y1); }

// ---- paper templates (drawn over the visible world rect tl..br) -------------
const TEMPLATE_RENDERERS = {
  grid(c, th, tl, br, z) {
    const s = niceSpacing(z, 90), major = 5;
    c.lineWidth = 1 / z;
    for (const [color, isMajor] of [[th.gridMinor, false], [th.gridMajor, true]]) {
      c.strokeStyle = color; c.beginPath();
      for (let i = Math.floor(tl.x / s); i * s < br.x + s; i++) if ((i % major === 0) === isMajor) vLine(c, i * s, tl.y, br.y);
      for (let j = Math.floor(tl.y / s); j * s < br.y + s; j++) if ((j % major === 0) === isMajor) hLine(c, tl.x, br.x, j * s);
      c.stroke();
    }
    if (tl.x <= 0 && br.x >= 0) { c.strokeStyle = th.axisX; c.beginPath(); vLine(c, 0, tl.y, br.y); c.stroke(); }
    if (tl.y <= 0 && br.y >= 0) { c.strokeStyle = th.axisY; c.beginPath(); hLine(c, tl.x, br.x, 0); c.stroke(); }
  },
  graph(c, th, tl, br, z) {
    const s = niceSpacing(z, 34);
    c.lineWidth = 1 / z; c.strokeStyle = th.gridMinor; c.beginPath();
    for (let i = Math.floor(tl.x / s); i * s < br.x + s; i++) vLine(c, i * s, tl.y, br.y);
    for (let j = Math.floor(tl.y / s); j * s < br.y + s; j++) hLine(c, tl.x, br.x, j * s);
    c.stroke();
  },
  dots(c, th, tl, br, z) {
    const s = niceSpacing(z, 46), r = Math.max(0.9 / z, 1.6 / z);
    c.fillStyle = th.gridMajor; c.beginPath();
    for (let i = Math.floor(tl.x / s); i * s < br.x + s; i++) {
      for (let j = Math.floor(tl.y / s); j * s < br.y + s; j++) { c.moveTo(i * s + r, j * s); c.arc(i * s, j * s, r, 0, Math.PI * 2); }
    }
    c.fill();
  },
  lined(c, th, tl, br, z, page) {
    const s = page ? 40 : niceSpacing(z, 50);
    c.lineWidth = 1 / z; c.strokeStyle = th.gridMajor; c.beginPath();
    for (let j = Math.floor(tl.y / s); j * s < br.y + s; j++) if (!page || j > 1) hLine(c, tl.x, br.x, j * s);
    c.stroke();
    const marginX = page ? 96 : Math.round(tl.x / s / 4) * s * 4 + s * 2;
    c.strokeStyle = th.axisX; c.beginPath(); vLine(c, marginX, tl.y, br.y); c.stroke();
  },
  cornell(c, th, tl, br, z, page) {
    const pageH = page ? page.h : 900, cueW = page ? Math.round(page.w * 0.27) : 220, summaryH = page ? Math.round(page.h * 0.18) : 130, gap = 34;
    c.lineWidth = 1.4 / z;
    for (let p = Math.floor(tl.y / pageH); p <= Math.floor(br.y / pageH); p++) {
      const top = p * pageH;
      c.strokeStyle = th.gridMinor; c.beginPath();
      for (let y = top + gap * 2; y < top + pageH - summaryH; y += gap) hLine(c, cueW, br.x, y);
      c.stroke();
      c.strokeStyle = th.gridMajor; c.beginPath();
      if (!page) hLine(c, tl.x, br.x, top);
      hLine(c, tl.x, br.x, top + gap * 1.5);
      vLine(c, cueW, top + gap * 1.5, top + pageH - summaryH);
      hLine(c, tl.x, br.x, top + pageH - summaryH);
      c.stroke();
    }
  },
  isometric(c, th, tl, br, z) {
    const s = niceSpacing(z, 40);
    c.lineWidth = 1 / z; c.strokeStyle = th.gridMinor; c.beginPath();
    const diag = Math.hypot(br.x - tl.x, br.y - tl.y) + s * 2;
    // Anchor to world origin so the lattice doesn't swim while panning.
    const step = s * Math.cos(Math.PI / 6);
    for (const ang of [Math.PI / 6, Math.PI - Math.PI / 6]) {
      const dx = Math.cos(ang), dy = Math.sin(ang), px = -dy, py = dx;
      const cx = (tl.x + br.x) / 2, cy = (tl.y + br.y) / 2;
      const proj = cx * px + cy * py, k0 = Math.round(proj / step);
      const steps = Math.ceil(diag / step);
      for (let k = k0 - steps; k <= k0 + steps; k++) {
        const off = k * step - proj, ox = cx + px * off, oy = cy + py * off;
        c.moveTo(ox - dx * diag, oy - dy * diag); c.lineTo(ox + dx * diag, oy + dy * diag);
      }
    }
    for (let i = Math.floor(tl.x / step); i * step < br.x + step; i++) vLine(c, i * step, tl.y, br.y);
    c.stroke();
  },
  staves(c, th, tl, br, z, page) {
    const gap = 14, staveGap = 110, top0 = page ? 70 : 0;
    c.lineWidth = Math.max(1 / z, 1.1 / z); c.strokeStyle = th.gridMajor; c.beginPath();
    for (let s = Math.floor((tl.y - top0) / staveGap); s <= Math.floor((br.y - top0) / staveGap); s++) {
      const top = top0 + s * staveGap;
      if (page && (top < top0 || top + gap * 4 > page.h - 40)) continue;
      for (let l = 0; l < 5; l++) hLine(c, page ? 50 : tl.x, page ? page.w - 50 : br.x, top + l * gap);
    }
    c.stroke();
  },
  blank: null,
};
export function drawTemplate(c, template, th, tl, br, zoom, page) {
  const fn = TEMPLATE_RENDERERS[template] === undefined ? TEMPLATE_RENDERERS.grid : TEMPLATE_RENDERERS[template];
  if (!fn) return;
  c.save(); fn(c, th, tl, br, zoom, page); c.restore();
}

// ---- text ------------------------------------------------------------------
let measureCtx = null;
function mctx() {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
}
export const textFont = (type, size) => `${type === 'node' ? 600 : 500} ${size}px ${FONT_STACK}`;
export const defaultFontSize = (type) => (type === 'text' ? 22 : type === 'sticky' ? 17 : 16);
export function wrapLines(c, text, maxWidth) {
  const out = [];
  for (const para of String(text == null ? '' : text).split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (line.trim() && c.measureText(test).width > maxWidth) {
        out.push(line.trimEnd());
        line = w.trimStart();
        // Break single words that are wider than the box.
        while (c.measureText(line).width > maxWidth && line.length > 1) {
          let k = line.length - 1;
          while (k > 1 && c.measureText(line.slice(0, k)).width > maxWidth) k--;
          out.push(line.slice(0, k)); line = line.slice(k);
        }
      } else line = test;
    }
    out.push(line.trimEnd());
  }
  return out;
}
export function measureText(type, text, fontSize, maxWidth) {
  const c = mctx();
  c.font = textFont(type, fontSize);
  const lines = maxWidth ? wrapLines(c, text, maxWidth) : String(text || ' ').split('\n');
  let w = 0;
  for (const l of lines) w = Math.max(w, c.measureText(l || ' ').width);
  return { width: w, height: lines.length * fontSize * 1.3, lines: lines.length };
}
export const TEXT_PAD = { node: 10, sticky: 14, text: 2 };

function drawTextBlock(c, s, r, color) {
  const size = s.fontSize || defaultFontSize(s.type), lh = size * 1.3, pad = TEXT_PAD[s.type];
  c.font = textFont(s.type, size);
  c.fillStyle = color;
  c.textBaseline = 'middle';
  const maxW = Math.max(4, r.maxX - r.minX - pad * 2);
  const lines = wrapLines(c, s.text == null ? '' : s.text, maxW);
  const maxLines = Math.max(1, Math.floor((r.maxY - r.minY - pad * 2 + 1) / lh));
  const shown = lines.slice(0, s.type === 'text' ? lines.length : maxLines);
  if (s.type === 'node') {
    c.textAlign = 'center';
    const cx = (r.minX + r.maxX) / 2, cy = (r.minY + r.maxY) / 2, y0 = cy - ((shown.length - 1) * lh) / 2;
    shown.forEach((l, i) => c.fillText(l, cx, y0 + i * lh));
  } else {
    c.textAlign = 'left';
    shown.forEach((l, i) => c.fillText(l, r.minX + pad, r.minY + pad + lh / 2 + i * lh));
  }
}

// ---- items ---------------------------------------------------------------
function cachedStrokePath(s) {
  const n = s.points.length;
  let e = pathCache.get(s);
  if (!e || e.n !== n) {
    const o = strokeOutline(s);
    e = { n, o, path: new Path2D(o.d) };
    pathCache.set(s, e);
  }
  return e;
}
export function drawStroke(c, s, rc) {
  if (!s.points || !s.points.length) return;
  const { o, path } = cachedStrokePath(s);
  c.save();
  if (s.type === 'highlighter') {
    c.globalAlpha = rc.dark ? 0.35 : 0.42;
    c.globalCompositeOperation = rc.dark ? 'lighter' : 'multiply';
  }
  const color = inkColor(s.color, rc.dark);
  if (o.mode === 'stroke') {
    c.strokeStyle = color; c.lineWidth = o.width; c.lineCap = 'round'; c.lineJoin = 'round';
    c.stroke(path);
  } else { c.fillStyle = color; c.fill(path); }
  c.restore();
}
export function arrowHeadPoints(from, to, width) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x), size = Math.max(10, width * 2.4), spread = Math.PI / 7;
  return [
    { x: to.x - size * Math.cos(ang - spread), y: to.y - size * Math.sin(ang - spread) },
    { x: to.x, y: to.y },
    { x: to.x - size * Math.cos(ang + spread), y: to.y - size * Math.sin(ang + spread) },
  ];
}
function roundRectPath(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function shapePath(c, s, r) {
  const w = r.maxX - r.minX, h = r.maxY - r.minY;
  switch (s.type) {
    case 'rect': c.beginPath(); c.rect(r.minX, r.minY, w, h); break;
    case 'ellipse': c.beginPath(); c.ellipse(r.minX + w / 2, r.minY + h / 2, Math.max(w / 2, 0.01), Math.max(h / 2, 0.01), 0, 0, Math.PI * 2); break;
    case 'triangle': case 'diamond': {
      const v = s.type === 'triangle' ? triangleVertices(r) : diamondVertices(r);
      c.beginPath(); c.moveTo(v[0].x, v[0].y); for (let i = 1; i < v.length; i++) c.lineTo(v[i].x, v[i].y); c.closePath(); break;
    }
    case 'node': roundRectPath(c, r.minX, r.minY, w, h, Math.min(14, h / 2)); break;
    case 'sticky': roundRectPath(c, r.minX, r.minY, w, h, 6); break;
  }
}
export function drawShape(c, s, rc) {
  const r = shapeRect(s);
  const color = inkColor(s.color, rc.dark);
  const lw = Math.max(1, s.baseWidth || 2);
  c.save();
  c.lineJoin = 'round'; c.lineCap = 'round'; c.strokeStyle = color; c.lineWidth = lw;
  if (s.dash) c.setLineDash([lw * 2.6, lw * 2.2]);
  switch (s.type) {
    case 'line': case 'arrow': {
      const [a, b] = s.points;
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      if (s.type === 'arrow') {
        c.setLineDash([]);
        const h = arrowHeadPoints(a, b, lw);
        c.beginPath(); c.moveTo(h[0].x, h[0].y); c.lineTo(h[1].x, h[1].y); c.lineTo(h[2].x, h[2].y); c.stroke();
      }
      break;
    }
    case 'node':
      shapePath(c, s, r);
      c.fillStyle = s.fill === 'solid' ? withAlpha(s.color, 0.32) : rc.dark ? 'rgba(53,224,198,0.12)' : 'rgba(61,92,255,0.07)';
      c.fill(); c.stroke();
      if (s.id !== rc.editingId) drawTextBlock(c, s, r, color);
      break;
    case 'sticky':
      c.setLineDash([]);
      if (!rc.flat) { c.shadowColor = 'rgba(0,0,0,0.16)'; c.shadowBlur = 14; c.shadowOffsetY = 4; }
      shapePath(c, s, r); c.fillStyle = stickyFill(s.color); c.fill();
      c.shadowColor = 'transparent';
      if (s.id !== rc.editingId) drawTextBlock(c, s, r, '#1B1C20');
      break;
    case 'text':
      if (s.id !== rc.editingId) drawTextBlock(c, s, r, color);
      break;
    default:
      shapePath(c, s, r);
      if (s.fill === 'tint' || s.fill === 'solid') {
        c.fillStyle = s.fill === 'solid' ? color : withAlpha(color, 0.16);
        c.fill();
      }
      c.stroke();
  }
  c.restore();
}
export function drawMedia(c, m, rc) {
  const img = rc.image ? rc.image(m.assetId) : null;
  c.save();
  if (img && img.complete && img.naturalWidth) c.drawImage(img, m.x, m.y, m.w, m.h);
  else { c.fillStyle = 'rgba(120,124,132,0.16)'; c.fillRect(m.x, m.y, m.w, m.h); }
  if (m.kind === 'pdf' && !rc.flat) {
    c.strokeStyle = 'rgba(0,0,0,0.16)'; c.lineWidth = 1 / (rc.zoom || 1); c.strokeRect(m.x, m.y, m.w, m.h);
  }
  c.restore();
}
export function drawItem(c, it, rc) {
  if (isMedia(it)) drawMedia(c, it, rc);
  else if (isShape(it)) drawShape(c, it, rc);
  else drawStroke(c, it, rc);
}

// ---- connectors ---------------------------------------------------------
function anchorRect(it) { return isShape(it) ? shapeRect(it) : getBBox(it); }
function clipToRect(from, r) {
  const cx = (r.minX + r.maxX) / 2, cy = (r.minY + r.maxY) / 2;
  const dx = from.x - cx, dy = from.y - cy;
  const hw = (r.maxX - r.minX) / 2 || 0.01, hh = (r.maxY - r.minY) / 2 || 0.01;
  const k = Math.min(1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh, 1e-6), 1);
  return { x: cx + dx * k, y: cy + dy * k };
}
export const rectCenter = (r) => ({ x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 });
export function connectorEnds(from, to, previewTo) {
  const ra = anchorRect(from), ca = rectCenter(ra);
  if (previewTo) return [clipToRect(previewTo, ra), previewTo];
  const rb = anchorRect(to), cb = rectCenter(rb);
  return [clipToRect(cb, ra), clipToRect(ca, rb)];
}
export function drawConnector(c, conn, from, to, rc, previewTo) {
  const [a, b] = connectorEnds(from, to, previewTo);
  const lw = conn && conn.width ? conn.width : 2;
  c.save();
  c.strokeStyle = conn && conn.color ? inkColor(conn.color, rc.dark) : themeColors(rc.dark).connector;
  c.lineWidth = lw; c.lineCap = 'round'; c.lineJoin = 'round';
  if (previewTo) c.setLineDash([6 / rc.zoom, 5 / rc.zoom]);
  c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
  c.setLineDash([]);
  const h = arrowHeadPoints(a, b, lw);
  c.beginPath(); c.moveTo(h[0].x, h[0].y); c.lineTo(h[1].x, h[1].y); c.lineTo(h[2].x, h[2].y); c.stroke();
  c.restore();
}

/* Paints a page's content. `view` (world rect) culls off-screen items. */
export function drawPageItems(c, page, rc, view) {
  const byId = new Map();
  for (const m of page.media) byId.set(m.id, m);
  for (const s of page.strokes) byId.set(s.id, s);
  for (const m of page.media) if (!view || rectsIntersect(getBBox(m), view)) drawMedia(c, m, rc);
  for (const cn of page.connectors) {
    const a = byId.get(cn.fromId), b = byId.get(cn.toId);
    if (a && b) drawConnector(c, cn, a, b, rc);
  }
  for (const s of page.strokes) if (!view || rectsIntersect(getBBox(s), view)) drawItem(c, s, rc);
}

export function pageContentBBox(page) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of [...page.media, ...page.strokes]) {
    const b = getBBox(it);
    minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY); maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
  }
  return { minX, minY, maxX, maxY };
}

/* Offscreen render used by thumbnails and raster export.
   bounds: world rect to capture; scale: px per world unit. */
export function renderToCanvas(page, bounds, scale, opts) {
  const w = Math.max(1, Math.round((bounds.maxX - bounds.minX) * scale));
  const h = Math.max(1, Math.round((bounds.maxY - bounds.minY) * scale));
  const cv = opts.canvas || document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  const dark = !!opts.dark, th = themeColors(dark);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  if (!opts.transparent) { c.fillStyle = opts.background || (page.kind === 'paper' ? th.sheet : th.paper); c.fillRect(0, 0, w, h); }
  c.setTransform(scale, 0, 0, scale, -bounds.minX * scale, -bounds.minY * scale);
  if (opts.template) {
    const tl = { x: bounds.minX, y: bounds.minY }, br = { x: bounds.maxX, y: bounds.maxY };
    drawTemplate(c, page.template, th, tl, br, scale, page.kind === 'paper' ? page : null);
  }
  drawPageItems(c, page, { dark, zoom: scale, image: opts.image, editingId: null, flat: !!opts.flat }, null);
  return cv;
}

// ---- SVG export ---------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n2 = (v) => (Math.round(v * 100) / 100).toString();
function svgText(s, r, color) {
  const size = s.fontSize || defaultFontSize(s.type), lh = size * 1.3, pad = TEXT_PAD[s.type];
  const c = mctx(); c.font = textFont(s.type, size);
  const lines = wrapLines(c, s.text || '', Math.max(4, r.maxX - r.minX - pad * 2));
  const maxLines = s.type === 'text' ? lines.length : Math.max(1, Math.floor((r.maxY - r.minY - pad * 2 + 1) / lh));
  const shown = lines.slice(0, maxLines);
  const weight = s.type === 'node' ? 600 : 500;
  let x, y0, anchor;
  if (s.type === 'node') { x = (r.minX + r.maxX) / 2; y0 = (r.minY + r.maxY) / 2 - ((shown.length - 1) * lh) / 2; anchor = 'middle'; }
  else { x = r.minX + pad; y0 = r.minY + pad + lh / 2; anchor = 'start'; }
  return `<text font-family='${FONT_STACK.replace(/"/g, '')}' font-size="${n2(size)}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" dominant-baseline="central">` +
    shown.map((l, i) => `<tspan x="${n2(x)}" y="${n2(y0 + i * lh)}">${esc(l) || ' '}</tspan>`).join('') + '</text>';
}
function svgShape(s) {
  const r = shapeRect(s), w = r.maxX - r.minX, h = r.maxY - r.minY;
  const color = s.color || '#14151A', lw = Math.max(1, s.baseWidth || 2);
  const dash = s.dash ? ` stroke-dasharray="${n2(lw * 2.6)} ${n2(lw * 2.2)}"` : '';
  const fill = s.fill === 'solid' ? color : s.fill === 'tint' ? withAlpha(color, 0.16) : 'none';
  const st = `stroke="${color}" stroke-width="${n2(lw)}" stroke-linecap="round" stroke-linejoin="round"${dash}`;
  switch (s.type) {
    case 'rect': return `<rect x="${n2(r.minX)}" y="${n2(r.minY)}" width="${n2(w)}" height="${n2(h)}" fill="${fill}" ${st}/>`;
    case 'ellipse': return `<ellipse cx="${n2(r.minX + w / 2)}" cy="${n2(r.minY + h / 2)}" rx="${n2(w / 2)}" ry="${n2(h / 2)}" fill="${fill}" ${st}/>`;
    case 'triangle': case 'diamond': {
      const v = (s.type === 'triangle' ? triangleVertices(r) : diamondVertices(r)).map((p) => `${n2(p.x)},${n2(p.y)}`).join(' ');
      return `<polygon points="${v}" fill="${fill}" ${st}/>`;
    }
    case 'line': case 'arrow': {
      const [a, b] = s.points;
      let out = `<line x1="${n2(a.x)}" y1="${n2(a.y)}" x2="${n2(b.x)}" y2="${n2(b.y)}" ${st}/>`;
      if (s.type === 'arrow') {
        const hp = arrowHeadPoints(a, b, lw);
        out += `<polyline points="${hp.map((p) => `${n2(p.x)},${n2(p.y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${n2(lw)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      return out;
    }
    case 'node':
      return `<rect x="${n2(r.minX)}" y="${n2(r.minY)}" width="${n2(w)}" height="${n2(h)}" rx="${n2(Math.min(14, h / 2))}" fill="${s.fill === 'solid' ? withAlpha(color, 0.32) : 'rgba(61,92,255,0.07)'}" ${st}/>` + svgText(s, r, color);
    case 'sticky':
      return `<rect x="${n2(r.minX)}" y="${n2(r.minY)}" width="${n2(w)}" height="${n2(h)}" rx="6" fill="${stickyFill(color)}"/>` + svgText(s, r, '#1B1C20');
    case 'text': return svgText(s, r, color);
  }
  return '';
}
function svgStroke(s) {
  const o = strokeOutline(s);
  const hl = s.type === 'highlighter' ? ' opacity="0.42" style="mix-blend-mode:multiply"' : '';
  if (o.mode === 'stroke') return `<path d="${o.d}" fill="none" stroke="${s.color}" stroke-width="${n2(o.width)}" stroke-linecap="round" stroke-linejoin="round"${hl}/>`;
  return `<path d="${o.d}" fill="${s.color}"${hl}/>`;
}
export function pageToSVG(page, bounds, opts) {
  const w = bounds.maxX - bounds.minX, h = bounds.maxY - bounds.minY;
  const byId = new Map();
  for (const m of page.media) byId.set(m.id, m);
  for (const s of page.strokes) byId.set(s.id, s);
  let body = '';
  for (const m of page.media) {
    const url = opts.dataURL(m.assetId);
    if (url) body += `<image x="${n2(m.x)}" y="${n2(m.y)}" width="${n2(m.w)}" height="${n2(m.h)}" href="${url}" preserveAspectRatio="none"/>`;
  }
  for (const cn of page.connectors) {
    const a = byId.get(cn.fromId), b = byId.get(cn.toId);
    if (!a || !b) continue;
    const [p, q] = connectorEnds(a, b), lw = cn.width || 2, color = cn.color || 'rgba(20,21,26,0.55)';
    const hp = arrowHeadPoints(p, q, lw);
    body += `<line x1="${n2(p.x)}" y1="${n2(p.y)}" x2="${n2(q.x)}" y2="${n2(q.y)}" stroke="${color}" stroke-width="${lw}" stroke-linecap="round"/>`;
    body += `<polyline points="${hp.map((v) => `${n2(v.x)},${n2(v.y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${lw}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  for (const s of page.strokes) body += isShape(s) ? svgShape(s) : svgStroke(s);
  const bg = opts.transparent ? '' : `<rect x="${n2(bounds.minX)}" y="${n2(bounds.minY)}" width="${n2(w)}" height="${n2(h)}" fill="#ffffff"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="${n2(bounds.minX)} ${n2(bounds.minY)} ${n2(w)} ${n2(h)}">\n${bg}${body}\n</svg>\n`;
}

export { TEXT_TYPES };
