/* Vector Plane — application
   World-space document, redrawn on demand through a camera transform, so lines
   stay sharp at any zoom and exports are a straight replay of the data. */

import * as G from './geometry.js';
import * as R from './render.js';
import * as S from './store.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c');
const ctx = canvas.getContext('2d');

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------
const MIN_ZOOM = 0.05, MAX_ZOOM = 40, HISTORY_LIMIT = 100;
const CDN = {
  pdf: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  zip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
};
const SWATCHES = [
  ['#14151A', 'Ink'], ['#6B6F7A', 'Graphite'], ['#3D5CFF', 'Indigo'], ['#35E0C6', 'Signal'], ['#2FB65A', 'Green'],
  ['#FF5C5C', 'Red'], ['#FFB020', 'Amber'], ['#9B5CFF', 'Violet'], ['#FF7AC6', 'Pink'],
];
const SHAPE_TOOLS = new Set(['rect', 'ellipse', 'triangle', 'diamond', 'line', 'arrow']);
const TEXT_TOOLS = new Set(['text', 'node', 'sticky']);
const ERASERS = new Set(['eraser-stroke', 'eraser-precision']);
const TOOL_NAMES = {
  select: 'Select', hand: 'Pan', pen: 'Pen', highlighter: 'Highlighter', 'eraser-stroke': 'Stroke eraser',
  'eraser-precision': 'Precision eraser', laser: 'Laser pointer', rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle',
  diamond: 'Diamond', line: 'Line', arrow: 'Arrow', text: 'Text', node: 'Text box', sticky: 'Sticky note', connector: 'Connector',
};
const isPhone = () => window.matchMedia('(max-width: 720px)').matches;
const coarse = () => window.matchMedia('(pointer: coarse)').matches;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// settings (localStorage — small, per device)
// ---------------------------------------------------------------------------
const DEFAULT_STYLES = {
  pen: { color: '#14151A', size: 6 },
  highlighter: { color: '#FFB020', size: 6 },
  shape: { color: '#14151A', size: 4, fill: 'none', dash: false },
  text: { color: '#14151A', size: 22 },
  node: { color: '#3D5CFF', size: 16 },
  sticky: { color: '#FFB020', size: 17 },
  connector: { color: '#6B6F7A', size: 2 },
};
const settings = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('vp-settings') || '{}') || {}; } catch (e) {}
  const legacyTheme = localStorage.getItem('canvas-theme');
  const out = {
    theme: s.theme || (legacyTheme === 'dark' || legacyTheme === 'light' ? legacyTheme : 'system'),
    snap: s.snap !== false,
    touchPans: !!s.touchPans,
    touchPansAuto: s.touchPansAuto !== false,
    wheelPans: !!s.wheelPans,
    smoothing: Number.isFinite(s.smoothing) ? s.smoothing : 30,
    showCoords: s.showCoords !== false,
    styleOpen: s.styleOpenDesktop !== false,
    eraserRadius: s.eraserRadius || 22,
    tool: s.tool || 'pen',
    lastShape: s.lastShape || 'rect',
    styles: {},
  };
  for (const k of Object.keys(DEFAULT_STYLES)) out.styles[k] = Object.assign({}, DEFAULT_STYLES[k], (s.styles || {})[k]);
  return out;
})();
let settingsTimer = null;
// On phones the style sheet covers the canvas, so it starts closed each session.
let phoneStyleOpen = false;
const styleIsOpen = () => (isPhone() ? phoneStyleOpen : settings.styleOpen);
function setStyleOpen(v) {
  if (isPhone()) phoneStyleOpen = v; else { settings.styleOpen = v; saveSettings(); }
  updateStylePanel();
}
function saveSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => { try { localStorage.setItem('vp-settings', JSON.stringify({ ...settings, styleOpenDesktop: settings.styleOpen })); } catch (e) {} }, 150);
}

// ---------------------------------------------------------------------------
// document state
// ---------------------------------------------------------------------------
let doc = { title: 'Untitled board', pages: [], currentPageIndex: 0 };
let page = null;                     // == doc.pages[doc.currentPageIndex]
const assets = new Map();            // assetId -> dataURL
const images = new Map();            // assetId -> HTMLImageElement
let nextId = 1, nextPageId = 1;
const camera = { panX: 0, panY: 0, zoom: 1 };
const selected = new Set();
let history = [], future = [];
let isDark = false;
let dpr = Math.min(window.devicePixelRatio || 1, 2);

const newId = () => nextId++;
function recomputeIds() {
  let maxItem = 0, maxPage = 0;
  for (const p of doc.pages) {
    maxPage = Math.max(maxPage, Number(p.id) || 0);
    for (const it of [...p.strokes, ...p.media, ...p.connectors]) maxItem = Math.max(maxItem, Number(it.id) || 0);
  }
  nextId = Math.max(nextId, maxItem + 1);
  nextPageId = Math.max(nextPageId, maxPage + 1);
}
function makePage(kind, opts = {}) {
  const p = {
    id: nextPageId++, name: opts.name || '', kind, template: opts.template || (kind === 'paper' ? 'lined' : 'grid'),
    strokes: [], media: [], connectors: [], view: null,
  };
  if (kind === 'paper') { p.w = opts.w || S.PAPER_W; p.h = opts.h || S.PAPER_H; }
  return p;
}
const pageLabel = (p, i) => p.name || (p.kind === 'infinite' ? (i === 0 ? 'Canvas' : `Canvas ${i + 1}`) : `Page ${i + 1}`);
const pageHasContent = (p) => !!(p.strokes.length || p.media.length);
const findItem = (id) => page.strokes.find((s) => s.id === id) || page.media.find((m) => m.id === id) || null;
const allItems = () => [...page.media, ...page.strokes];

// ---- images ----------------------------------------------------------------
function getImage(assetId) {
  if (!assetId) return null;
  let img = images.get(assetId);
  if (!img) {
    const url = assets.get(assetId);
    if (!url) return null;
    img = new Image();
    img.decoding = 'async';
    img.onload = () => { requestRender(); thumbsDirty = true; };
    img.src = url;
    images.set(assetId, img);
  }
  return img;
}
function whenImagesReady(pages) {
  const jobs = [];
  for (const p of pages) for (const m of p.media) {
    const img = getImage(m.assetId);
    if (img && !(img.complete && img.naturalWidth)) jobs.push(new Promise((res) => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); }));
  }
  return Promise.all(jobs);
}
async function addAsset(dataURL) {
  const id = S.newAssetId();
  assets.set(id, dataURL);
  const ok = await S.putAsset({ id, dataURL });
  if (!ok) toast('Image kept for this session only — browser storage is unavailable');
  return id;
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------
const saveStateEl = $('saveState');
let saveTimer = null, saving = false, saveQueued = false, persistAsked = false, saveWarned = false;
function setSaveState(text, cls) { saveStateEl.textContent = text; saveStateEl.className = 'save-state' + (cls ? ' ' + cls : ''); }
function markDirty() {
  thumbsDirty = true;
  setSaveState('Saving…', 'busy');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (saving) { saveQueued = true; return; }
  saving = true;
  storeView();
  const ok = await S.saveDoc({ version: 4, title: doc.title, pages: doc.pages, currentPageIndex: doc.currentPageIndex });
  saving = false;
  if (ok) {
    setSaveState('Saved');
    if (!persistAsked && doc.pages.some(pageHasContent) && navigator.storage && navigator.storage.persist) {
      persistAsked = true; navigator.storage.persist().catch(() => {});
    }
  } else {
    setSaveState('Not saved', 'warn');
    if (!saveWarned) { saveWarned = true; toast('Couldn’t save to this browser. Use Save to file to keep your work.'); }
  }
  if (saveQueued) { saveQueued = false; flushSave(); }
}
window.addEventListener('pagehide', () => flushSave());
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

// ---------------------------------------------------------------------------
// history — page-level entries are cheap, doc-level entries cover page ops
// ---------------------------------------------------------------------------
const clonePageData = (p) => structuredClone({ strokes: p.strokes, media: p.media, connectors: p.connectors, template: p.template, name: p.name });
function pushHistory(entry) {
  history.push(entry || { kind: 'page', pageId: page.id, data: clonePageData(page) });
  if (history.length > HISTORY_LIMIT) history.shift();
  future = [];
  updateUndoButtons();
}
const docSnapshot = () => ({ kind: 'doc', data: structuredClone({ pages: doc.pages.map((p) => ({ ...p, view: null })), currentPageIndex: doc.currentPageIndex }) });
function pushDocHistory() { pushHistory(docSnapshot()); }
function applyEntry(entry) {
  if (entry.kind === 'page') {
    const idx = doc.pages.findIndex((p) => p.id === entry.pageId);
    if (idx < 0) return null;
    const p = doc.pages[idx];
    const inverse = { kind: 'page', pageId: p.id, data: clonePageData(p) };
    Object.assign(p, entry.data);
    if (idx !== doc.currentPageIndex) activatePage(idx, { keepView: false });
    return inverse;
  }
  const inverse = docSnapshot();
  const views = new Map(doc.pages.map((p) => [p.id, p.view]));
  doc.pages = entry.data.pages.map((p) => ({ ...p, view: views.get(p.id) || null }));
  activatePage(Math.min(entry.data.currentPageIndex, doc.pages.length - 1), { keepView: true, noStore: true });
  return inverse;
}
function undo() {
  if (editing) closeEditor(true);
  if (!history.length) return;
  const inv = applyEntry(history.pop());
  if (inv) future.push(inv);
  afterHistoryJump();
}
function redo() {
  if (editing) closeEditor(true);
  if (!future.length) return;
  const inv = applyEntry(future.pop());
  if (inv) history.push(inv);
  afterHistoryJump();
}
function afterHistoryJump() {
  selected.clear();
  page = doc.pages[doc.currentPageIndex];
  updateUndoButtons(); updatePageUI(); updateStylePanel(); markDirty(); requestRender();
}
function updateUndoButtons() { $('undoBtn').disabled = !history.length; $('redoBtn').disabled = !future.length; }

// ---------------------------------------------------------------------------
// camera
// ---------------------------------------------------------------------------
const screenToWorld = (sx, sy) => ({ x: (sx - camera.panX) / camera.zoom, y: (sy - camera.panY) / camera.zoom });
const worldToScreen = (wx, wy) => ({ x: wx * camera.zoom + camera.panX, y: wy * camera.zoom + camera.panY });
function viewRect() {
  const a = screenToWorld(0, 0), b = screenToWorld(innerWidth, innerHeight);
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
}
function zoomAt(sx, sy, factor) {
  const before = screenToWorld(sx, sy);
  camera.zoom = G.clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  camera.panX = sx - before.x * camera.zoom;
  camera.panY = sy - before.y * camera.zoom;
  requestRender();
}
let camAnim = null;
function animateCamera(target, ms = 220) {
  cancelAnimationFrame(camAnim);
  if (reducedMotion()) { Object.assign(camera, target); requestRender(); return; }
  const from = { ...camera }, t0 = performance.now();
  // Interpolate zoom in log space so it feels even.
  const lz0 = Math.log(from.zoom), lz1 = Math.log(target.zoom);
  const step = (now) => {
    const t = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - t, 3);
    camera.zoom = Math.exp(lz0 + (lz1 - lz0) * e);
    camera.panX = from.panX + (target.panX - from.panX) * e;
    camera.panY = from.panY + (target.panY - from.panY) * e;
    requestRender();
    if (t < 1) camAnim = requestAnimationFrame(step);
  };
  camAnim = requestAnimationFrame(step);
}
function chromeInsets() {
  // Keep fitted content clear of the floating UI.
  if (isPhone()) return { top: 64, bottom: 76, left: 12, right: 12 };
  return { top: 70, bottom: 64, left: 72, right: 24 };
}
function cameraForRect(b, maxZoom = 4) {
  const ins = chromeInsets(), w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
  const availW = Math.max(50, innerWidth - ins.left - ins.right), availH = Math.max(50, innerHeight - ins.top - ins.bottom);
  const zoom = G.clamp(Math.min(availW / w, availH / h), MIN_ZOOM, maxZoom);
  return {
    zoom,
    panX: ins.left + (availW - w * zoom) / 2 - b.minX * zoom,
    panY: ins.top + (availH - h * zoom) / 2 - b.minY * zoom,
  };
}
function fitView(animate = true) {
  let target;
  if (page.kind === 'paper') target = cameraForRect({ minX: 0, minY: 0, maxX: page.w, maxY: page.h }, 3);
  else {
    const b = R.pageContentBBox(page);
    if (G.bboxValid(b)) target = cameraForRect({ minX: b.minX - 40, minY: b.minY - 40, maxX: b.maxX + 40, maxY: b.maxY + 40 }, 2);
    else target = { zoom: 1, panX: innerWidth / 2, panY: innerHeight / 2 };
  }
  if (animate) animateCamera(target); else { Object.assign(camera, target); requestRender(); }
}
function zoomBy(factor) {
  const target = { zoom: G.clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM) };
  const cx = innerWidth / 2, cy = innerHeight / 2, w = screenToWorld(cx, cy);
  target.panX = cx - w.x * target.zoom; target.panY = cy - w.y * target.zoom;
  animateCamera(target, 160);
}
function zoomTo100() { zoomBy(1 / camera.zoom); }
function zoomToSelection() {
  if (!selected.size) return fitView();
  const b = G.itemsBBox(selectedItems());
  animateCamera(cameraForRect({ minX: b.minX - 30, minY: b.minY - 30, maxX: b.maxX + 30, maxY: b.maxY + 30 }, 4));
}
function storeView() { if (page) page.view = { panX: camera.panX, panY: camera.panY, zoom: camera.zoom, w: innerWidth, h: innerHeight }; }

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------
function activatePage(index, opts = {}) {
  if (editing) closeEditor(true);
  if (!opts.noStore && page) storeView();
  doc.currentPageIndex = G.clamp(index, 0, doc.pages.length - 1);
  page = doc.pages[doc.currentPageIndex];
  selected.clear();
  const v = page.view;
  if (opts.keepView && v) {
    Object.assign(camera, { panX: v.panX + ((innerWidth - (v.w || innerWidth)) / 2), panY: v.panY + ((innerHeight - (v.h || innerHeight)) / 2), zoom: v.zoom });
    requestRender();
  } else if (v && !opts.fit) {
    Object.assign(camera, { panX: v.panX + ((innerWidth - (v.w || innerWidth)) / 2), panY: v.panY + ((innerHeight - (v.h || innerHeight)) / 2), zoom: v.zoom });
    requestRender();
  } else fitView(false);
  updatePageUI(); updateStylePanel(); requestRender();
}
function goToPage(i) { if (i >= 0 && i < doc.pages.length && i !== doc.currentPageIndex) { activatePage(i); markDirty(); } }
function addPage(kind, orient) {
  pushDocHistory();
  const opts = kind === 'paper' && orient === 'landscape' ? { w: S.PAPER_H, h: S.PAPER_W } : {};
  if (kind === 'paper') opts.template = page.kind === 'paper' ? page.template : 'lined';
  const p = makePage(kind, opts);
  doc.pages.splice(doc.currentPageIndex + 1, 0, p);
  activatePage(doc.currentPageIndex + 1, { fit: true });
  markDirty();
  toast(kind === 'paper' ? 'Paper page added' : 'Canvas added');
}
function duplicatePage(i) {
  pushDocHistory();
  const src = doc.pages[i], copy = structuredClone({ ...src, view: null });
  copy.id = nextPageId++;
  copy.name = pageLabel(src, i) + ' copy';
  const idMap = new Map();
  for (const it of [...copy.strokes, ...copy.media]) { const n = newId(); idMap.set(it.id, n); it.id = n; }
  copy.connectors = copy.connectors.map((c) => ({ ...c, id: newId(), fromId: idMap.get(c.fromId), toId: idMap.get(c.toId) })).filter((c) => c.fromId && c.toId);
  doc.pages.splice(i + 1, 0, copy);
  activatePage(i + 1);
  markDirty();
}
async function renamePage(i) {
  const p = doc.pages[i];
  const name = await askText('Rename page', 'Page name', pageLabel(p, i));
  if (name == null) return;
  pushDocHistory();
  p.name = name.trim().slice(0, 60);
  updatePageUI(); markDirty();
}
async function deletePage(i) {
  const p = doc.pages[i];
  if (doc.pages.length === 1) {
    if (pageHasContent(p) && !(await confirmBox('Clear this page?', 'It’s the only page, so its content will be cleared instead.', 'Clear', true))) return;
    clearPage();
    return;
  }
  if (pageHasContent(p) && !(await confirmBox(`Delete “${pageLabel(p, i)}”?`, 'You can undo this.', 'Delete', true))) return;
  pushDocHistory();
  doc.pages.splice(i, 1);
  const next = i < doc.currentPageIndex ? doc.currentPageIndex - 1 : Math.min(doc.currentPageIndex, doc.pages.length - 1);
  page = null;
  activatePage(next);
  markDirty();
  toast('Page deleted', { action: 'Undo', onAction: undo });
}
function movePage(from, to) {
  if (from === to || to < 0 || to >= doc.pages.length) return;
  pushDocHistory();
  const cur = doc.pages[doc.currentPageIndex];
  const [p] = doc.pages.splice(from, 1);
  doc.pages.splice(to, 0, p);
  doc.currentPageIndex = doc.pages.indexOf(cur);
  page = cur;
  updatePageUI(); markDirty();
  if (!$('pagesPanel').hidden) renderPagesPanel();
}
function clearPage() {
  if (!pageHasContent(page) && !page.connectors.length) return;
  pushHistory();
  page.strokes = []; page.media = []; page.connectors = [];
  selected.clear();
  markDirty(); requestRender(); updateStylePanel();
  toast('Page cleared', { action: 'Undo', onAction: undo });
}
function setTemplate(t) {
  if (page.template === t) return;
  pushHistory();
  page.template = t;
  markDirty(); requestRender(); refreshTemplateMenu();
}
function updatePageUI() {
  const i = doc.currentPageIndex;
  $('pageName').textContent = pageLabel(page, i);
  $('pageCount').textContent = `${i + 1} / ${doc.pages.length}`;
  $('pageKindIcon').firstElementChild.setAttribute('href', page.kind === 'paper' ? (page.w > page.h ? '#i-landscape' : '#i-portrait') : '#i-infinite');
  $('prevPageBtn').disabled = i === 0;
  $('nextPageBtn').disabled = i === doc.pages.length - 1;
  document.title = doc.title && doc.title !== 'Untitled board' ? `${doc.title} — Vector Plane` : 'Vector Plane';
}

