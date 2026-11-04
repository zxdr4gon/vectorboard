/* Vector Plane — geometry
   Pure math on world-space items. Nothing here touches the DOM.

   Item kinds
   - freehand:  { id, type:'stroke'|'highlighter', color, baseWidth, points:[{x,y,p}] }
   - shape:     { id, type:<SHAPE_TYPES>, color, baseWidth, points:[a,b], fill?, dash?, text?, fontSize? }
   - media:     { id, kind:'image'|'pdf', assetId, x, y, w, h, locked? }
*/

export const SHAPE_TYPES = new Set(['rect', 'ellipse', 'triangle', 'diamond', 'line', 'arrow', 'node', 'sticky', 'text']);
export const TEXT_TYPES = new Set(['node', 'sticky', 'text']);
export const BOX_TYPES = new Set(['rect', 'node', 'sticky', 'text']);

export const isShape = (it) => !!(it && it.type && SHAPE_TYPES.has(it.type));
export const isMedia = (it) => !!(it && (it.kind === 'image' || it.kind === 'pdf'));
export const isText = (it) => !!(it && it.type && TEXT_TYPES.has(it.type));

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
export function normalizeRect(a, b) {
  return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
}
export function rectsIntersect(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}
export function rectContains(outer, inner) {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}
export function pointInRect(p, b) { return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY; }
export const emptyBBox = () => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
export function growBBox(acc, b) {
  if (b.minX < acc.minX) acc.minX = b.minX;
  if (b.minY < acc.minY) acc.minY = b.minY;
  if (b.maxX > acc.maxX) acc.maxX = b.maxX;
  if (b.maxY > acc.maxY) acc.maxY = b.maxY;
  return acc;
}
export const bboxValid = (b) => Number.isFinite(b.minX) && Number.isFinite(b.maxX);

// ---- caches ---------------------------------------------------------------
// Bounding boxes and canvas paths are cached per item object. Anything that
// mutates an item's geometry in place must call invalidate(item).
const bboxCache = new WeakMap();
export const pathCache = new WeakMap();
export function invalidate(item) { bboxCache.delete(item); pathCache.delete(item); }

export function pressureToWidth(stroke, p) {
  return Math.max(0.75, stroke.baseWidth * (0.3 + (p == null ? 0.5 : p) * 1.4));
}

function computeStrokeBBox(stroke) {
  const b = emptyBBox();
  for (const pt of stroke.points) {
    const hw = pressureToWidth(stroke, pt.p) / 2;
    if (pt.x - hw < b.minX) b.minX = pt.x - hw;
    if (pt.x + hw > b.maxX) b.maxX = pt.x + hw;
    if (pt.y - hw < b.minY) b.minY = pt.y - hw;
    if (pt.y + hw > b.maxY) b.maxY = pt.y + hw;
  }
  return b;
}
export function shapeRect(shape) {
  // The bare geometric rectangle spanned by a shape's two anchor points.
  const [a, b] = shape.points;
  return normalizeRect(a, b || a);
}
function computeShapeBBox(shape) {
  const r = shapeRect(shape);
  const pad = TEXT_TYPES.has(shape.type) ? 0 : (shape.baseWidth || 2) / 2 + (shape.type === 'arrow' ? Math.max(10, (shape.baseWidth || 2) * 2.4) : 0);
  return { minX: r.minX - pad, minY: r.minY - pad, maxX: r.maxX + pad, maxY: r.maxY + pad };
}
export function getBBox(item) {
  let b = bboxCache.get(item);
  if (b && b._n === (item.points ? item.points.length : -1)) return b;
  if (isMedia(item)) b = { minX: item.x, minY: item.y, maxX: item.x + item.w, maxY: item.y + item.h };
  else if (isShape(item)) b = computeShapeBBox(item);
  else b = computeStrokeBBox(item);
  b._n = item.points ? item.points.length : -1;
  bboxCache.set(item, b);
  return b;
}
export function itemsBBox(items) {
  const acc = emptyBBox();
  for (const it of items) growBBox(acc, getBBox(it));
  return acc;
}

