/* Vector Plane — persistence
   The document lives in IndexedDB (no 5 MB localStorage ceiling, so imported
   PDFs are safe). Image/PDF pixels are stored once as "assets" and referenced
   by id, which keeps undo snapshots and autosaves small.

   Older saves are migrated on first run and left untouched:
   - infinite-canvas-save / infinite-canvas-connectors (+ IDB infinite-canvas-db)
   - vector-plane-document-v3 (the paged notebook build)                     */

const DB_NAME = 'vector-plane', DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve(null);
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}
function tx(db, store, mode, fn) {
  return new Promise((resolve) => {
    let result;
    try {
      const t = db.transaction(store, mode);
      result = fn(t.objectStore(store));
      t.oncomplete = () => resolve(result && 'result' in result ? result.result : true);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

export async function storageAvailable() { return !!(await openDB()); }

export async function loadDoc() {
  const db = await openDB();
  if (db) {
    const doc = await tx(db, 'kv', 'readonly', (s) => s.get('doc'));
    if (doc && Array.isArray(doc.pages)) return doc;
  }
  try {
    const raw = localStorage.getItem('vp-doc-fallback');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}
export async function saveDoc(doc) {
  const db = await openDB();
  if (db) {
    const ok = await tx(db, 'kv', 'readwrite', (s) => s.put(doc, 'doc'));
    if (ok) return true;
  }
  try { localStorage.setItem('vp-doc-fallback', JSON.stringify(doc)); return true; } catch (e) { return false; }
}
export async function putAsset(asset) {
  const db = await openDB();
  if (!db) return false;
  return !!(await tx(db, 'assets', 'readwrite', (s) => s.put(asset)));
}
export async function getAllAssets() {
  const db = await openDB();
  if (!db) return [];
  return (await tx(db, 'assets', 'readonly', (s) => s.getAll())) || [];
}
export async function deleteAssets(ids) {
  const db = await openDB();
  if (!db || !ids.length) return;
  await tx(db, 'assets', 'readwrite', (s) => { for (const id of ids) s.delete(id); });
}

export const newAssetId = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---- normalising pages from any save format ---------------------------------
export const PAPER_W = 900, PAPER_H = 1200;

/* Converts media items that still carry an inline dataURL into asset refs.
   Returns the list of assets that need storing. */
export function extractAssets(pages) {
  const assets = [];
  for (const p of pages) for (const m of p.media || []) {
    if (m.dataURL && !m.assetId) {
      m.assetId = newAssetId();
      assets.push({ id: m.assetId, dataURL: m.dataURL });
    }
    delete m.dataURL;
  }
  return assets;
}
export function normalizePage(p, i, kindDefault) {
  const kind = p.kind === 'infinite' || p.kind === 'paper' ? p.kind : kindDefault;
  return {
    id: p.id || i + 1,
    name: p.name || '',
    kind,
    template: p.template || 'grid',
    w: kind === 'paper' ? Number(p.w) || PAPER_W : undefined,
    h: kind === 'paper' ? Number(p.h) || PAPER_H : undefined,
    strokes: Array.isArray(p.strokes) ? p.strokes : [],
    media: Array.isArray(p.media) ? p.media : [],
    connectors: Array.isArray(p.connectors) ? p.connectors : [],
    view: p.view || null,
  };
}
/* Accepts every file format the app has ever written:
   v4 { version:4, doc:{pages,...}, assets:{id:dataURL} }
   v3 { version:3, pages:[...] } (paged, inline media)
   v2 { version:2, strokes, media, connectors } (infinite canvas)
   v1 [ ...strokes ]                                                         */
export function parseFile(parsed) {
  let pages, currentPageIndex = 0, title, assets = [];
  if (parsed && parsed.version === 4 && parsed.doc) {
    pages = parsed.doc.pages.map((p, i) => normalizePage(p, i, 'infinite'));
    currentPageIndex = parsed.doc.currentPageIndex || 0;
    title = parsed.doc.title;
    for (const [id, dataURL] of Object.entries(parsed.assets || {})) assets.push({ id, dataURL });
  } else if (parsed && Array.isArray(parsed.pages)) {
    pages = parsed.pages.map((p, i) => normalizePage(p, i, 'paper'));
    currentPageIndex = parsed.currentPageIndex || 0;
  } else if (parsed && Array.isArray(parsed.strokes)) {
    pages = [normalizePage({ name: 'Canvas', template: parsed.template, strokes: parsed.strokes, media: parsed.media, connectors: parsed.connectors }, 0, 'infinite')];
  } else if (Array.isArray(parsed)) {
    pages = [normalizePage({ name: 'Canvas', strokes: parsed }, 0, 'infinite')];
  } else {
    throw new Error('Not a Vector Plane file');
  }
  if (!pages.length) pages = [normalizePage({ name: 'Canvas' }, 0, 'infinite')];
  assets.push(...extractAssets(pages));
  currentPageIndex = Math.min(Math.max(0, Number(currentPageIndex) || 0), pages.length - 1);
  return { doc: { title: title || 'Untitled board', pages, currentPageIndex }, assets };
}

// ---- legacy migration ------------------------------------------------------
function readLegacyMediaDB() {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve([]);
    let req;
    try { req = indexedDB.open('infinite-canvas-db', 1); } catch (e) { return resolve([]); }
    req.onupgradeneeded = () => { try { req.result.createObjectStore('media', { keyPath: 'id' }); } catch (e) {} };
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const t = db.transaction('media', 'readonly');
        const g = t.objectStore('media').getAll();
        g.onsuccess = () => { resolve(g.result || []); db.close(); };
        g.onerror = () => { resolve([]); db.close(); };
      } catch (e) { resolve([]); db.close(); }
    };
  });
}
const safeJSON = (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } };

export async function migrateLegacy() {
  const pages = [];
  const legacyStrokes = safeJSON('infinite-canvas-save');
  const legacyConnectors = safeJSON('infinite-canvas-connectors');
  const legacyMedia = await readLegacyMediaDB();
  const hasInfinite = (Array.isArray(legacyStrokes) && legacyStrokes.length) || legacyMedia.length;
  if (hasInfinite) {
    pages.push(normalizePage({
      name: 'Canvas', template: localStorage.getItem('canvas-template') || 'grid',
      strokes: legacyStrokes || [], connectors: legacyConnectors || [], media: legacyMedia,
    }, 0, 'infinite'));
  }
  const v3 = safeJSON('vector-plane-document-v3');
  if (v3 && Array.isArray(v3.pages)) {
    const legacyKey = JSON.stringify(legacyStrokes || []);
    v3.pages.forEach((p, i) => {
      const empty = !(p.strokes || []).length && !(p.media || []).length;
      // The notebook build copied the infinite canvas into its first page; skip that duplicate.
      if (hasInfinite && i === 0 && JSON.stringify(p.strokes || []) === legacyKey) return;
      if (empty && v3.pages.length === 1) return;
      pages.push(normalizePage(p, pages.length, 'paper'));
    });
  }
  if (!pages.length) return null;
  pages.forEach((p, i) => { p.id = i + 1; });
  const assets = extractAssets(pages);
  return { doc: { title: 'Untitled board', pages, currentPageIndex: 0 }, assets };
}