// ---------------------------------------------------------------------------
// tools & styles
// ---------------------------------------------------------------------------
const state = { tool: 'pen' };
function styleKey(tool) {
  if (SHAPE_TOOLS.has(tool)) return 'shape';
  if (DEFAULT_STYLES[tool]) return tool;
  return null;
}
function setTool(name) {
  if (editing) closeEditor(true);
  if (!TOOL_NAMES[name]) name = 'pen';
  if (name !== 'select' && selected.size) { selected.clear(); }
  state.tool = name;
  settings.tool = name;
  if (SHAPE_TOOLS.has(name)) { settings.lastShape = name; $('shapesIcon').firstElementChild.setAttribute('href', '#i-' + name); }
  saveSettings();
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === name)));
  $('shapesBtn').setAttribute('aria-pressed', String(SHAPE_TOOLS.has(name)));
  const active = document.querySelector(`.rail .tool[data-tool="${name}"]`) || (SHAPE_TOOLS.has(name) ? $('shapesBtn') : null);
  if (active && isPhone()) active.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  updateCursor(); updateStylePanel(); requestRender();
}

// ---- style panel -----------------------------------------------------------
const stylePanel = $('stylePanel'), sizeSlider = $('sizeSlider'), sizeValue = $('sizeValue');
function selectedItems() { return allItems().filter((it) => selected.has(it.id)); }
function panelContext() {
  if (state.tool === 'select' && selected.size) {
    const items = selectedItems();
    const styled = items.filter((it) => !G.isMedia(it));
    const first = styled[0];
    const hasFill = styled.some((it) => ['rect', 'ellipse', 'triangle', 'diamond', 'node'].includes(it.type));
    const hasDash = styled.some((it) => G.isShape(it) && !G.isText(it) || it.type === 'node');
    const allText = styled.length && styled.every((it) => G.isText(it));
    let size = null;
    if (first) {
      if (G.isText(first)) size = Math.round(first.fontSize || R.defaultFontSize(first.type));
      else if (first.type === 'highlighter') size = Math.round(first.baseWidth / 2.6);
      else size = Math.round(first.baseWidth || 2);
    }
    return {
      mode: 'selection', title: `${items.length} selected`, color: first ? first.color : null, size,
      sizeRange: allText ? [8, 120] : [1, 60], sizeLabel: allText ? 'Text size' : 'Size',
      showColor: !!styled.length, showSize: !!styled.length, showFill: hasFill, showDash: hasDash,
      fill: first ? first.fill || 'none' : 'none', dash: first ? !!first.dash : false,
      hint: styled.length ? '' : 'Images and PDF pages have no style. Drag a corner to resize.',
    };
  }
  const t = state.tool;
  if (ERASERS.has(t)) {
    return {
      mode: 'eraser', title: TOOL_NAMES[t], size: settings.eraserRadius, sizeRange: [4, 100], sizeLabel: 'Eraser size',
      showSize: true, hint: t === 'eraser-stroke' ? 'Removes whole strokes and shapes. Imported images and PDFs are never erased.' : 'Cuts through ink and removes only what you touch.',
    };
  }
  const key = styleKey(t);
  if (!key) return null;
  const st = settings.styles[key];
  const isTextTool = TEXT_TOOLS.has(t);
  return {
    mode: 'tool', key, title: TOOL_NAMES[t], color: st.color, size: st.size,
    sizeRange: isTextTool ? [8, 120] : key === 'connector' ? [1, 12] : [1, 60], sizeLabel: isTextTool ? 'Text size' : 'Size',
    showColor: true, showSize: true, showFill: key === 'shape' && !['line', 'arrow'].includes(t), showDash: key === 'shape',
    fill: st.fill || 'none', dash: !!st.dash,
    hint: t === 'connector' ? 'Drag from one item to another. Lines stay attached when you move things.'
      : isTextTool ? 'Click to place, or drag to set the width. Double-click any text to edit it.'
      : t === 'pen' && settings.snap ? 'Hold still at the end of a stroke to snap it into a clean shape.' : '',
  };
}
function updateStylePanel() {
  const c = panelContext();
  const relevant = !!c && !(c.mode === 'tool' && state.tool === 'select');
  const show = relevant && styleIsOpen() && !document.body.classList.contains('zen');
  stylePanel.hidden = !show;
  document.body.classList.toggle('style-open', show);
  $('styleBtn').setAttribute('aria-expanded', String(show));
  const dotColor = c && c.color ? c.color : settings.styles.pen.color;
  $('styleDot').style.background = R.inkColor(dotColor, isDark);
  $('styleBtn').disabled = !relevant;
  if (!c) return;
  $('spTitle').textContent = c.title;
  $('spColors').hidden = !c.showColor;
  $('spSize').hidden = !c.showSize;
  $('spFill').hidden = !c.showFill;
  $('spDash').hidden = !c.showDash;
  $('spHint').textContent = c.hint || '';
  $('sizeLabel').textContent = c.sizeLabel;
  if (c.showSize) {
    sizeSlider.min = c.sizeRange[0]; sizeSlider.max = c.sizeRange[1];
    sizeSlider.value = c.size == null ? sizeSlider.value : c.size;
    syncSizeUI();
  }
  document.querySelectorAll('#swatches .swatch[data-color]').forEach((b) => b.setAttribute('aria-checked', String(!!c.color && b.dataset.color.toLowerCase() === String(c.color).toLowerCase())));
  const custom = $('customColor');
  const isPreset = c.color && SWATCHES.some(([h]) => h.toLowerCase() === String(c.color).toLowerCase());
  if (c.color) custom.value = toHex6(c.color);
  // The centre dot only shows a colour when a custom colour is in use.
  custom.parentElement.style.setProperty('--custom', c.color && !isPreset ? R.inkColor(c.color, isDark) : 'var(--surface)');
  custom.parentElement.setAttribute('aria-checked', String(!!c.color && !isPreset));
  document.querySelectorAll('#spFill [data-fill]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.fill === c.fill)));
  document.querySelectorAll('#spDash [data-dash]').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.dash === '1') === c.dash)));
}
function toHex6(c) { const s = String(c || '#000000'); return /^#[0-9a-f]{6}$/i.test(s) ? s : '#14151a'; }
function syncSizeUI() {
  const v = Number(sizeSlider.value), lo = Number(sizeSlider.min), hi = Number(sizeSlider.max);
  sizeValue.textContent = v;
  sizeSlider.style.setProperty('--fill', ((v - lo) / (hi - lo)) * 100 + '%');
  const c = panelContext(), prev = $('sizePreview');
  let px = v;
  if (c && c.mode === 'eraser') px = v * 2 * 0.28;
  else if (c && c.sizeLabel === 'Text size') px = v * 0.5;
  else if (state.tool === 'highlighter') px = v * 2.6 * 0.5;
  px = G.clamp(px, 2, 28);
  prev.style.width = prev.style.height = px + 'px';
  prev.style.color = c && c.color ? R.inkColor(c.color, isDark) : 'var(--text-2)';
  prev.parentElement.style.visibility = c && c.sizeLabel === 'Text size' ? 'hidden' : 'visible';
}
let styleGesture = false;
function applyStyle(patch) {
  const c = panelContext();
  if (!c) return;
  if (c.mode === 'eraser') { if (patch.size != null) settings.eraserRadius = patch.size; saveSettings(); requestRender(); return; }
  if (c.mode === 'tool') {
    Object.assign(settings.styles[c.key], patch);
    saveSettings(); updateStylePanel(); return;
  }
  // selection
  if (!styleGesture) { pushHistory(); styleGesture = true; }
  for (const it of selectedItems()) {
    if (G.isMedia(it)) continue;
    if (patch.color) it.color = patch.color;
    if (patch.size != null) {
      if (G.isText(it)) { it.fontSize = patch.size; fitTextBox(it); }
      else if (it.type === 'highlighter') it.baseWidth = patch.size * 2.6;
      else it.baseWidth = patch.size;
    }
    if (patch.fill && ['rect', 'ellipse', 'triangle', 'diamond', 'node'].includes(it.type)) it.fill = patch.fill;
    if (patch.dash != null && G.isShape(it) && it.type !== 'text' && it.type !== 'sticky') it.dash = patch.dash;
    G.invalidate(it);
  }
  markDirty(); requestRender(); updateStylePanel();
}
function endStyleGesture() { styleGesture = false; }

function buildSwatches() {
  const el = $('swatches');
  el.innerHTML = SWATCHES.map(([hex, name], i) => `<button class="swatch" role="radio" aria-checked="false" aria-label="${name}" data-color="${hex}" data-i="${i}"></button>`).join('') +
    '<label class="swatch swatch-custom" role="radio" aria-checked="false" aria-label="Custom color"><input type="color" id="customColor" value="#14151a" aria-label="Custom color"></label>';
  paintSwatches();
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.swatch[data-color]');
    if (!b) return;
    applyStyle({ color: b.dataset.color }); endStyleGesture();
  });
  const custom = $('customColor');
  custom.addEventListener('input', () => applyStyle({ color: custom.value }));
  custom.addEventListener('change', endStyleGesture);
}
function paintSwatches() {
  document.querySelectorAll('#swatches .swatch[data-color]').forEach((b) => { b.style.background = R.inkColor(b.dataset.color, isDark); });
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------
let renderQueued = false, thumbsDirty = true;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}
const renderCtx = () => ({ dark: isDark, zoom: camera.zoom, image: getImage, editingId: editing ? editing.item.id : null });