// ---- shape vertices -------------------------------------------------------
export function triangleVertices(r) {
  return [{ x: (r.minX + r.maxX) / 2, y: r.minY }, { x: r.minX, y: r.maxY }, { x: r.maxX, y: r.maxY }];
}
export function diamondVertices(r) {
  const cx = (r.minX + r.maxX) / 2, cy = (r.minY + r.maxY) / 2;
  return [{ x: cx, y: r.minY }, { x: r.maxX, y: cy }, { x: cx, y: r.maxY }, { x: r.minX, y: cy }];
}
function pointInPolygon(p, vs) {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const a = vs[i], b = vs[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}
function pointInEllipse(p, r) {
  const cx = (r.minX + r.maxX) / 2, cy = (r.minY + r.maxY) / 2;
  const rx = (r.maxX - r.minX) / 2 || 1, ry = (r.maxY - r.minY) / 2 || 1;
  const dx = (p.x - cx) / rx, dy = (p.y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}
function nearPolygonEdge(p, vs, tol) {
  for (let i = 0; i < vs.length; i++) if (distToSegment(p, vs[i], vs[(i + 1) % vs.length]) <= tol) return true;
  return false;
}

// ---- hit testing ----------------------------------------------------------
export function hitShape(shape, p, tol) {
  const r = shapeRect(shape);
  const t = tol + (shape.baseWidth || 2) / 2;
  const grown = { minX: r.minX - t, minY: r.minY - t, maxX: r.maxX + t, maxY: r.maxY + t };
  switch (shape.type) {
    case 'rect': case 'node': case 'sticky': case 'text': return pointInRect(p, grown);
    case 'ellipse': return pointInEllipse(p, grown);
    case 'triangle': { const v = triangleVertices(r); return pointInPolygon(p, v) || nearPolygonEdge(p, v, t); }
    case 'diamond': { const v = diamondVertices(r); return pointInPolygon(p, v) || nearPolygonEdge(p, v, t); }
    case 'line': case 'arrow': return distToSegment(p, shape.points[0], shape.points[1]) <= t;
  }
  return false;
}
export function strokeHitByCircle(stroke, center, r) {
  const pts = stroke.points;
  if (!pts.length) return false;
  const b = getBBox(stroke);
  if (center.x < b.minX - r || center.x > b.maxX + r || center.y < b.minY - r || center.y > b.maxY + r) return false;
  if (pts.length === 1) return dist(pts[0], center) <= r + pressureToWidth(stroke, pts[0].p) / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const hw = Math.max(pressureToWidth(stroke, pts[i].p), pressureToWidth(stroke, pts[i + 1].p)) / 2;
    if (distToSegment(center, pts[i], pts[i + 1]) <= r + hw) return true;
  }
  return false;
}
export function hitItem(item, p, tol) {
  if (isMedia(item)) return pointInRect(p, getBBox(item));
  if (isShape(item)) return hitShape(item, p, tol);
  return strokeHitByCircle(item, p, tol);
}

// Precision eraser: true vector path splitting. Returns the surviving parts.
export function splitStrokeByEraser(stroke, center, r, makeId) {
  if (!strokeHitByCircle(stroke, center, r)) return [stroke];
  const pts = stroke.points, n = pts.length;
  const erased = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (dist(pts[i], center) <= r + pressureToWidth(stroke, pts[i].p) / 2) erased[i] = true;
  }
  for (let i = 0; i < n - 1; i++) {
    if (erased[i] && erased[i + 1]) continue;
    const hw = Math.max(pressureToWidth(stroke, pts[i].p), pressureToWidth(stroke, pts[i + 1].p)) / 2;
    if (distToSegment(center, pts[i], pts[i + 1]) <= r + hw) { erased[i] = true; erased[i + 1] = true; }
  }
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length) out.push({ id: makeId(), type: stroke.type, color: stroke.color, baseWidth: stroke.baseWidth, points: run });
    run = [];
  };
  for (let i = 0; i < n; i++) { if (!erased[i]) run.push(pts[i]); else flush(); }
  flush();
  return out;
}