function render() {
  if (!page) return;
  const th = R.themeColors(isDark);
  const W = canvas.width, H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = page.kind === 'paper' ? th.desk : th.paper;
  ctx.fillRect(0, 0, W, H);
  const z = camera.zoom;
  ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * camera.panX, dpr * camera.panY);
  const view = viewRect();
  const rc = renderCtx();

  if (page.kind === 'paper') {
    const pr = { minX: 0, minY: 0, maxX: page.w, maxY: page.h };
    ctx.save();
    ctx.shadowColor = isDark ? 'rgba(0,0,0,0.5)' : 'rgba(20,24,32,0.16)';
    ctx.shadowBlur = 28 * dpr; ctx.shadowOffsetY = 6 * dpr;
    ctx.fillStyle = th.sheet; ctx.fillRect(0, 0, page.w, page.h);
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, page.w, page.h); ctx.clip();
    const tl = { x: Math.max(0, view.minX), y: Math.max(0, view.minY) }, br = { x: Math.min(page.w, view.maxX), y: Math.min(page.h, view.maxY) };
    if (G.rectsIntersect(view, pr)) R.drawTemplate(ctx, page.template, th, tl, br, z, page);
    R.drawPageItems(ctx, page, rc, view);
    drawOverlaysWorld(th);
    ctx.restore();
    ctx.save(); ctx.strokeStyle = th.sheetEdge; ctx.lineWidth = 1 / z; ctx.strokeRect(0, 0, page.w, page.h); ctx.restore();
  } else {
    R.drawTemplate(ctx, page.template, th, { x: view.minX, y: view.minY }, { x: view.maxX, y: view.maxY }, z, null);
    R.drawPageItems(ctx, page, rc, view);
    drawOverlaysWorld(th);
  }
  drawSelection(th);
  drawLaser();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawEraserCursor();
  positionSelBar();
  if (editing) positionEditor();
  $('zoomVal').textContent = Math.round(camera.zoom * 100) + '%';
}
function drawOverlaysWorld(th) {
  const rc = renderCtx();
  if (shapeDraft) {
    const fake = draftShape();
    if (fake) { ctx.save(); ctx.globalAlpha = 0.8; R.drawItem(ctx, fake, rc); ctx.restore(); }
    if (TEXT_TOOLS.has(shapeDraft.type) && shapeDraft.moved) {
      const r = G.normalizeRect(shapeDraft.start, shapeDraft.end);
      ctx.save(); ctx.strokeStyle = th.select; ctx.lineWidth = 1 / camera.zoom; ctx.setLineDash([5 / camera.zoom, 4 / camera.zoom]);
      ctx.strokeRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY); ctx.restore();
    }
  }
  if (connectorDraft) {
    const from = findItem(connectorDraft.fromId);
    if (from) {
      const target = connectorDraft.hoverId ? findItem(connectorDraft.hoverId) : null;
      if (target) outlineItem(target, th, true);
      outlineItem(from, th, true);
      R.drawConnector(ctx, { color: settings.styles.connector.color, width: settings.styles.connector.size }, from, null, rc, connectorDraft.cur);
    }
  }
}
function outlineItem(it, th, solid) {
  const b = G.isShape(it) ? G.shapeRect(it) : G.getBBox(it), pad = 4 / camera.zoom;
  ctx.save();
  ctx.strokeStyle = th.select; ctx.lineWidth = 1.25 / camera.zoom;
  if (!solid) ctx.setLineDash([4 / camera.zoom, 3 / camera.zoom]);
  ctx.strokeRect(b.minX - pad, b.minY - pad, b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2);
  ctx.restore();
}
function selectionBBox() {
  const items = selectedItems();
  return items.length ? G.itemsBBox(items) : null;
}
function selectionHandles() {
  const items = selectedItems();
  if (!items.length || dragState) return [];
  if (items.length === 1 && (items[0].type === 'line' || items[0].type === 'arrow')) {
    return items[0].points.map((p, i) => ({ kind: 'end', index: i, x: p.x, y: p.y }));
  }
  const b = G.itemsBBox(items), pad = 6 / camera.zoom;
  const x0 = b.minX - pad, y0 = b.minY - pad, x1 = b.maxX + pad, y1 = b.maxY + pad;
  return [
    { kind: 'corner', cx: 0, cy: 0, x: x0, y: y0 }, { kind: 'corner', cx: 1, cy: 0, x: x1, y: y0 },
    { kind: 'corner', cx: 0, cy: 1, x: x0, y: y1 }, { kind: 'corner', cx: 1, cy: 1, x: x1, y: y1 },
  ];
}
function drawSelection(th) {
  const z = camera.zoom;
  if (rubberBand) {
    const r = G.normalizeRect(rubberBand.start, rubberBand.cur);
    ctx.save(); ctx.fillStyle = th.selectFill; ctx.strokeStyle = th.select; ctx.lineWidth = 1 / z;
    ctx.fillRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY); ctx.strokeRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY); ctx.restore();
  }
  if (!selected.size) return;
  const items = selectedItems();
  if (items.length > 1) for (const it of items) outlineItem(it, th, false);
  const handles = selectionHandles();
  if (!(items.length === 1 && (items[0].type === 'line' || items[0].type === 'arrow'))) {
    const b = G.itemsBBox(items), pad = 6 / z;
    ctx.save(); ctx.strokeStyle = th.select; ctx.lineWidth = 1.5 / z;
    ctx.strokeRect(b.minX - pad, b.minY - pad, b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2); ctx.restore();
  }
  const hs = (coarse() ? 7 : 5) / z;
  ctx.save();
  ctx.fillStyle = isDark ? '#1C1D21' : '#FFFFFF'; ctx.strokeStyle = th.select; ctx.lineWidth = 1.5 / z;
  for (const h of handles) {
    ctx.beginPath();
    if (h.kind === 'end') ctx.arc(h.x, h.y, hs, 0, Math.PI * 2);
    else ctx.rect(h.x - hs, h.y - hs, hs * 2, hs * 2);
    ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}
function drawEraserCursor() {
  if (!ERASERS.has(state.tool) || !hoverScreen || panState || pinch) return;
  ctx.save();
  ctx.beginPath(); ctx.arc(hoverScreen.x, hoverScreen.y, settings.eraserRadius, 0, Math.PI * 2);
  ctx.fillStyle = state.tool === 'eraser-stroke' ? 'rgba(255,92,92,0.08)' : 'rgba(53,224,198,0.08)';
  ctx.strokeStyle = state.tool === 'eraser-stroke' ? 'rgba(229,72,72,0.9)' : (isDark ? 'rgba(53,224,198,0.9)' : 'rgba(10,122,107,0.9)');
  ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.fill(); ctx.stroke();
  ctx.restore();
}

// ---- laser -----------------------------------------------------------------
let laserTrail = [];
const LASER_LIFE = 900;
function drawLaser() {
  const now = performance.now(), z = camera.zoom;
  laserTrail = laserTrail.filter((p) => now - p.t < LASER_LIFE);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (laserTrail.length) {
    ctx.shadowColor = 'rgba(255,59,59,0.6)'; ctx.shadowBlur = 10 * dpr;
    for (let i = 1; i < laserTrail.length; i++) {
      const a = laserTrail[i - 1], b = laserTrail[i];
      if (b.gap) continue;
      const life = 1 - (now - b.t) / LASER_LIFE;
      ctx.strokeStyle = `rgba(255,59,59,${0.85 * life})`;
      ctx.lineWidth = (2 + 4 * life) / z;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    requestRender();
  }
  if (state.tool === 'laser' && hoverScreen) {
    const w = screenToWorld(hoverScreen.x, hoverScreen.y);
    ctx.shadowColor = 'rgba(255,59,59,0.7)'; ctx.shadowBlur = 12 * dpr;
    ctx.fillStyle = '#FF3B3B';
    ctx.beginPath(); ctx.arc(w.x, w.y, (laserDown ? 6 : 4.5) / z, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------
const pointers = new Map();            // id -> {x,y,type}
let panState = null, pinch = null, spaceDown = false, hoverScreen = null;
let drawState = null, eraseState = null, dragState = null, rubberBand = null;
let shapeDraft = null, connectorDraft = null, laserDown = false;
let lastTap = null;

const pressureOf = (e) => (e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5);
function coalesced(e) {
  if (typeof e.getCoalescedEvents === 'function') { const l = e.getCoalescedEvents(); if (l && l.length) return l; }
  return [e];
}
function touchCount() { let n = 0; for (const p of pointers.values()) if (p.type === 'touch') n++; return n; }

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
canvas.addEventListener('pointerleave', () => { hoverScreen = null; if (ERASERS.has(state.tool)) requestRender(); });

function onPointerDown(e) {
  if (editing) closeEditor(true);
  closePopovers();
  if (isPhone() && !stylePanel.hidden) setStyleOpen(false);
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  hoverScreen = { x: e.clientX, y: e.clientY };

  if (e.pointerType === 'pen' && !settings.touchPans && settings.touchPansAuto) {
    settings.touchPans = true; settings.touchPansAuto = false; saveSettings();
    toast('Stylus detected — fingers now pan and zoom. Change this in Settings.');
  }

  if (e.pointerType === 'touch' && touchCount() >= 2) { cancelActions(); startPinch(); return; }
  if (e.button === 1) { e.preventDefault(); startPan(e); return; }
  if (e.button === 2) return;
  if (e.pointerType === 'touch' && settings.touchPans) { startPan(e); return; }

  const t = state.tool;
  const shiftPans = e.shiftKey && (t === 'pen' || t === 'highlighter' || ERASERS.has(t) || t === 'laser' || t === 'hand');
  if (spaceDown || t === 'hand' || shiftPans) { startPan(e); return; }
  if (e.button !== 0) return;

  const p = screenToWorld(e.clientX, e.clientY);
  if (t === 'pen' || t === 'highlighter') startStroke(e, p);
  else if (ERASERS.has(t)) startErase(e, p);
  else if (t === 'select') startSelect(e, p);
  else if (SHAPE_TOOLS.has(t) || TEXT_TOOLS.has(t)) startShapeDraft(e, p);
  else if (t === 'connector') startConnector(p);
  else if (t === 'laser') { laserDown = true; laserTrail.push({ x: p.x, y: p.y, t: performance.now(), gap: true }); requestRender(); }
}
function onPointerMove(e) {
  const known = pointers.get(e.pointerId);
  if (known) { known.x = e.clientX; known.y = e.clientY; }
  hoverScreen = { x: e.clientX, y: e.clientY };
  if (pinch && touchCount() >= 2) { updatePinch(); return; }
  if (panState) { if (panState.pointerId === e.pointerId) updatePan(e); return; }
  if (!known) { onHover(e); return; }
  if (drawState) return moveStroke(e);
  if (eraseState) return moveErase(e);
  if (dragState) return moveDrag(e);
  if (rubberBand) return moveRubber(e);
  if (shapeDraft) return moveShapeDraft(e);
  if (connectorDraft) return moveConnector(e);
  if (laserDown) {
    const now = performance.now();
    for (const ev of coalesced(e)) { const w = screenToWorld(ev.clientX, ev.clientY); laserTrail.push({ x: w.x, y: w.y, t: now }); }
    requestRender();
  }
  updateCoords();
}
function onHover(e) {
  updateCoords();
  if (ERASERS.has(state.tool)) requestRender();
  if (state.tool === 'laser' && e.pointerType === 'mouse') {
    const w = screenToWorld(e.clientX, e.clientY);
    laserTrail.push({ x: w.x, y: w.y, t: performance.now() });
    requestRender();
  }
  if (state.tool === 'select' && !spaceDown) {
    const p = screenToWorld(e.clientX, e.clientY);
    const h = handleAt(e.clientX, e.clientY);
    if (h) canvas.style.cursor = h.kind === 'end' ? 'move' : ((h.cx ^ h.cy) ? 'nesw-resize' : 'nwse-resize');
    else canvas.style.cursor = hitTest(p, true) ? 'move' : 'default';
  }
}
function onPointerUp(e) {
  const wasDragging = dragState;
  pointers.delete(e.pointerId);
  if (pinch && touchCount() < 2) { pinch = null; }
  if (panState && panState.pointerId === e.pointerId) endPan();
  if (drawState) endStroke(e);
  if (eraseState) endErase();
  if (dragState) endDrag();
  if (rubberBand) endRubber();
  if (shapeDraft) commitShapeDraft();
  if (connectorDraft) endConnector(e);
  if (laserDown) { laserDown = false; requestRender(); }
  try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
  // Touch double-tap opens the text editor (dblclick is unreliable on touch).
  if (e.type === 'pointerup' && e.pointerType !== 'mouse' && (state.tool === 'select' || TEXT_TOOLS.has(state.tool)) && !(wasDragging && wasDragging.moved)) {
    const now = performance.now();
    if (lastTap && now - lastTap.t < 330 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 28) {
      const hit = hitTest(screenToWorld(e.clientX, e.clientY), true);
      if (hit && G.isText(hit)) openEditor(hit, false);
      lastTap = null;
    } else lastTap = { t: now, x: e.clientX, y: e.clientY };
  }
  requestRender();
}
canvas.addEventListener('dblclick', (e) => {
  if (state.tool !== 'select' && !TEXT_TOOLS.has(state.tool)) return;
  const p = screenToWorld(e.clientX, e.clientY);
  const hit = hitTest(p, true);
  if (hit && G.isText(hit)) openEditor(hit, false);
  else if (state.tool === 'select' && !hit) {
    // Double-click empty space to drop a text label right there.
    const it = createTextItem('text', p, null);
    openEditor(it, true);
  }
});
function cancelActions() {
  // Drop the tiny stray stroke the first finger began before the second landed.
  if (drawState) {
    const s = drawState.stroke;
    if (s.points && s.points.length < 6) { page.strokes = page.strokes.filter((x) => x !== s); history.pop(); updateUndoButtons(); }
    clearTimeout(drawState.snapTimer);
  }
  if (eraseState && eraseState.pushed && !eraseState.changed) { history.pop(); updateUndoButtons(); }
  drawState = eraseState = dragState = rubberBand = shapeDraft = connectorDraft = null;
  panState = null; laserDown = false;
  requestRender();
}

// ---- pan / pinch / wheel ---------------------------------------------------
function startPan(e) {
  panState = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, px: camera.panX, py: camera.panY };
  cancelAnimationFrame(camAnim);
  canvas.style.cursor = 'grabbing';
}
function updatePan(e) {
  camera.panX = panState.px + (e.clientX - panState.sx);
  camera.panY = panState.py + (e.clientY - panState.sy);
  requestRender();
}
function endPan() { panState = null; updateCursor(); }
function startPinch() {
  const pts = [...pointers.values()].filter((p) => p.type === 'touch');
  if (pts.length < 2) return;
  const [a, b] = pts, mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  panState = null;
  cancelAnimationFrame(camAnim);
  pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: camera.zoom, mid: screenToWorld(mid.x, mid.y) };
}
function updatePinch() {
  const pts = [...pointers.values()].filter((p) => p.type === 'touch');
  if (pts.length < 2 || !pinch) return;
  const [a, b] = pts, d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  camera.zoom = G.clamp(pinch.z0 * (d / pinch.d0), MIN_ZOOM, MAX_ZOOM);
  camera.panX = mid.x - pinch.mid.x * camera.zoom;
  camera.panY = mid.y - pinch.mid.y * camera.zoom;
  requestRender();
}
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cancelAnimationFrame(camAnim);
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
  const dx = e.deltaX * k, dy = e.deltaY * k;
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.01));
  else if (settings.wheelPans) { camera.panX -= e.shiftKey ? dy : dx; camera.panY -= e.shiftKey ? 0 : dy; requestRender(); }
  else zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0016));
  if (editing) positionEditor();
}, { passive: false });
// Safari trackpad pinch
let gestureZoom = 1;
window.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureZoom = 1; });
window.addEventListener('gesturechange', (e) => { e.preventDefault(); zoomAt(e.clientX || innerWidth / 2, e.clientY || innerHeight / 2, e.scale / gestureZoom); gestureZoom = e.scale; });
window.addEventListener('gestureend', (e) => e.preventDefault());