// ---- auto-snap shape recognition -------------------------------------------
export function rdpSimplify(points, epsilon) {
  if (points.length < 3) return points.slice();
  let maxD = 0, idx = 0;
  const first = points[0], last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = distToSegment(points[i], first, last);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > epsilon) {
    const left = rdpSimplify(points.slice(0, idx + 1), epsilon);
    const right = rdpSimplify(points.slice(idx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}
function angleBetween(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
  const m1 = Math.hypot(v1.x, v1.y) || 1, m2 = Math.hypot(v2.x, v2.y) || 1;
  return Math.acos(clamp((v1.x * v2.x + v1.y * v2.y) / (m1 * m2), -1, 1));
}
/* Closed loop -> ellipse / rectangle / triangle; open path -> straight line;
   open path with a sharp reversal at the end -> arrow. Returns null when the
   stroke is too small to classify. */
export function classifyStroke(pts) {
  if (!pts || pts.length < 5) return null;
  const start = pts[0], end = pts[pts.length - 1];
  const r = emptyBBox();
  for (const p of pts) growBBox(r, { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y });
  const width = r.maxX - r.minX, height = r.maxY - r.minY;
  const diag = Math.hypot(width, height);
  if (diag < 1e-6) return null;
  const closed = dist(start, end) < diag * 0.45 && pts.length > 8;
  if (closed) {
    const corners = rdpSimplify(pts, diag * 0.055).length - 1;
    const a = { x: r.minX, y: r.minY }, b = { x: r.maxX, y: r.maxY };
    if (corners === 3) return { type: 'triangle', points: [a, b] };
    if (corners === 4) return { type: 'rect', points: [a, b] };
    return { type: 'ellipse', points: [a, b] };
  }
  const s = rdpSimplify(pts, diag * 0.035);
  if (s.length === 3) {
    const seg1 = dist(s[0], s[1]), seg2 = dist(s[1], s[2]);
    if (seg2 < seg1 * 0.55 && angleBetween(s[0], s[1], s[2]) < Math.PI * 0.75) {
      return { type: 'arrow', points: [{ x: s[0].x, y: s[0].y }, { x: s[1].x, y: s[1].y }] };
    }
  }
  return { type: 'line', points: [start, end] };
}

// ---- stroke outlines --------------------------------------------------------
/* Builds an SVG path description for a freehand stroke. Used by both the
   canvas (via Path2D) and SVG export, so they always match.
   - uniform width  -> { mode:'stroke', d, width }  (smooth centre line)
   - varying width  -> { mode:'fill', d }           (pressure outline)          */
const f = (n) => (Math.round(n * 100) / 100).toString();
export function strokeOutline(stroke) {
  const pts = stroke.points;
  const n = pts.length;
  if (!n) return { mode: 'fill', d: '' };
  if (n === 1) {
    const r = pressureToWidth(stroke, pts[0].p) / 2, { x, y } = pts[0];
    return { mode: 'fill', d: `M${f(x - r)} ${f(y)}A${f(r)} ${f(r)} 0 1 0 ${f(x + r)} ${f(y)}A${f(r)} ${f(r)} 0 1 0 ${f(x - r)} ${f(y)}Z` };
  }
  let varying = false;
  if (stroke.type !== 'highlighter') {
    const p0 = pts[0].p;
    for (let i = 1; i < n; i++) if (Math.abs(pts[i].p - p0) > 0.02) { varying = true; break; }
  }
  if (!varying || n < 3) {
    let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
    if (n === 2) d += `L${f(pts[1].x)} ${f(pts[1].y)}`;
    else {
      for (let i = 1; i < n - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
        d += `Q${f(pts[i].x)} ${f(pts[i].y)} ${f(mx)} ${f(my)}`;
      }
      d += `L${f(pts[n - 1].x)} ${f(pts[n - 1].y)}`;
    }
    let sum = 0;
    for (const p of pts) sum += p.p == null ? 0.5 : p.p;
    return { mode: 'stroke', d, width: pressureToWidth(stroke, sum / n) };
  }
  // Pressure outline. Pressure is lightly smoothed so stylus noise doesn't ripple.
  const w = new Array(n);
  let sp = pts[0].p;
  for (let i = 0; i < n; i++) { sp = sp + (pts[i].p - sp) * 0.45; w[i] = pressureToWidth(stroke, sp) / 2; }
  const L = new Array(n), R = new Array(n);
  let tx = 1, ty = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) { tx = dx / len; ty = dy / len; }
    const nx = -ty, ny = tx;
    L[i] = { x: pts[i].x + nx * w[i], y: pts[i].y + ny * w[i] };
    R[i] = { x: pts[i].x - nx * w[i], y: pts[i].y - ny * w[i] };
  }
  let d = `M${f(L[0].x)} ${f(L[0].y)}`;
  for (let i = 1; i < n - 1; i++) d += `Q${f(L[i].x)} ${f(L[i].y)} ${f((L[i].x + L[i + 1].x) / 2)} ${f((L[i].y + L[i + 1].y) / 2)}`;
  d += `L${f(L[n - 1].x)} ${f(L[n - 1].y)}`;
  d += `A${f(w[n - 1])} ${f(w[n - 1])} 0 0 0 ${f(R[n - 1].x)} ${f(R[n - 1].y)}`;
  for (let i = n - 2; i > 0; i--) d += `Q${f(R[i].x)} ${f(R[i].y)} ${f((R[i].x + R[i - 1].x) / 2)} ${f((R[i].y + R[i - 1].y) / 2)}`;
  d += `L${f(R[0].x)} ${f(R[0].y)}`;
  d += `A${f(w[0])} ${f(w[0])} 0 0 0 ${f(L[0].x)} ${f(L[0].y)}Z`;
  return { mode: 'fill', d };
}

// ---- transforms -------------------------------------------------------------
export function translateItem(it, dx, dy) {
  if (isMedia(it)) { it.x += dx; it.y += dy; }
  else for (const pt of it.points) { pt.x += dx; pt.y += dy; }
  invalidate(it);
}
/* Scale an item about origin (ox, oy). Stroke widths and font sizes follow
   the average scale so things keep their proportions. */
export function scaleItem(it, ox, oy, sx, sy, base) {
  const avg = Math.sqrt(Math.abs(sx * sy));
  if (isMedia(it)) {
    it.x = ox + (base.x - ox) * sx; it.y = oy + (base.y - oy) * sy;
    it.w = Math.max(4, base.w * sx); it.h = Math.max(4, base.h * sy);
  } else {
    it.points.forEach((pt, i) => { pt.x = ox + (base.points[i].x - ox) * sx; pt.y = oy + (base.points[i].y - oy) * sy; });
    if (base.baseWidth != null) it.baseWidth = clamp(base.baseWidth * avg, 0.5, 400);
    if (base.fontSize != null) it.fontSize = clamp(base.fontSize * avg, 4, 800);
  }
  invalidate(it);
}