// ---- pen / highlighter -----------------------------------------------------
function startStroke(e, p) {
  pushHistory();
  const hl = state.tool === 'highlighter';
  const st = settings.styles[hl ? 'highlighter' : 'pen'];
  const stroke = { id: newId(), type: hl ? 'highlighter' : 'stroke', color: st.color, baseWidth: hl ? st.size * 2.6 : st.size, points: [{ x: p.x, y: p.y, p: hl ? 1 : pressureOf(e) }] };
  page.strokes.push(stroke);
  drawState = { stroke, smooth: { x: p.x, y: p.y }, last: p, snapped: null, snapTimer: null, hl };
  requestRender();
}
function moveStroke(e) {
  const ds = drawState;
  const evs = coalesced(e);
  if (ds.snapped) {
    // After a snap, keep dragging to adjust the end of a line or arrow.
    if (ds.snapped === 'line' || ds.snapped === 'arrow') {
      const w = screenToWorld(e.clientX, e.clientY), pts = ds.stroke.points, endPt = pts[pts.length - 1];
      endPt.x = w.x; endPt.y = w.y; G.invalidate(ds.stroke); requestRender();
    }
    return;
  }
  const minDist = 1.1 / camera.zoom;
  const k = 1 - G.clamp(settings.smoothing, 0, 85) / 100;
  for (const ev of evs) {
    const raw = screenToWorld(ev.clientX, ev.clientY);
    ds.smooth.x += (raw.x - ds.smooth.x) * k;
    ds.smooth.y += (raw.y - ds.smooth.y) * k;
    if (Math.hypot(ds.smooth.x - ds.last.x, ds.smooth.y - ds.last.y) < minDist) continue;
    ds.stroke.points.push({ x: ds.smooth.x, y: ds.smooth.y, p: ds.hl ? 1 : pressureOf(ev) });
    ds.last = { x: ds.smooth.x, y: ds.smooth.y };
  }
  if (!ds.hl && settings.snap) {
    clearTimeout(ds.snapTimer);
    ds.snapTimer = setTimeout(snapStroke, 600);
  }
  updateCoords();
  requestRender();
}
function snapStroke() {
  const ds = drawState;
  if (!ds || ds.snapped || ds.hl) return;
  const s = ds.stroke, res = G.classifyStroke(s.points);
  if (!res) return;
  const width = settings.styles.pen.size;
  if (res.type === 'line') {
    const p0 = s.points[0], p1 = s.points[s.points.length - 1];
    s.points = [{ x: p0.x, y: p0.y, p: 0.5 }, { x: p1.x, y: p1.y, p: 0.5 }];
    ds.snapped = 'line';
  } else {
    const shape = { id: s.id, type: res.type, color: s.color, baseWidth: width, points: res.points.map((q) => ({ x: q.x, y: q.y })) };
    const idx = page.strokes.indexOf(s);
    if (idx >= 0) page.strokes[idx] = shape;
    ds.stroke = shape;
    ds.snapped = res.type === 'arrow' ? 'arrow' : 'shape';
  }
  G.invalidate(ds.stroke);
  if (navigator.vibrate) try { navigator.vibrate(8); } catch (e) {}
  toast('Snapped to ' + ({ line: 'line', arrow: 'arrow', rect: 'rectangle', ellipse: 'ellipse', triangle: 'triangle' })[res.type]);
  requestRender();
}
function endStroke(e) {
  const ds = drawState;
  clearTimeout(ds.snapTimer);
  if (!ds.snapped && e && e.type === 'pointerup') {
    const raw = screenToWorld(e.clientX, e.clientY), pts = ds.stroke.points, last = pts[pts.length - 1];
    if (Math.hypot(raw.x - last.x, raw.y - last.y) > 0.5 / camera.zoom && pts.length > 1) pts.push({ x: raw.x, y: raw.y, p: last.p });
  }
  G.invalidate(ds.stroke);
  drawState = null;
  markDirty();
}

// ---- erasers ---------------------------------------------------------------
function startErase(e, p) {
  pushHistory();
  eraseState = { mode: state.tool === 'eraser-stroke' ? 'stroke' : 'precision', changed: false, pushed: true };
  eraseAt(p);
}
function moveErase(e) {
  for (const ev of coalesced(e)) eraseAt(screenToWorld(ev.clientX, ev.clientY));
}
function eraseAt(center) {
  const r = settings.eraserRadius / camera.zoom;
  const before = page.strokes.length, beforeC = page.connectors.length;
  let changed = false;
  if (eraseState.mode === 'stroke') {
    page.strokes = page.strokes.filter((s) => {
      if (s.locked) return true;
      const hit = G.isShape(s) ? G.hitShape(s, center, r) : G.strokeHitByCircle(s, center, r);
      return !hit;
    });
  } else {
    const next = [];
    for (const s of page.strokes) {
      if (s.locked) { next.push(s); continue; }
      if (G.isShape(s)) { if (!G.hitShape(s, center, r)) next.push(s); else changed = true; continue; }
      const parts = G.splitStrokeByEraser(s, center, r, newId);
      if (parts.length !== 1 || parts[0] !== s) changed = true;
      next.push(...parts);
    }
    page.strokes = next;
  }
  const byId = new Map(allItems().map((it) => [it.id, it]));
  page.connectors = page.connectors.filter((c) => {
    const a = byId.get(c.fromId), b = byId.get(c.toId);
    if (!a || !b) return false;
    const [p, q] = R.connectorEnds(a, b);
    return G.distToSegment(center, p, q) > r;
  });
  if (changed || page.strokes.length !== before || page.connectors.length !== beforeC) { eraseState.changed = true; requestRender(); }
  requestRender();
}
function endErase() {
  if (!eraseState.changed) { history.pop(); updateUndoButtons(); }
  else markDirty();
  eraseState = null;
}

// ---- hit testing -------------------------------------------------------------
function hitTest(p, forSelect, filter) {
  const tol = (coarse() ? 10 : 6) / camera.zoom;
  for (let i = page.strokes.length - 1; i >= 0; i--) {
    const s = page.strokes[i];
    if (forSelect && s.locked) continue;
    if (filter && !filter(s)) continue;
    if (G.hitItem(s, p, tol)) return s;
  }
  for (let i = page.media.length - 1; i >= 0; i--) {
    const m = page.media[i];
    if (forSelect && m.locked) continue;
    if (filter && !filter(m)) continue;
    if (G.hitItem(m, p, tol)) return m;
  }
  return null;
}
function handleAt(sx, sy) {
  const tol = coarse() ? 20 : 9;
  for (const h of selectionHandles()) {
    const s = worldToScreen(h.x, h.y);
    if (Math.abs(s.x - sx) <= tol && Math.abs(s.y - sy) <= tol) return h;
  }
  return null;
}

// ---- select / move / scale ----------------------------------------------------
function startSelect(e, p) {
  const h = handleAt(e.clientX, e.clientY);
  if (h) {
    const items = selectedItems();
    if (h.kind === 'end') {
      dragState = { mode: 'end', item: items[0], index: h.index, moved: false };
    } else {
      const b = G.itemsBBox(items);
      const pivot = { x: h.cx ? b.minX : b.maxX, y: h.cy ? b.minY : b.maxY };
      const grab = { x: h.cx ? b.maxX : b.minX, y: h.cy ? b.maxY : b.minY };
      dragState = {
        mode: 'scale', items, pivot, grab, moved: false,
        keepAspect: items.every((it) => G.isMedia(it) || it.type === 'sticky'),
        base: items.map((it) => structuredClone(G.isMedia(it) ? { x: it.x, y: it.y, w: it.w, h: it.h } : { points: it.points, baseWidth: it.baseWidth, fontSize: it.fontSize })),
      };
    }
    requestRender();
    return;
  }
  const hit = hitTest(p, true);
  if (hit) {
    if (e.shiftKey) {
      if (selected.has(hit.id)) selected.delete(hit.id); else selected.add(hit.id);
    } else if (!selected.has(hit.id)) { selected.clear(); selected.add(hit.id); }
    dragState = { mode: 'move', last: p, moved: false, alt: e.altKey };
  } else {
    if (!e.shiftKey) selected.clear();
    rubberBand = { start: p, cur: p, base: new Set(selected) };
  }
  updateStylePanel();
  requestRender();
}
function moveDrag(e) {
  const p = screenToWorld(e.clientX, e.clientY);
  const ds = dragState;
  if (!ds.moved) {
    const s0 = ds.mode === 'move' ? worldToScreen(ds.last.x, ds.last.y) : null;
    if (s0 && Math.hypot(e.clientX - s0.x, e.clientY - s0.y) < 3) return;
    pushHistory();
    ds.moved = true;
    if (ds.mode === 'move' && ds.alt) duplicateSelection(0);
  }
  if (ds.mode === 'move') {
    const dx = p.x - ds.last.x, dy = p.y - ds.last.y;
    for (const it of selectedItems()) G.translateItem(it, dx, dy);
    ds.last = p;
  } else if (ds.mode === 'end') {
    let q = { x: p.x, y: p.y };
    if (e.shiftKey) q = snapAngle(ds.item.points[1 - ds.index], q);
    ds.item.points[ds.index].x = q.x; ds.item.points[ds.index].y = q.y;
    G.invalidate(ds.item);
  } else {
    const { pivot, grab } = ds;
    const w0 = grab.x - pivot.x || 1e-6, h0 = grab.y - pivot.y || 1e-6;
    let sx = (p.x - pivot.x) / w0, sy = (p.y - pivot.y) / h0;
    sx = Math.max(0.02, sx); sy = Math.max(0.02, sy);
    if (ds.keepAspect !== e.shiftKey) { const s = Math.max(sx, sy); sx = sy = s; }
    ds.items.forEach((it, i) => G.scaleItem(it, pivot.x, pivot.y, sx, sy, ds.base[i]));
  }
  requestRender();
}
function endDrag() {
  const ds = dragState;
  dragState = null;
  if (ds.moved) {
    if (ds.mode === 'scale') for (const it of ds.items) if (G.isText(it)) { if (it.type === 'text') it.autoWidth = false; fitTextBox(it); }
    markDirty();
  }
  updateStylePanel();
  requestRender();
}
function moveRubber(e) {
  rubberBand.cur = screenToWorld(e.clientX, e.clientY);
  const r = G.normalizeRect(rubberBand.start, rubberBand.cur);
  selected.clear();
  for (const id of rubberBand.base) selected.add(id);
  for (const it of allItems()) if (!it.locked && G.rectsIntersect(G.getBBox(it), r)) selected.add(it.id);
  requestRender();
}
function endRubber() { rubberBand = null; updateStylePanel(); requestRender(); }
function snapAngle(origin, q) {
  const dx = q.x - origin.x, dy = q.y - origin.y, len = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: origin.x + Math.cos(ang) * len, y: origin.y + Math.sin(ang) * len };
}

// ---- selection actions ----------------------------------------------------
function deleteSelection() {
  if (!selected.size) return;
  pushHistory();
  page.strokes = page.strokes.filter((s) => !selected.has(s.id));
  page.media = page.media.filter((m) => !selected.has(m.id));
  pruneConnectors();
  selected.clear();
  markDirty(); updateStylePanel(); requestRender();
}
function pruneConnectors() {
  const ids = new Set(allItems().map((it) => it.id));
  page.connectors = page.connectors.filter((c) => ids.has(c.fromId) && ids.has(c.toId));
}
function cloneItemsWithConnectors(items, connectors, offset) {
  const idMap = new Map();
  const clones = items.map((it) => {
    const c = structuredClone(it);
    c.id = newId(); idMap.set(it.id, c.id);
    if (offset) G.translateItem(c, offset, offset);
    delete c.locked;
    return c;
  });
  const conns = connectors.filter((c) => idMap.has(c.fromId) && idMap.has(c.toId)).map((c) => ({ ...c, id: newId(), fromId: idMap.get(c.fromId), toId: idMap.get(c.toId) }));
  return { clones, conns };
}
function insertItems(clones, conns) {
  for (const c of clones) (G.isMedia(c) ? page.media : page.strokes).push(c);
  page.connectors.push(...conns);
  selected.clear();
  for (const c of clones) selected.add(c.id);
}
function duplicateSelection(offset = 24) {
  if (!selected.size) return;
  if (offset) pushHistory();
  const { clones, conns } = cloneItemsWithConnectors(selectedItems(), page.connectors, offset / (offset ? camera.zoom : 1));
  insertItems(clones, conns);
  markDirty(); requestRender();
}
function reorderSelection(toFront) {
  if (!selected.size) return;
  pushHistory();
  const sortArr = (arr) => {
    const sel = arr.filter((it) => selected.has(it.id)), rest = arr.filter((it) => !selected.has(it.id));
    return toFront ? [...rest, ...sel] : [...sel, ...rest];
  };
  page.strokes = sortArr(page.strokes); page.media = sortArr(page.media);
  markDirty(); requestRender();
}
function lockSelection() {
  if (!selected.size) return;
  pushHistory();
  for (const it of selectedItems()) it.locked = true;
  const n = selected.size;
  selected.clear();
  markDirty(); updateStylePanel(); requestRender();
  toast(`${n === 1 ? 'Item' : n + ' items'} locked. Unlock from the page menu.`);
}
function unlockAll(p = page) {
  let n = 0;
  for (const it of [...p.strokes, ...p.media]) if (it.locked) n++;
  if (!n) { toast('Nothing on this page is locked'); return; }
  pushHistory();
  for (const it of [...p.strokes, ...p.media]) delete it.locked;
  markDirty(); requestRender();
  toast(`${n} item${n === 1 ? '' : 's'} unlocked`);
}
function selectAll() {
  setTool('select');
  for (const it of allItems()) if (!it.locked) selected.add(it.id);
  updateStylePanel(); requestRender();
}
function nudge(dx, dy) {
  if (!selected.size) return;
  if (!nudgeActive) { pushHistory(); nudgeActive = true; }
  for (const it of selectedItems()) G.translateItem(it, dx / camera.zoom, dy / camera.zoom);
  markDirty(); requestRender();
}
let nudgeActive = false;

// selection toolbar
const selBar = $('selBar');
function positionSelBar() {
  const items = selectedItems();
  if (!items.length || dragState || rubberBand || editing || state.tool !== 'select' || document.body.classList.contains('zen')) { selBar.hidden = true; return; }
  selBar.hidden = false;
  selBar.querySelector('[data-act="edit"]').hidden = !(items.length === 1 && G.isText(items[0]));
  const b = G.itemsBBox(items), a = worldToScreen(b.minX, b.minY), z = worldToScreen(b.maxX, b.maxY);
  const r = selBar.getBoundingClientRect();
  const topLimit = isPhone() ? 64 : 64;
  let y = a.y - r.height - 14;
  if (y < topLimit) y = z.y + 14;
  const bottomLimit = innerHeight - (isPhone() ? 80 : 12) - r.height;
  y = G.clamp(y, topLimit, Math.max(topLimit, bottomLimit));
  const x = G.clamp((a.x + z.x) / 2 - r.width / 2, 8, innerWidth - r.width - 8);
  selBar.style.left = Math.round(x) + 'px'; selBar.style.top = Math.round(y) + 'px';
}
selBar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'delete') deleteSelection();
  else if (act === 'duplicate') duplicateSelection();
  else if (act === 'front') reorderSelection(true);
  else if (act === 'back') reorderSelection(false);
  else if (act === 'lock') lockSelection();
  else if (act === 'edit') { const it = selectedItems()[0]; if (it && G.isText(it)) openEditor(it, false); }
});

// ---- shapes & text items ------------------------------------------------------
function startShapeDraft(e, p) {
  if (TEXT_TOOLS.has(state.tool)) {
    const hit = hitTest(p, true, G.isText);
    if (hit) { openEditor(hit, false); return; }
  }
  shapeDraft = { type: state.tool, start: p, end: p, moved: false, sx: e.clientX, sy: e.clientY };
  requestRender();
}
function moveShapeDraft(e) {
  let end = screenToWorld(e.clientX, e.clientY);
  if (!shapeDraft.moved && Math.hypot(e.clientX - shapeDraft.sx, e.clientY - shapeDraft.sy) < 4) return;
  shapeDraft.moved = true;
  const { start, type } = shapeDraft;
  if (e.shiftKey) {
    if (type === 'line' || type === 'arrow') end = snapAngle(start, end);
    else {
      const dx = end.x - start.x, dy = end.y - start.y, s = Math.max(Math.abs(dx), Math.abs(dy));
      end = { x: start.x + Math.sign(dx || 1) * s, y: start.y + Math.sign(dy || 1) * s };
    }
  }
  shapeDraft.end = end;
  updateCoords();
  requestRender();
}
function draftShape() {
  const d = shapeDraft;
  if (!d || !d.moved || TEXT_TOOLS.has(d.type)) return null;
  const st = settings.styles.shape;
  return { id: -1, type: d.type, color: st.color, baseWidth: st.size, fill: st.fill, dash: st.dash, points: [{ ...d.start }, { ...d.end }] };
}
function commitShapeDraft() {
  const d = shapeDraft;
  shapeDraft = null;
  if (TEXT_TOOLS.has(d.type)) {
    const rect = d.moved ? G.normalizeRect(d.start, d.end) : null;
    const usable = rect && (rect.maxX - rect.minX) * camera.zoom > 24 ? rect : null;
    const it = createTextItem(d.type, d.start, usable);
    openEditor(it, true);
    return;
  }
  const st = settings.styles.shape;
  let a = d.start, b = d.end;
  if (!d.moved) {
    if (d.type === 'line' || d.type === 'arrow') { requestRender(); return; }
    // A plain click drops a default-size shape centred on the cursor.
    const w = 160 / Math.max(camera.zoom, 0.25), h = (d.type === 'rect' || d.type === 'ellipse' ? 100 : 140) / Math.max(camera.zoom, 0.25);
    a = { x: d.start.x - w / 2, y: d.start.y - h / 2 }; b = { x: d.start.x + w / 2, y: d.start.y + h / 2 };
  }
  pushHistory();
  const shape = { id: newId(), type: d.type, color: st.color, baseWidth: st.size, points: [{ ...a }, { ...b }] };
  if (st.fill && st.fill !== 'none' && !['line', 'arrow'].includes(d.type)) shape.fill = st.fill;
  if (st.dash) shape.dash = true;
  page.strokes.push(shape);
  markDirty(); requestRender();
}
function createTextItem(type, at, rect) {
  const st = settings.styles[type] || settings.styles.text;
  // When zoomed out, new text is enlarged so it still reads at a sensible size on screen.
  const k = G.clamp(1 / camera.zoom, 1, 4);
  const fontSize = st.size * k;
  pushHistory();
  const it = { id: newId(), type, color: st.color, baseWidth: 2, fontSize, text: '' };
  if (type === 'text') {
    const lineH = fontSize * 1.3 + R.TEXT_PAD.text * 2;
    if (rect) { it.points = [{ x: rect.minX, y: rect.minY }, { x: rect.maxX, y: rect.minY + lineH }]; it.autoWidth = false; }
    else { it.points = [{ x: at.x, y: at.y - lineH / 2 }, { x: at.x + 8, y: at.y + lineH / 2 }]; it.autoWidth = true; }
  } else {
    const w = rect ? rect.maxX - rect.minX : (type === 'sticky' ? 200 : 170) * k;
    const h = rect ? Math.max(rect.maxY - rect.minY, fontSize * 2) : (type === 'sticky' ? 200 : 60) * k;
    const x0 = rect ? rect.minX : at.x - w / 2, y0 = rect ? rect.minY : at.y - h / 2;
    it.points = [{ x: x0, y: y0 }, { x: x0 + w, y: y0 + h }];
  }
  page.strokes.push(it);
  markDirty();
  return it;
}
function fitTextBox(it) {
  const fs = it.fontSize || R.defaultFontSize(it.type), pad = R.TEXT_PAD[it.type];
  const r = G.shapeRect(it);
  if (it.type === 'text') {
    if (it.autoWidth) {
      const m = R.measureText('text', it.text || ' ', fs, 0);
      it.points = [{ x: r.minX, y: r.minY }, { x: r.minX + m.width + pad * 2 + 2, y: r.minY + m.height + pad * 2 }];
    } else {
      const m = R.measureText('text', it.text || ' ', fs, Math.max(4, r.maxX - r.minX - pad * 2));
      it.points = [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY + m.height + pad * 2 }];
    }
  } else {
    const m = R.measureText(it.type, it.text || ' ', fs, Math.max(4, r.maxX - r.minX - pad * 2));
    const need = m.height + pad * 2;
    if (need > r.maxY - r.minY) it.points = [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY + need }];
    else it.points = [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.maxY }];
  }
  G.invalidate(it);
}

// ---- text editor overlay -------------------------------------------------------
const editor = $('textEditor');
let editing = null;
function openEditor(item, isNew) {
  if (editing) closeEditor(true);
  editing = { item, isNew, before: isNew ? null : { kind: 'page', pageId: page.id, data: clonePageData(page) }, original: item.text || '' };
  if (state.tool === 'select') { selected.clear(); selected.add(item.id); }
  editor.value = item.text || '';
  editor.hidden = false;
  positionEditor();
  editor.focus({ preventScroll: true });
  if (!isNew) editor.select();
  requestRender();
}
function positionEditor() {
  if (!editing) return;
  const it = editing.item, z = camera.zoom, type = it.type;
  const fsW = it.fontSize || R.defaultFontSize(type), fs = fsW * z, lh = fs * 1.3, pad = R.TEXT_PAD[type] * z;
  const r = G.shapeRect(it), tl = worldToScreen(r.minX, r.minY);
  editor.style.font = R.textFont(type, fs);
  editor.style.lineHeight = lh + 'px';
  editor.style.color = type === 'sticky' ? '#1B1C20' : R.inkColor(it.color, isDark);
  editor.style.textAlign = type === 'node' ? 'center' : 'left';
  editor.style.left = tl.x + 'px';
  editor.style.top = tl.y + 'px';
  let w, h;
  if (type === 'text' && it.autoWidth) {
    const m = R.measureText('text', editor.value || ' ', fsW, 0);
    w = (m.width + 4) * z + pad * 2 + 12; h = m.height * z + pad * 2;
    editor.style.whiteSpace = 'pre';
  } else {
    w = (r.maxX - r.minX) * z;
    const m = R.measureText(type, editor.value || ' ', fsW, Math.max(4, r.maxX - r.minX - R.TEXT_PAD[type] * 2));
    h = Math.max((r.maxY - r.minY) * z, m.height * z + pad * 2);
    editor.style.whiteSpace = 'pre-wrap';
    if (type === 'node') {
      const contentH = m.height * z;
      const top = Math.max(pad, ((r.maxY - r.minY) * z - contentH) / 2);
      editor.style.padding = `${top}px ${pad}px ${pad}px`;
      editor.style.width = w + 'px'; editor.style.height = Math.max(h, contentH + top + pad) + 'px';
      return;
    }
  }
  editor.style.padding = pad + 'px';
  editor.style.width = w + 'px'; editor.style.height = h + 'px';
}
function closeEditor(commit) {
  if (!editing) return;
  const { item, isNew, before, original } = editing;
  editing = null;
  editor.hidden = true;
  editor.blur();
  const exists = page.strokes.includes(item);
  if (exists) {
    const text = commit ? editor.value.replace(/\s+$/, '') : original;
    if (item.type === 'text' && !text.trim()) {
      page.strokes = page.strokes.filter((s) => s !== item);
      pruneConnectors();
      selected.delete(item.id);
      if (isNew) { history.pop(); updateUndoButtons(); } else if (before) pushHistory(before);
    } else {
      item.text = text;
      fitTextBox(item);
      if (!isNew && before && text !== original) pushHistory(before);
    }
    markDirty();
  }
  updateStylePanel();
  requestRender();
}
editor.addEventListener('input', () => positionEditor());
editor.addEventListener('blur', () => { if (editing) closeEditor(true); });
editor.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); closeEditor(true); return; }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (editing && editing.item.type === 'node' && !e.shiftKey))) { e.preventDefault(); closeEditor(true); }
});

// ---- connectors -------------------------------------------------------------------
const anchorable = (it) => !(it.type === 'line' || it.type === 'arrow' || it.type === 'highlighter');
function startConnector(p) {
  const hit = hitTest(p, false, anchorable);
  if (hit) connectorDraft = { fromId: hit.id, cur: p, hoverId: null };
  else toast('Start the connector on a shape, text or image');
  requestRender();
}
function moveConnector(e) {
  connectorDraft.cur = screenToWorld(e.clientX, e.clientY);
  const hit = hitTest(connectorDraft.cur, false, anchorable);
  connectorDraft.hoverId = hit && hit.id !== connectorDraft.fromId ? hit.id : null;
  requestRender();
}
function endConnector(e) {
  const d = connectorDraft;
  connectorDraft = null;
  const hit = hitTest(screenToWorld(e.clientX, e.clientY), false, anchorable);
  if (hit && hit.id !== d.fromId) {
    pushHistory();
    const st = settings.styles.connector;
    page.connectors.push({ id: newId(), fromId: d.fromId, toId: hit.id, color: st.color, width: st.size });
    markDirty();
  }
  requestRender();
}

// ---- cursor / readout ------------------------------------------------------------
function updateCursor() {
  if (spaceDown) { canvas.style.cursor = 'grab'; return; }
  const t = state.tool;
  canvas.style.cursor = t === 'hand' ? 'grab' : ERASERS.has(t) ? 'none' : t === 'select' ? 'default' : t === 'text' ? 'text' : t === 'laser' ? 'none' : 'crosshair';
}
const coordEl = $('coordReadout');
function updateCoords() {
  if (!hoverScreen || !settings.showCoords) return;
  const w = screenToWorld(hoverScreen.x, hoverScreen.y);
  coordEl.textContent = `X ${Math.round(w.x)} · Y ${Math.round(w.y)}`;
}

// ---------------------------------------------------------------------------
// clipboard
// ---------------------------------------------------------------------------
const CLIP_PREFIX = 'vector-plane/clip:';
let localClip = null, pasteCount = 0;
function copySelection(cut) {
  if (!selected.size) return false;
  const items = structuredClone(selectedItems());
  const ids = new Set(items.map((i) => i.id));
  const connectors = structuredClone(page.connectors.filter((c) => ids.has(c.fromId) && ids.has(c.toId)));
  const usedAssets = {};
  for (const it of items) if (G.isMedia(it) && assets.has(it.assetId)) usedAssets[it.assetId] = assets.get(it.assetId);
  localClip = { items, connectors, assets: usedAssets };
  pasteCount = 0;
  try {
    const payload = JSON.stringify(localClip);
    if (payload.length < 4e6 && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(CLIP_PREFIX + payload).catch(() => {});
  } catch (e) {}
  if (cut) deleteSelection();
  toast(cut ? 'Cut' : `Copied ${items.length} item${items.length === 1 ? '' : 's'}`);
  return true;
}
async function pasteClip(clip) {
  if (!clip || !clip.items || !clip.items.length) return;
  for (const [id, url] of Object.entries(clip.assets || {})) if (!assets.has(id)) { assets.set(id, url); S.putAsset({ id, dataURL: url }); }
  pushHistory();
  pasteCount++;
  const { clones, conns } = cloneItemsWithConnectors(clip.items, clip.connectors || [], 0);
  const b = G.itemsBBox(clones), v = viewRect();
  let dx = 0, dy = 0;
  if (!G.rectsIntersect(b, v)) {
    const c = screenToWorld(innerWidth / 2, innerHeight / 2);
    dx = c.x - (b.minX + b.maxX) / 2; dy = c.y - (b.minY + b.maxY) / 2;
  } else { dx = dy = (24 * pasteCount) / camera.zoom; }
  for (const c of clones) G.translateItem(c, dx, dy);
  insertItems(clones, conns);
  setTool('select');
  for (const c of clones) selected.add(c.id);
  markDirty(); updateStylePanel(); requestRender();
}
window.addEventListener('copy', (e) => { if (isTypingTarget(e.target)) return; if (copySelection(false)) e.preventDefault(); });
window.addEventListener('cut', (e) => { if (isTypingTarget(e.target)) return; if (copySelection(true)) e.preventDefault(); });
window.addEventListener('paste', async (e) => {
  if (isTypingTarget(e.target)) return;
  const dt = e.clipboardData;
  if (!dt) { pasteClip(localClip); return; }
  const files = [...dt.files].filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf');
  if (files.length) { e.preventDefault(); handleFiles(files, hoverScreen); return; }
  const text = dt.getData('text/plain');
  if (text && text.startsWith(CLIP_PREFIX)) {
    e.preventDefault();
    try { pasteClip(JSON.parse(text.slice(CLIP_PREFIX.length))); } catch (err) { pasteClip(localClip); }
    return;
  }
  if (text && text.trim()) {
    e.preventDefault();
    const at = hoverScreen ? screenToWorld(hoverScreen.x, hoverScreen.y) : screenToWorld(innerWidth / 2, innerHeight / 2);
    const it = createTextItem('text', at, null);
    it.text = text.slice(0, 5000);
    fitTextBox(it);
    setTool('select'); selected.add(it.id); updateStylePanel();
    markDirty(); requestRender();
    return;
  }
  if (localClip) { e.preventDefault(); pasteClip(localClip); }
});

// ---------------------------------------------------------------------------
// import: images & PDFs
// ---------------------------------------------------------------------------
const scriptCache = new Map();
function loadScript(src) {
  if (!scriptCache.has(src)) {
    scriptCache.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = resolve; s.onerror = () => { scriptCache.delete(src); reject(new Error('load failed')); };
      document.head.appendChild(s);
    }));
  }
  return scriptCache.get(src);
}
async function ensurePdfJs() {
  await loadScript(CDN.pdf);
  if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
  return window.pdfjsLib;
}
function readAsDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
function loadImg(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
}
async function prepareImage(file) {
  // Very large photos are downscaled so the board stays light and fast.
  const url = await readAsDataURL(file);
  const img = await loadImg(url);
  const MAX = 2400, w = img.naturalWidth || 1, h = img.naturalHeight || 1;
  if (Math.max(w, h) <= MAX || file.type === 'image/svg+xml' || file.type === 'image/gif') return { url, w, h };
  const k = MAX / Math.max(w, h), cv = document.createElement('canvas');
  cv.width = Math.round(w * k); cv.height = Math.round(h * k);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  const out = file.type === 'image/png' || file.type === 'image/webp' ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.9);
  return { url: out, w: cv.width, h: cv.height };
}
async function importImage(file, at) {
  const { url, w, h } = await prepareImage(file);
  const assetId = await addAsset(url);
  let ww = Math.min(420, w), hh = ww * (h / w);
  if (page.kind === 'paper') { const k = Math.min(1, (page.w * 0.8) / ww, (page.h * 0.8) / hh); ww *= k; hh *= k; }
  const item = { id: newId(), kind: 'image', assetId, x: at.x - ww / 2, y: at.y - hh / 2, w: ww, h: hh };
  page.media.push(item);
  return item;
}
async function importPdf(file, at) {
  let lib;
  try { lib = await ensurePdfJs(); } catch (e) { toast('PDF support needs a connection the first time'); return 0; }
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const base = file.name.replace(/\.pdf$/i, '');
  const intoPages = page.kind === 'paper';
  let y = at.y, inserted = 0;
  for (let n = 1; n <= pdf.numPages; n++) {
    toast(`Importing ${base} — page ${n} of ${pdf.numPages}`, { sticky: true });
    const pg = await pdf.getPage(n);
    const vp1 = pg.getViewport({ scale: 1 });
    const scale = Math.min(2.5, 1800 / vp1.width);
    const vp = pg.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const c2 = cv.getContext('2d');
    c2.fillStyle = '#fff'; c2.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: c2, viewport: vp }).promise;
    const assetId = await addAsset(cv.toDataURL('image/jpeg', 0.88));
    if (intoPages) {
      const w = S.PAPER_W, h = Math.round(S.PAPER_W * (vp1.height / vp1.width));
      const p = makePage('paper', { name: pdf.numPages > 1 ? `${base} · ${n}` : base, template: 'blank', w, h });
      p.media.push({ id: newId(), kind: 'pdf', assetId, x: 0, y: 0, w, h, locked: true });
      doc.pages.splice(doc.currentPageIndex + 1 + inserted, 0, p);
    } else {
      const w = 600, h = w * (vp1.height / vp1.width);
      page.media.push({ id: newId(), kind: 'pdf', assetId, x: at.x - w / 2, y, w, h });
      y += h + 36;
    }
    inserted++;
  }
  if (intoPages && inserted) activatePage(doc.currentPageIndex + 1, { fit: true });
  return inserted;
}
async function handleFiles(fileList, screenPt) {
  const files = [...fileList];
  const json = files.find((f) => /\.json$/i.test(f.name) || f.type === 'application/json');
  if (json) { openFileObject(json); return; }
  const media = files.filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!media.length) { toast('Only PDFs, images and Vector Plane .json files can be opened'); return; }
  const hasPdf = media.some((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (hasPdf && page.kind === 'paper') pushDocHistory(); else pushHistory();
  let at = screenPt ? screenToWorld(screenPt.x, screenPt.y) : screenToWorld(innerWidth / 2, innerHeight / 2);
  let images = 0, pdfPages = 0;
  const newSel = [];
  for (const f of media) {
    try {
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) pdfPages += await importPdf(f, at);
      else { const it = await importImage(f, at); newSel.push(it.id); images++; }
    } catch (err) { console.error(err); toast('Couldn’t import ' + f.name); }
    at = { x: at.x + 40 / camera.zoom, y: at.y + 40 / camera.zoom };
  }
  if (newSel.length && !pdfPages) { setTool('select'); selected.clear(); newSel.forEach((id) => selected.add(id)); updateStylePanel(); }
  markDirty(); requestRender(); updatePageUI();
  const parts = [];
  if (images) parts.push(`${images} image${images === 1 ? '' : 's'}`);
  if (pdfPages) parts.push(`${pdfPages} PDF page${pdfPages === 1 ? '' : 's'}`);
  if (parts.length) toast(parts.join(' and ') + ' imported');
}
$('mediaInput').addEventListener('change', (e) => { if (e.target.files.length) handleFiles(e.target.files, null); e.target.value = ''; });
$('importBtn').addEventListener('click', () => $('mediaInput').click());

let dragDepth = 0;
const dropOverlay = $('dropOverlay');
window.addEventListener('dragenter', (e) => { if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return; dragDepth++; dropOverlay.hidden = false; });
window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropOverlay.hidden = true; });
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault(); dragDepth = 0; dropOverlay.hidden = true;
  handleFiles(e.dataTransfer.files, { x: e.clientX, y: e.clientY });
});

// ---------------------------------------------------------------------------
// files: save / open / new
// ---------------------------------------------------------------------------
let fileHandle = null;
function serializeFile() {
  storeView();
  const used = {};
  for (const p of doc.pages) for (const m of p.media) if (assets.has(m.assetId)) used[m.assetId] = assets.get(m.assetId);
  return JSON.stringify({ version: 4, app: 'vector-plane', doc: { title: doc.title, pages: doc.pages, currentPageIndex: doc.currentPageIndex }, assets: used });
}
const fileSlug = () => (doc.title || 'vector-plane').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'vector-plane';
async function saveToFile(saveAs) {
  if (!doc.pages.some(pageHasContent)) { toast('Nothing to save yet'); return; }
  const data = serializeFile();
  if (window.showSaveFilePicker) {
    try {
      if (!fileHandle || saveAs) {
        fileHandle = await window.showSaveFilePicker({ suggestedName: fileSlug() + '.json', types: [{ description: 'Vector Plane board', accept: { 'application/json': ['.json'] } }] });
      }
      const w = await fileHandle.createWritable();
      await w.write(data); await w.close();
      toast('Saved to ' + fileHandle.name);
      return;
    } catch (err) { if (err && err.name === 'AbortError') return; fileHandle = null; }
  }
  downloadBlob(new Blob([data], { type: 'application/json' }), fileSlug() + '.json');
  toast('Board downloaded');
}
async function openFile() {
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'Vector Plane board', accept: { 'application/json': ['.json'] } }] });
      const f = await h.getFile();
      if (await openFileObject(f)) fileHandle = h;
      return;
    } catch (err) { if (err && err.name === 'AbortError') return; }
  }
  $('fileInput').click();
}
$('fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openFileObject(f); e.target.value = ''; });
async function openFileObject(file) {
  let parsed;
  try { parsed = S.parseFile(JSON.parse(await file.text())); } catch (err) { toast('That file isn’t a Vector Plane board'); return false; }
  if (doc.pages.some(pageHasContent) && !(await confirmBox('Replace the current board?', 'Opening a file replaces what’s on screen. Save first if you want to keep it.', 'Open file', false))) return false;
  for (const a of parsed.assets) { assets.set(a.id, a.dataURL); await S.putAsset(a); }
  loadDocument(parsed.doc);
  if (!parsed.doc.title || parsed.doc.title === 'Untitled board') doc.title = file.name.replace(/\.json$/i, '');
  $('docTitle').value = doc.title; updatePageUI();
  history = []; future = []; updateUndoButtons();
  markDirty();
  toast('Opened ' + file.name);
  return true;
}
async function newBoard() {
  if (doc.pages.some(pageHasContent) && !(await confirmBox('Start a new board?', 'The current board will be replaced. Save it to a file first if you want to keep it.', 'New board', true))) return;
  fileHandle = null;
  nextPageId = 1;
  loadDocument({ title: 'Untitled board', pages: [makePage('infinite')], currentPageIndex: 0 });
  history = []; future = []; updateUndoButtons();
  markDirty();
  gcAssets();
}
function loadDocument(d) {
  doc = { title: d.title || 'Untitled board', pages: d.pages, currentPageIndex: d.currentPageIndex || 0 };
  page = null;
  recomputeIds();
  $('docTitle').value = doc.title;
  activatePage(doc.currentPageIndex, { keepView: true, noStore: true });
}
async function gcAssets() {
  const used = new Set();
  for (const p of doc.pages) for (const m of p.media) used.add(m.assetId);
  for (const h of [...history, ...future]) {
    const pages = h.kind === 'doc' ? h.data.pages : [h.data];
    for (const p of pages) for (const m of p.media || []) used.add(m.assetId);
  }
  const stale = [...assets.keys()].filter((id) => !used.has(id));
  stale.forEach((id) => { assets.delete(id); images.delete(id); });
  await S.deleteAssets(stale);
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------
const exportDialog = $('exportDialog'), exportForm = $('exportForm');
function exportBounds(p) {
  if (p.kind === 'paper') return { minX: 0, minY: 0, maxX: p.w, maxY: p.h };
  const b = R.pageContentBBox(p);
  if (!G.bboxValid(b)) return null;
  return { minX: b.minX - 40, minY: b.minY - 40, maxX: b.maxX + 40, maxY: b.maxY + 40 };
}
function selectionAsPage() {
  const items = selectedItems(), ids = new Set(items.map((i) => i.id));
  return {
    kind: 'infinite', template: page.template, name: 'selection',
    strokes: items.filter((i) => !G.isMedia(i)), media: items.filter(G.isMedia),
    connectors: page.connectors.filter((c) => ids.has(c.fromId) && ids.has(c.toId)),
  };
}
function parseRange(text) {
  const set = new Set();
  for (const part of String(text || '').split(',')) {
    const m = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) if (n >= 1 && n <= doc.pages.length) set.add(n - 1);
  }
  return [...set].sort((a, b) => a - b);
}
function exportJobs(opts) {
  storeView();
  if (opts.scope === 'selection') {
    const p = selectionAsPage(), b = G.itemsBBox([...p.media, ...p.strokes]);
    if (!G.bboxValid(b)) return [];
    return [{ page: p, bounds: { minX: b.minX - 24, minY: b.minY - 24, maxX: b.maxX + 24, maxY: b.maxY + 24 }, name: 'selection' }];
  }
  let idx;
  if (opts.scope === 'current') idx = [doc.currentPageIndex];
  else if (opts.scope === 'all') idx = doc.pages.map((_, i) => i);
  else if (opts.scope === 'written') idx = doc.pages.map((p, i) => (pageHasContent(p) ? i : -1)).filter((i) => i >= 0);
  else idx = parseRange(opts.range);
  return idx.map((i) => ({ page: doc.pages[i], bounds: exportBounds(doc.pages[i]), name: `${String(i + 1).padStart(2, '0')}-${(pageLabel(doc.pages[i], i)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` }))
    .filter((j) => j.bounds);
}
function readExportOpts() {
  const fd = new FormData(exportForm);
  return {
    fmt: fd.get('fmt'), scope: fd.get('scope'), scale: Number(fd.get('scale')) || 2, range: $('rangeInput').value,
    template: $('optTemplate').checked, transparent: $('optTransparent').checked && fd.get('fmt') !== 'pdf',
  };
}
function canvasToBlob(cv, type = 'image/png', q) { return new Promise((res) => cv.toBlob(res, type, q)); }
function rasterize(job, opts) {
  const maxSide = 12000;
  const span = Math.max(job.bounds.maxX - job.bounds.minX, job.bounds.maxY - job.bounds.minY);
  const scale = Math.min(opts.scale, maxSide / span);
  return R.renderToCanvas(job.page, job.bounds, scale, { dark: false, background: '#FFFFFF', transparent: opts.transparent, template: opts.template && job.page.template !== 'blank', image: getImage, flat: true });
}
function updateExportNote() {
  const opts = readExportOpts();
  const jobs = exportJobs(opts);
  const n = jobs.length;
  $('scaleField').hidden = opts.fmt === 'svg';
  $('optTransparentRow').hidden = opts.fmt === 'pdf';
  $('copyPngBtn').hidden = !(opts.fmt === 'png' && n === 1 && navigator.clipboard && window.ClipboardItem);
  let note = '';
  if (!n) note = opts.scope === 'range' ? 'Enter page numbers like 1-3, 5.' : 'Nothing to export here yet.';
  else if (opts.fmt === 'pdf') note = `${n} page${n === 1 ? '' : 's'} in one PDF.`;
  else if (n > 1) note = `${n} files, bundled as a ZIP.`;
  else if (opts.fmt === 'svg') note = 'Scalable vector file for slides, print and design tools.';
  $('exportNote').textContent = note;
  $('doExportBtn').disabled = !n;
}
function openExport() {
  closePopovers();
  if (editing) closeEditor(true);
  $('scopeSelectionRow').hidden = !selected.size;
  const scopeInput = exportForm.querySelector(`input[name=scope][value="${selected.size ? 'selection' : 'current'}"]`);
  if (scopeInput) scopeInput.checked = true;
  $('rangeInput').value = `${doc.currentPageIndex + 1}`;
  updateExportNote();
  exportDialog.showModal();
}
exportForm.addEventListener('input', updateExportNote);
$('rangeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (!$('doExportBtn').disabled) exportDialog.close('export'); }
});
$('rangeInput').addEventListener('focus', () => { exportForm.querySelector('input[name=scope][value=range]').checked = true; updateExportNote(); });
exportDialog.addEventListener('close', async () => {
  if (exportDialog.returnValue !== 'export') return;
  try { await runExport(readExportOpts()); } catch (err) { console.error(err); toast('Export failed — ' + (err && err.message ? err.message : 'unknown error')); }
});
async function runExport(opts) {
  const jobs = exportJobs(opts);
  if (!jobs.length) { toast('Nothing to export'); return; }
  await whenImagesReady(jobs.map((j) => j.page));
  const base = fileSlug();
  if (opts.fmt === 'pdf') {
    toast('Building PDF…', { sticky: true });
    await loadScript(CDN.jspdf);
    const { jsPDF } = window.jspdf;
    let pdf = null;
    for (const j of jobs) {
      // jsPDF pages top out at 14400pt, so very large canvases are scaled to fit.
      const bw = j.bounds.maxX - j.bounds.minX, bh = j.bounds.maxY - j.bounds.minY, fit = Math.min(1, 14400 / Math.max(bw, bh));
      const w = bw * fit, h = bh * fit, orient = w > h ? 'landscape' : 'portrait';
      if (!pdf) pdf = new jsPDF({ orientation: orient, unit: 'pt', format: [w, h], compress: true });
      else pdf.addPage([w, h], orient);
      const cv = rasterize(j, opts);
      pdf.addImage(cv.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, w, h, undefined, 'FAST');
    }
    downloadBlob(pdf.output('blob'), `${base}.pdf`);
    toast(`PDF exported · ${jobs.length} page${jobs.length === 1 ? '' : 's'}`);
    return;
  }
  const make = async (j) => {
    if (opts.fmt === 'svg') return new Blob([R.pageToSVG(j.page, j.bounds, { transparent: opts.transparent, dataURL: (id) => assets.get(id) })], { type: 'image/svg+xml' });
    return canvasToBlob(rasterize(j, opts));
  };
  if (jobs.length === 1) {
    downloadBlob(await make(jobs[0]), `${base}${jobs[0].name === 'selection' ? '-selection' : doc.pages.length > 1 ? '-' + jobs[0].name : ''}.${opts.fmt}`);
    toast(`${opts.fmt.toUpperCase()} exported`);
    return;
  }
  toast('Bundling ZIP…', { sticky: true });
  await loadScript(CDN.zip);
  const zip = new window.JSZip();
  for (const j of jobs) zip.file(`${j.name}.${opts.fmt}`, await make(j));
  downloadBlob(await zip.generateAsync({ type: 'blob' }), `${base}-${opts.fmt}.zip`);
  toast(`${jobs.length} pages exported`);
}
$('copyPngBtn').addEventListener('click', async () => {
  const opts = readExportOpts();
  const jobs = exportJobs(opts);
  if (jobs.length !== 1) return;
  try {
    await whenImagesReady([jobs[0].page]);
    const blob = await canvasToBlob(rasterize(jobs[0], opts));
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
    exportDialog.close('cancel');
    toast('Image copied to clipboard');
  } catch (err) { toast('Your browser blocked clipboard access'); }
});

// ---------------------------------------------------------------------------
// UI: popovers, menus, tooltips, dialogs, toast
// ---------------------------------------------------------------------------
let openPop = null;
function placeAt(el, anchor, side) {
  el.hidden = false;
  el.style.left = '0px'; el.style.top = '0px';
  const a = anchor.getBoundingClientRect(), r = el.getBoundingClientRect(), m = 8, vw = innerWidth, vh = innerHeight;
  let x, y;
  if (side === 'right') { x = a.right + 8; y = a.top + a.height / 2 - r.height / 2; if (x + r.width > vw - m) x = a.left - r.width - 8; }
  else if (side === 'top') { x = a.left + a.width / 2 - r.width / 2; y = a.top - r.height - 8; if (y < m) y = a.bottom + 8; }
  else if (side === 'bottom-end') { x = a.right - r.width; y = a.bottom + 8; if (y + r.height > vh - m) y = a.top - r.height - 8; }
  else { x = a.left; y = a.bottom + 8; if (y + r.height > vh - m) y = a.top - r.height - 8; }
  el.style.left = Math.round(G.clamp(x, m, vw - r.width - m)) + 'px';
  el.style.top = Math.round(G.clamp(y, m, vh - r.height - m)) + 'px';
}
function openPopover(el, anchor, side, opts = {}) {
  const same = openPop && openPop.el === el;
  closePopovers();
  if (same && !opts.reopen) return;
  if (opts.custom) el.hidden = false; else placeAt(el, anchor, side);
  if (anchor) anchor.setAttribute('aria-expanded', 'true');
  openPop = { el, anchor, onClose: opts.onClose };
  const first = el.querySelector('[role=menuitem]:not([hidden]), [role=menuitemradio], button:not([hidden])');
  if (opts.focus !== false && first && document.activeElement !== document.body) first.focus({ preventScroll: true });
}
function closePopovers() {
  if (!openPop) return;
  const { el, anchor, onClose } = openPop;
  openPop = null;
  el.hidden = true;
  if (anchor) anchor.setAttribute('aria-expanded', 'false');
  if (onClose) onClose();
}
document.addEventListener('pointerdown', (e) => {
  if (!openPop) return;
  if (openPop.el.contains(e.target) || (openPop.anchor && openPop.anchor.contains(e.target))) return;
  if (e.target.closest && e.target.closest('dialog')) return;
  closePopovers();
}, true);
// Arrow-key navigation inside menus
document.addEventListener('keydown', (e) => {
  if (!openPop || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...openPop.el.querySelectorAll('button:not([hidden]):not(:disabled), a[role=menuitem]')].filter((b) => b.offsetParent !== null);
  if (!items.length) return;
  e.preventDefault();
  let i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') i = (i + 1) % items.length;
  else if (e.key === 'ArrowUp') i = (i - 1 + items.length) % items.length;
  else if (e.key === 'Home') i = 0; else i = items.length - 1;
  items[i].focus();
});

// tooltips (mouse only)
const tip = $('tooltip');
let tipTimer = null, tipTarget = null;
document.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (t === tipTarget) return;
  tipTarget = t; clearTimeout(tipTimer); tip.hidden = true;
  if (!t) return;
  tipTimer = setTimeout(() => showTip(t), 450);
});
document.addEventListener('pointerdown', () => { clearTimeout(tipTimer); tip.hidden = true; tipTarget = null; }, true);
function showTip(t) {
  if (!t.isConnected || t.closest('[hidden]')) return;
  tip.innerHTML = '';
  const label = document.createElement('span'); label.textContent = t.dataset.tip; tip.appendChild(label);
  if (t.dataset.key) { const k = document.createElement('kbd'); k.textContent = t.dataset.key; tip.appendChild(k); }
  const side = t.closest('.rail') && !isPhone() ? 'right' : t.closest('.rail, .zoombar') ? 'top' : 'bottom';
  tip.hidden = false;
  const a = t.getBoundingClientRect(), r = tip.getBoundingClientRect();
  let x, y;
  if (side === 'right') { x = a.right + 10; y = a.top + a.height / 2 - r.height / 2; }
  else if (side === 'top') { x = a.left + a.width / 2 - r.width / 2; y = a.top - r.height - 8; }
  else { x = a.left + a.width / 2 - r.width / 2; y = a.bottom + 8; }
  tip.style.left = G.clamp(x, 6, innerWidth - r.width - 6) + 'px';
  tip.style.top = G.clamp(y, 6, innerHeight - r.height - 6) + 'px';
}

// toast
const toastEl = $('toast');
let toastTimer = null;
function toast(msg, opts = {}) {
  toastEl.innerHTML = '';
  const s = document.createElement('span'); s.textContent = msg; toastEl.appendChild(s);
  if (opts.action) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = opts.action;
    b.addEventListener('click', () => { toastEl.classList.remove('show'); opts.onAction(); });
    toastEl.appendChild(b);
  }
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  if (!opts.sticky) toastTimer = setTimeout(() => toastEl.classList.remove('show'), opts.action ? 5000 : 2400);
}

// confirm / prompt dialogs
const confirmDialog = $('confirmDialog');
function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text || '';
    $('confirmText').hidden = !text;
    $('promptRow').hidden = true;
    const ok = $('confirmOk');
    ok.textContent = okLabel;
    ok.className = 'btn ' + (danger ? 'danger' : 'btn-primary');
    confirmDialog.returnValue = '';
    confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true });
    confirmDialog.showModal();
    ok.focus();
  });
}
function askText(title, label, value) {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = title;
    $('confirmText').hidden = true;
    $('promptRow').hidden = false;
    $('promptLabel').textContent = label;
    const input = $('promptInput');
    input.value = value || '';
    const ok = $('confirmOk');
    ok.textContent = 'Save'; ok.className = 'btn btn-primary';
    confirmDialog.returnValue = '';
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); confirmDialog.close('ok'); } };
    input.addEventListener('keydown', onKey);
    confirmDialog.addEventListener('close', () => {
      input.removeEventListener('keydown', onKey);
      resolve(confirmDialog.returnValue === 'ok' && input.value.trim() ? input.value : null);
    }, { once: true });
    confirmDialog.showModal();
    input.focus(); input.select();
  });
}
// Light-dismiss dialogs by clicking the backdrop.
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); }));

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
document.querySelectorAll('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => { setTool(b.dataset.tool); if (b.closest('#shapesMenu')) closePopovers(); }));
$('shapesBtn').addEventListener('click', (e) => {
  if (!SHAPE_TOOLS.has(state.tool) && !(openPop && openPop.el === $('shapesMenu'))) setTool(settings.lastShape);
  openPopover($('shapesMenu'), e.currentTarget, isPhone() ? 'top' : 'right', { focus: false });
});
$('styleBtn').addEventListener('click', () => setStyleOpen(stylePanel.hidden));
$('styleClose').addEventListener('click', () => setStyleOpen(false));
sizeSlider.addEventListener('input', () => { syncSizeUI(); applyStyle({ size: Number(sizeSlider.value) }); });
sizeSlider.addEventListener('change', endStyleGesture);
document.querySelectorAll('#spFill [data-fill]').forEach((b) => b.addEventListener('click', () => { applyStyle({ fill: b.dataset.fill }); endStyleGesture(); }));
document.querySelectorAll('#spDash [data-dash]').forEach((b) => b.addEventListener('click', () => { applyStyle({ dash: b.dataset.dash === '1' }); endStyleGesture(); }));

$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('exportBtn').addEventListener('click', openExport);
$('zoomInBtn').addEventListener('click', () => zoomBy(1.25));
$('zoomOutBtn').addEventListener('click', () => zoomBy(0.8));
$('zoomVal').addEventListener('click', zoomTo100);
$('fitBtn').addEventListener('click', () => fitView());
$('prevPageBtn').addEventListener('click', () => goToPage(doc.currentPageIndex - 1));
$('nextPageBtn').addEventListener('click', () => goToPage(doc.currentPageIndex + 1));

const titleInput = $('docTitle');
titleInput.addEventListener('change', () => { doc.title = titleInput.value.trim() || 'Untitled board'; titleInput.value = doc.title; updatePageUI(); markDirty(); });
titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); titleInput.blur(); } });

// main menu
$('menuBtn').addEventListener('click', (e) => { syncThemeSeg(); openPopover($('mainMenu'), e.currentTarget, 'bottom'); });
$('mainMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  const t = e.target.closest('[data-theme-set]');
  if (t) { settings.theme = t.dataset.themeSet; saveSettings(); applyTheme(); syncThemeSeg(); return; }
  if (!b) return;
  const cmd = b.dataset.cmd;
  closePopovers();
  runCommand(cmd);
});
function runCommand(cmd) {
  switch (cmd) {
    case 'new': newBoard(); break;
    case 'open': openFile(); break;
    case 'save': saveToFile(false); break;
    case 'saveas': saveToFile(true); break;
    case 'import': $('mediaInput').click(); break;
    case 'export': openExport(); break;
    case 'template': openTemplateMenu($('menuBtn')); break;
    case 'pages': openPagesPanel(); break;
    case 'clear':
      if (!pageHasContent(page) && !page.connectors.length) { toast('This page is already empty'); break; }
      confirmBox('Clear this page?', 'Everything on the current page will be removed. You can undo this.', 'Clear page', true).then((ok) => ok && clearPage()); break;
    case 'zen': setZen(true); break;
    case 'settings': openSettings(); break;
    case 'shortcuts': openShortcuts(); break;
    case 'install': promptInstall(); break;
  }
}
function syncThemeSeg() { document.querySelectorAll('[data-theme-set]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeSet === settings.theme))); }

// zen / focus mode
function setZen(on) {
  document.body.classList.toggle('zen', on);
  $('zenExit').hidden = !on;
  closePopovers(); updateStylePanel(); requestRender();
  if (on) toast('Focus mode — press \\ or Esc to bring the tools back');
}
$('zenExit').addEventListener('click', () => setZen(false));

// paper template menu
const TEMPLATE_PREVIEW = { w: 54, h: 66 };
function buildTemplateMenu() {
  const grid = $('tplGrid');
  grid.innerHTML = '';
  for (const t of R.TEMPLATES) {
    const b = document.createElement('button');
    b.className = 'tpl'; b.setAttribute('role', 'menuitemradio'); b.dataset.template = t.id;
    const cv = document.createElement('canvas');
    cv.width = TEMPLATE_PREVIEW.w * 2; cv.height = TEMPLATE_PREVIEW.h * 2;
    b.appendChild(cv);
    const s = document.createElement('span'); s.textContent = t.label; b.appendChild(s);
    b.addEventListener('click', () => { setTemplate(t.id); closePopovers(); });
    grid.appendChild(b);
  }
}
function paintTemplatePreviews() {
  const th = R.themeColors(isDark);
  document.querySelectorAll('#tplGrid .tpl').forEach((b) => {
    const cv = b.querySelector('canvas'), c = cv.getContext('2d'), k = 2 * 0.36;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = th.sheet; c.fillRect(0, 0, cv.width, cv.height);
    c.setTransform(k, 0, 0, k, 0, 0);
    const pw = cv.width / k, ph = cv.height / k;
    R.drawTemplate(c, b.dataset.template, th, { x: 0, y: 0 }, { x: pw, y: ph }, 0.9, { w: pw, h: ph });
  });
}
function refreshTemplateMenu() {
  document.querySelectorAll('#tplGrid .tpl').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.template === page.template)));
  $('templateScope').textContent = pageLabel(page, doc.currentPageIndex);
}
function openTemplateMenu(anchor) {
  refreshTemplateMenu();
  openPopover($('templateMenu'), anchor, anchor === $('menuBtn') ? 'bottom' : 'bottom-end', { reopen: true });
}

// pages panel
const pagesPanel = $('pagesPanel');
let pageMenuIndex = 0;
function openPagesPanel() {
  if (openPop && openPop.el === pagesPanel) { closePopovers(); return; }
  closePopovers();
  renderPagesPanel();
  openPopover(pagesPanel, $('pagePill'), null, { custom: true, focus: false });
  const cur = pagesPanel.querySelector('.thumb.current');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}
$('pagePill').addEventListener('click', openPagesPanel);
$('pagesClose').addEventListener('click', closePopovers);
pagesPanel.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.add;
  closePopovers();
  if (k === 'infinite') addPage('infinite'); else addPage('paper', k);
}));
function thumbBounds(p) {
  if (p.kind === 'paper') return { minX: 0, minY: 0, maxX: p.w, maxY: p.h };
  const b = R.pageContentBBox(p);
  if (!G.bboxValid(b)) return { minX: -450, minY: -600, maxX: 450, maxY: 600 };
  const pad = Math.max(40, (b.maxX - b.minX) * 0.06);
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}
function renderPagesPanel() {
  const grid = $('pageGrid');
  $('ppHint').textContent = coarse() ? 'Use the ⋯ menu on a page to reorder, rename or delete it.' : 'Drag thumbnails to reorder. Paper pages export as PDF.';
  grid.innerHTML = '';
  doc.pages.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'thumb' + (i === doc.currentPageIndex ? ' current' : '');
    el.draggable = !coarse();
    el.dataset.index = i;
    const btn = document.createElement('button');
    btn.className = 'thumb-btn';
    btn.setAttribute('aria-label', `Go to ${pageLabel(p, i)}`);
    if (i === doc.currentPageIndex) btn.setAttribute('aria-current', 'page');
    const cv = document.createElement('canvas');
    btn.appendChild(cv);
    btn.insertAdjacentHTML('beforeend', `<span class="thumb-num">${i + 1}</span><span class="thumb-kind" aria-hidden="true"><svg class="ic"><use href="#i-${p.kind === 'paper' ? (p.w > p.h ? 'landscape' : 'portrait') : 'infinite'}"/></svg></span>`);
    btn.addEventListener('click', () => { closePopovers(); goToPage(i); });
    const meta = document.createElement('div');
    meta.className = 'thumb-meta';
    const name = document.createElement('span'); name.className = 'thumb-name'; name.textContent = pageLabel(p, i);
    const more = document.createElement('button');
    more.className = 'btn-icon'; more.setAttribute('aria-label', `Actions for ${pageLabel(p, i)}`); more.setAttribute('aria-haspopup', 'menu');
    more.innerHTML = '<svg class="ic ic-sm"><use href="#i-more"/></svg>';
    more.addEventListener('click', (e) => { e.stopPropagation(); openPageMenu(i, more); });
    meta.append(name, more);
    el.append(btn, meta);
    grid.appendChild(el);
    // DnD reorder
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-vp-page', String(i)); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('text/x-vp-page')) { e.preventDefault(); el.classList.add('drag-over'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      const from = Number(e.dataTransfer.getData('text/x-vp-page'));
      el.classList.remove('drag-over');
      if (!Number.isInteger(from)) return;
      e.preventDefault(); e.stopPropagation();
      movePage(from, i);
    });
    requestAnimationFrame(() => paintThumb(p, cv, btn));
  });
}
async function paintThumb(p, cv, slot) {
  const b = thumbBounds(p), bw = b.maxX - b.minX, bh = b.maxY - b.minY;
  const sw = slot.clientWidth || 112, sh = slot.clientHeight || 150;
  const k = Math.min(sw / bw, sh / bh) * Math.min(window.devicePixelRatio || 1, 2);
  R.renderToCanvas(p, b, k, { canvas: cv, dark: isDark, template: p.kind === 'paper', image: getImage, flat: true });
  cv.style.width = Math.round((bw * k) / Math.min(window.devicePixelRatio || 1, 2)) + 'px';
  cv.style.height = Math.round((bh * k) / Math.min(window.devicePixelRatio || 1, 2)) + 'px';
  if (p.media.length) {
    await whenImagesReady([p]);
    if (cv.isConnected) R.renderToCanvas(p, b, k, { canvas: cv, dark: isDark, template: p.kind === 'paper', image: getImage, flat: true });
  }
}
function openPageMenu(i, anchor) {
  pageMenuIndex = i;
  const menu = $('pageMenu');
  menu.querySelector('[data-pcmd="left"]').disabled = i === 0;
  menu.querySelector('[data-pcmd="right"]').disabled = i === doc.pages.length - 1;
  // Keep the pages panel open underneath.
  const prev = openPop;
  if (prev && prev.el === pagesPanel) openPop = null;
  placeAt(menu, anchor, 'bottom-end');
  menu.querySelector('button:not(:disabled)').focus({ preventScroll: true });
  const close = (e) => {
    if (e && (menu.contains(e.target))) return;
    menu.hidden = true;
    document.removeEventListener('pointerdown', close, true);
    if (prev && prev.el === pagesPanel && !pagesPanel.hidden) openPop = prev;
  };
  menu._close = close;
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
}
$('pageMenu').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pcmd]');
  if (!b || b.disabled) return;
  const menu = $('pageMenu');
  if (menu._close) menu._close();
  const i = pageMenuIndex, cmd = b.dataset.pcmd;
  if (cmd === 'rename') { await renamePage(i); renderPagesPanel(); }
  else if (cmd === 'duplicate') { duplicatePage(i); renderPagesPanel(); }
  else if (cmd === 'left') movePage(i, i - 1);
  else if (cmd === 'right') movePage(i, i + 1);
  else if (cmd === 'template') { closePopovers(); if (i !== doc.currentPageIndex) goToPage(i); openTemplateMenu($('pagePill')); }
  else if (cmd === 'unlock') { if (i !== doc.currentPageIndex) goToPage(i); unlockAll(); renderPagesPanel(); }
  else if (cmd === 'delete') { await deletePage(i); if (!pagesPanel.hidden) renderPagesPanel(); }
});

// settings dialog
const settingsDialog = $('settingsDialog');
function openSettings() {
  settingsDialog.querySelectorAll('[data-setting]').forEach((el) => {
    const k = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = !!settings[k];
    else { el.value = settings[k]; el.style.setProperty('--fill', (settings[k] / Number(el.max)) * 100 + '%'); }
  });
  storageEstimate();
  settingsDialog.showModal();
}
settingsDialog.addEventListener('input', (e) => {
  const el = e.target.closest('[data-setting]');
  if (!el) return;
  const k = el.dataset.setting;
  settings[k] = el.type === 'checkbox' ? el.checked : Number(el.value);
  if (k === 'touchPans') settings.touchPansAuto = false;
  if (el.type === 'range') el.style.setProperty('--fill', (Number(el.value) / Number(el.max)) * 100 + '%');
  saveSettings();
  applyCoordsVisibility(); updateStylePanel();
});
async function storageEstimate() {
  const note = $('storageNote');
  note.textContent = '';
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0);
      note.textContent = `Using ${mb(est.usage || 0)} MB of browser storage`;
    }
  } catch (e) {}
}
function applyCoordsVisibility() { $('readout').hidden = !settings.showCoords; }

// shortcuts dialog
const SHORTCUTS = [
  ['Tools', [['V', 'Select'], ['H or hold Space', 'Pan'], ['P', 'Pen'], ['M', 'Highlighter'], ['E', 'Stroke eraser'], ['X', 'Precision eraser'], ['L', 'Laser pointer'], ['T', 'Text'], ['N', 'Text box'], ['S', 'Sticky note'], ['C', 'Connector'], ['I', 'Import PDF or image']]],
  ['Shapes', [['R', 'Rectangle'], ['O', 'Ellipse'], ['⇧ T', 'Triangle'], ['D', 'Diamond'], ['⇧ L', 'Line'], ['A', 'Arrow'], ['Shift while drawing', 'Square / 45° snap']]],
  ['Edit', [['Ctrl Z', 'Undo'], ['Ctrl ⇧ Z / Ctrl Y', 'Redo'], ['Ctrl C / X / V', 'Copy / cut / paste'], ['Ctrl D', 'Duplicate'], ['Alt-drag', 'Duplicate while moving'], ['Ctrl A', 'Select all'], ['Del', 'Delete selection'], ['Arrow keys', 'Nudge (Shift ×10)'], ['[ / ]', 'Send back / bring front'], ['Enter', 'Edit selected text'], ['Double-click', 'Edit text, or add a label']]],
  ['View', [['Scroll / pinch', 'Zoom'], ['Middle-drag or Shift-drag', 'Pan'], ['0', 'Fit to screen'], ['⇧ 0', 'Zoom to 100%'], ['+ / −', 'Zoom in / out'], ['⇧ 2', 'Zoom to selection'], ['\\', 'Focus mode']]],
  ['Pages & files', [['PgUp / PgDn', 'Previous / next page'], ['Ctrl ⇧ N', 'New paper page'], ['Ctrl S', 'Save to file'], ['Ctrl ⇧ S', 'Save as'], ['Ctrl O', 'Open file'], ['Ctrl ⇧ E', 'Export'], ['Drag & drop', 'Import PDF, image or board']]],
];
function openShortcuts() {
  const el = $('keysList');
  if (!el.childElementCount) {
    for (const [group, rows] of SHORTCUTS) {
      const h = document.createElement('h3'); h.textContent = group; el.appendChild(h);
      for (const [k, label] of rows) {
        const r = document.createElement('div'); r.className = 'key-row';
        const s = document.createElement('span'); s.textContent = label;
        const kb = document.createElement('kbd'); kb.textContent = k;
        r.append(s, kb); el.appendChild(r);
      }
    }
  }
  $('shortcutsDialog').showModal();
}

// ---------------------------------------------------------------------------
// keyboard
// ---------------------------------------------------------------------------
function isTypingTarget(t) {
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
window.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (isTypingTarget(e.target)) return;
  const k = e.key, lower = k.length === 1 ? k.toLowerCase() : k;
  const mod = e.ctrlKey || e.metaKey;

  if (e.code === 'Space' && !spaceDown && !e.repeat) { spaceDown = true; updateCursor(); e.preventDefault(); return; }
  if (k === 'Escape') {
    if (openPop) { const a = openPop.anchor; closePopovers(); if (a) a.focus(); return; }
    if (document.body.classList.contains('zen')) { setZen(false); return; }
    if (shapeDraft || connectorDraft || dragState || rubberBand) { cancelActions(); return; }
    if (selected.size) { selected.clear(); updateStylePanel(); requestRender(); }
    return;
  }
  if (mod) {
    switch (lower) {
      case 'z': e.preventDefault(); if (e.shiftKey) redo(); else undo(); return;
      case 'y': e.preventDefault(); redo(); return;
      case 'a': e.preventDefault(); selectAll(); return;
      case 'd': e.preventDefault(); duplicateSelection(); return;
      case 's': e.preventDefault(); saveToFile(e.shiftKey); return;
      case 'o': e.preventDefault(); openFile(); return;
      case 'e': if (e.shiftKey) { e.preventDefault(); openExport(); } return;
      case 'n': if (e.shiftKey) { e.preventDefault(); addPage('paper', 'portrait'); } return;
      case '=': case '+': e.preventDefault(); zoomBy(1.25); return;
      case '-': e.preventDefault(); zoomBy(0.8); return;
      case '0': e.preventDefault(); fitView(); return;
    }
    return;
  }
  if (e.altKey) return;
  if (k === 'Delete' || k === 'Backspace') { if (selected.size) { e.preventDefault(); deleteSelection(); } return; }
  if (k.startsWith('Arrow') && selected.size) {
    e.preventDefault();
    const s = e.shiftKey ? 10 : 1;
    nudge(k === 'ArrowLeft' ? -s : k === 'ArrowRight' ? s : 0, k === 'ArrowUp' ? -s : k === 'ArrowDown' ? s : 0);
    return;
  }
  if (k === 'PageDown') { e.preventDefault(); goToPage(doc.currentPageIndex + 1); return; }
  if (k === 'PageUp') { e.preventDefault(); goToPage(doc.currentPageIndex - 1); return; }
  if (k === 'Enter' && selected.size === 1) { const it = selectedItems()[0]; if (G.isText(it)) { e.preventDefault(); openEditor(it, false); } return; }
  if (k === '?') { openShortcuts(); return; }
  if (k === '\\') { setZen(!document.body.classList.contains('zen')); return; }
  if (k === ']') { reorderSelection(true); return; }
  if (k === '[') { reorderSelection(false); return; }
  if (k === '+' || k === '=') { zoomBy(1.25); return; }
  if (k === '-' || k === '_') { zoomBy(0.8); return; }
  if (e.code === 'Digit0') { if (e.shiftKey) zoomTo100(); else fitView(); return; }
  if (e.code === 'Digit2' && e.shiftKey) { zoomToSelection(); return; }
  if (e.repeat) return;
  const map = {
    v: 'select', h: 'hand', p: 'pen', m: 'highlighter', e: 'eraser-stroke', x: 'eraser-precision',
    r: 'rect', o: 'ellipse', d: 'diamond', a: 'arrow', n: 'node', s: 'sticky', c: 'connector',
  };
  if (lower === 't') { setTool(e.shiftKey ? 'triangle' : 'text'); return; }
  if (lower === 'l') { setTool(e.shiftKey ? 'line' : 'laser'); return; }
  if (lower === 'i') { $('mediaInput').click(); return; }
  if (map[lower]) setTool(map[lower]);
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; updateCursor(); }
  if (e.key.startsWith('Arrow') && nudgeActive) { nudgeActive = false; }
});
window.addEventListener('blur', () => { spaceDown = false; updateCursor(); });

// ---------------------------------------------------------------------------
// theme
// ---------------------------------------------------------------------------
const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  isDark = settings.theme === 'dark' || (settings.theme === 'system' && darkMQ.matches);
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', isDark ? '#121316' : '#EDEEF1'));
  paintSwatches(); paintTemplatePreviews(); updateStylePanel(); requestRender();
  if (!pagesPanel.hidden) renderPagesPanel();
}
darkMQ.addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); });

// ---------------------------------------------------------------------------
// resize
// ---------------------------------------------------------------------------
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  requestRender();
}
let lastSize = { w: innerWidth, h: innerHeight };
window.addEventListener('resize', () => {
  // Keep the centre of the view stable when the window changes size.
  camera.panX += (innerWidth - lastSize.w) / 2;
  camera.panY += (innerHeight - lastSize.h) / 2;
  lastSize = { w: innerWidth, h: innerHeight };
  resize();
  if (openPop && openPop.el !== pagesPanel) closePopovers();
  updateStylePanel();
});

// ---------------------------------------------------------------------------
// PWA: service worker + install
// ---------------------------------------------------------------------------
let deferredInstall = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function updateInstallItem() { $('installItem').hidden = isStandalone() || !(deferredInstall || isIOS()); }
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; updateInstallItem(); });
window.addEventListener('appinstalled', () => { deferredInstall = null; updateInstallItem(); toast('Vector Plane installed'); });
async function promptInstall() {
  if (deferredInstall) {
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (e) {}
    deferredInstall = null; updateInstallItem();
  } else $('installDialog').showModal();
}
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('A new version is ready', { action: 'Reload', onAction: () => { flushSave().then(() => location.reload()); }, sticky: true });
          }
        });
      });
    }).catch(() => {});
  });
}
// Launch from the home-screen shortcut ("New page").
function handleLaunchParams() {
  const q = new URLSearchParams(location.search);
  const action = q.get('action');
  if (action === 'new-page') addPage('paper', 'portrait');
  else if (action === 'new-canvas') addPage('infinite');
  if (action && window.history.replaceState) window.history.replaceState(null, '', location.pathname);
}
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (params.files && params.files.length) {
      const files = await Promise.all(params.files.map((h) => h.getFile()));
      handleFiles(files, null);
    }
  });
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
async function init() {
  buildSwatches();
  buildTemplateMenu();
  applyTheme();
  resize();

  let loaded = await S.loadDoc();
  let migrated = false;
  if (!loaded) {
    const legacy = await S.migrateLegacy();
    if (legacy) {
      for (const a of legacy.assets) { assets.set(a.id, a.dataURL); await S.putAsset(a); }
      loaded = legacy.doc; migrated = true;
    }
  }
  if (loaded && Array.isArray(loaded.pages) && loaded.pages.length) {
    loaded.pages = loaded.pages.map((p, i) => S.normalizePage(p, i, 'infinite'));
    const stray = S.extractAssets(loaded.pages);
    for (const a of stray) { assets.set(a.id, a.dataURL); await S.putAsset(a); }
  } else {
    loaded = { title: 'Untitled board', pages: [makePage('infinite')], currentPageIndex: 0 };
  }
  for (const a of await S.getAllAssets()) if (!assets.has(a.id)) assets.set(a.id, a.dataURL);

  doc = { title: loaded.title || 'Untitled board', pages: loaded.pages, currentPageIndex: loaded.currentPageIndex || 0 };
  recomputeIds();
  $('docTitle').value = doc.title;
  page = null;
  activatePage(G.clamp(doc.currentPageIndex, 0, doc.pages.length - 1), { keepView: true, noStore: true });
  setTool(settings.tool === 'laser' ? 'pen' : settings.tool);
  applyCoordsVisibility();
  updateUndoButtons();
  updateInstallItem();
  setSaveState('Saved');
  if (migrated) { flushSave(); toast('Your earlier drawings were brought over'); }
  gcAssets();
  handleLaunchParams();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { requestRender(); });
}
init();
