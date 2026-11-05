/* Vector Plane Studio — the workspace shell.
   The drawing engine (app.js) and everything it saves are shared with the classic
   UI, so a board looks the same in either. This file only adds what the workspace
   puts around it: docked panels, menus, command search, quick pens, the navigator. */

import { vp, ui, ready } from './app.js';
import * as R from './render.js';
import * as G from './geometry.js';
import { THEMES, FONTS, DEFAULT_THEME, resolveLook } from './themes.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c');
const phoneMQ = window.matchMedia('(max-width: 720px)');
const isPhone = () => phoneMQ.matches;
const touchFirst = () => window.matchMedia('(pointer: coarse)').matches;

// ---------------------------------------------------------------------------
// per-device workspace state
// ---------------------------------------------------------------------------
const KEY = 'vp-studio';
const DEFAULT_PENS = [
  { tool: 'pen', color: '#14151A', size: 3 },
  { tool: 'pen', color: '#3D5CFF', size: 6 },
  { tool: 'highlighter', color: '#FFB020', size: 8 },
];
const prefs = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) {}
  return {
    pages: typeof s.pages === 'boolean' ? s.pages : window.innerWidth >= 1100,
    insp: s.insp !== false,
    pens: Array.isArray(s.pens) && s.pens.length === 3 ? s.pens : DEFAULT_PENS.map((p) => ({ ...p })),
    recent: Array.isArray(s.recent) ? s.recent.slice(0, 5) : [],
    group: s.group || {},
  };
})();
function savePrefs() { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) {} }

// ---------------------------------------------------------------------------
// look: the chosen theme and font, kept apart from Classic's light/dark setting
// ---------------------------------------------------------------------------
const LOOK_KEY = 'vp-studio-look';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const choice = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LOOK_KEY) || '{}') || {}; } catch (e) {}
  return { theme: s.theme || DEFAULT_THEME, font: s.font || 'auto' };
})();
let look = resolveLook(choice.theme, choice.font === 'auto' ? null : choice.font, systemDark.matches);

function paintLook() {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(look.vars)) root.style.setProperty(k, v);
  root.classList.toggle('glass', look.glass);
  R.setPalette({ [look.dark ? 'dark' : 'light']: look.canvasColors });
  let link = $('lookFont');
  if (look.fontHref) {
    if (!link) { link = document.createElement('link'); link.rel = 'stylesheet'; link.id = 'lookFont'; document.head.appendChild(link); }
    if (link.getAttribute('href') !== look.fontHref) link.href = look.fontHref;
  } else if (link) link.remove();
}
function setLook(patch) {
  Object.assign(choice, patch);
  look = resolveLook(choice.theme, choice.font === 'auto' ? null : choice.font, systemDark.matches);
  try { localStorage.setItem(LOOK_KEY, JSON.stringify({ ...choice, vars: look.vars, dark: look.dark, glass: look.glass, fontHref: look.fontHref })); } catch (e) {}
  paintLook();
  vp.applyTheme();
  syncGallery();
}
systemDark.addEventListener('change', () => { if (choice.theme === 'system') setLook({}); });

// ---------------------------------------------------------------------------
// engine hooks. These must be in place before the board finishes loading.
// ---------------------------------------------------------------------------
const panelW = () => ({
  left: !isPhone() && prefs.pages ? 188 : 0,
  right: !isPhone() && prefs.insp ? 252 : 0,
});
ui.styleAlways = true;
ui.flyoutSide = 'top';
ui.themeColor = () => look.themeColor;
ui.darkMode = () => look.dark;
ui.insets = () => {
  if (isPhone()) return { top: 64, bottom: 76, left: 12, right: 12 };
  const w = panelW();
  return { top: 64, bottom: 100, left: w.left + 20, right: w.right + 20 };
};
ui.selLimits = () => {
  if (isPhone()) return { top: 60, bottom: 72, left: 8, right: 8 };
  const w = panelW();
  return { top: 58, bottom: 94, left: w.left + 8, right: w.right + 8 };
};
ui.openPages = () => {
  if (isPhone()) return false;
  setPages(!prefs.pages);
  return true;
};
ui.onContext = (c) => { if (vp.page) syncContext(c); };
ui.onPage = () => { if (vp.page) { syncPages(); syncPageFacts(); syncWelcome(); refreshBase(); } };
ui.onTheme = () => { pageSig = ''; if (vp.page) { syncPages(); refreshBase(); } };
ui.onFrame = () => { drawMinimap(); syncBackPill(); };
let idleTimer = null;
ui.onChange = () => {
  syncWelcome();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { syncPageFacts(); if (panelsLive()) vp.paintCurrentThumb(); refreshBase(); }, 600);
};

// ---------------------------------------------------------------------------
// panels
// ---------------------------------------------------------------------------
const pagesPanel = $('pagesPanel');
const panelsLive = () => !isPhone() && prefs.pages;
function applyPanels() {
  document.body.classList.toggle('pages-on', prefs.pages);
  document.body.classList.toggle('insp-on', prefs.insp);
  $('pagesToggle').setAttribute('aria-pressed', String(prefs.pages));
  $('inspToggle').setAttribute('aria-pressed', String(prefs.insp));
  $('pagePill').setAttribute('aria-expanded', String(!isPhone() && prefs.pages));
  // On phones the sheet is a popover the engine opens; on desktop it stays mounted.
  if (isPhone()) { if (!pagesPanel.dataset.popover) pagesPanel.hidden = true; } else pagesPanel.hidden = false;
}
function setPages(on) { prefs.pages = on; savePrefs(); applyPanels(); if (on) { pageSig = ''; syncPages(); } }
function setInsp(on) { prefs.insp = on; savePrefs(); applyPanels(); vp.requestRender(); }
$('pagesToggle').addEventListener('click', () => setPages(!prefs.pages));
$('inspToggle').addEventListener('click', () => setInsp(!prefs.insp));
$('pagesClose').addEventListener('click', () => { if (!isPhone()) setPages(false); });
phoneMQ.addEventListener('change', () => { vp.closePopovers(); applyPanels(); pageSig = ''; syncPages(); });
applyPanels();
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('anim')));

// Only rebuild the sidebar when its structure changes; ink edits repaint one thumb.
let pageSig = '';
function syncPages() {
  if (!panelsLive()) return;
  const d = vp.doc;
  const sig = d.pages.map((p) => `${p.id}:${p.name}:${p.kind}`).join('|') + '#' + d.currentPageIndex;
  if (sig === pageSig) return;
  pageSig = sig;
  vp.renderPagesPanel();
  const cur = pagesPanel.querySelector('.thumb.current');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}
function syncPageFacts() {
  const p = vp.page;
  $('factKind').textContent = p.kind === 'paper' ? (p.w > p.h ? 'Landscape paper' : 'Portrait paper') : 'Infinite canvas';
  $('factItems').textContent = String(p.strokes.length + p.media.length);
  const t = R.TEMPLATES.find((x) => x.id === p.template);
  $('factTemplate').textContent = t ? t.label : p.template;
}
$('templateBtn').addEventListener('click', (e) => vp.openTemplateMenu(e.currentTarget));

// ---------------------------------------------------------------------------
// tool groups
// ---------------------------------------------------------------------------
const GROUPS = {
  draw: { btn: $('grpDraw'), fly: $('flyDraw'), tools: ['pen', 'highlighter', 'laser'], icon: (t) => t },
  erase: { btn: $('grpErase'), fly: $('flyErase'), tools: ['eraser-stroke', 'eraser-precision'], icon: (t) => (t === 'eraser-stroke' ? 'eraser' : 'eraser-cut') },
  shapes: { btn: $('shapesBtn'), fly: $('shapesMenu'), tools: ['rect', 'ellipse', 'triangle', 'diamond', 'line', 'arrow'], icon: (t) => t },
  text: { btn: $('grpText'), fly: $('flyText'), tools: ['text', 'node', 'sticky', 'connector'], icon: (t) => t },
};
const lastInGroup = (g) => { const t = prefs.group[g]; return GROUPS[g].tools.includes(t) ? t : GROUPS[g].tools[0]; };
const groupOf = (tool) => Object.keys(GROUPS).find((g) => GROUPS[g].tools.includes(tool));

// One tap picks the group's last tool; a second tap shows the others.
$('rail').addEventListener('click', (e) => {
  const b = e.target.closest('[data-group]');
  if (!b) return;
  e.stopPropagation();
  const g = b.dataset.group, grp = GROUPS[g];
  if (grp.tools.includes(vp.tool)) vp.openPopover(grp.fly, b, 'top', { focus: false });
  else { vp.closePopovers(); vp.setTool(lastInGroup(g)); }
}, true);
for (const g of Object.values(GROUPS)) {
  g.fly.addEventListener('click', (e) => { if (e.target.closest('.tool')) vp.closePopovers(); });
  // Press and hold opens the list straight away, handy on touch.
  let hold = null;
  g.btn.addEventListener('pointerdown', () => { hold = setTimeout(() => { hold = 'fired'; vp.openPopover(g.fly, g.btn, 'top', { focus: false, reopen: true }); }, 420); });
  const clear = () => { if (hold !== 'fired') clearTimeout(hold); };
  g.btn.addEventListener('pointerup', clear); g.btn.addEventListener('pointerleave', clear); g.btn.addEventListener('pointercancel', clear);
  g.btn.addEventListener('click', (e) => { if (hold === 'fired') { hold = null; e.stopPropagation(); } }, true);
}

const HINTS = {
  select: 'Click an item to select it. Drag an empty spot to box-select. Right-click for more.',
  hand: 'Drag to move around. Hold Space with any tool to do the same.',
  laser: 'Points at things for a moment, then fades. Nothing is added to the board.',
};
function syncContext(c) {
  const tool = vp.tool, g = groupOf(tool);
  if (g && prefs.group[g] !== tool) { prefs.group[g] = tool; savePrefs(); }
  for (const [name, grp] of Object.entries(GROUPS)) {
    const icon = grp.icon(name === g ? tool : lastInGroup(name));
    grp.btn.querySelector('use').setAttribute('href', '#i-' + icon);
    grp.btn.setAttribute('aria-pressed', String(name === g));
  }
  syncPens();
  const n = vp.selectedCount;
  $('arrangeSec').hidden = n < 2;
  document.querySelectorAll('[data-dist]').forEach((b) => { b.disabled = n < 3; });
  $('statusHint').textContent = touchFirst() ? '' : (n ? `${n} selected. Del removes, Ctrl D duplicates.` : (c && c.hint) || HINTS[tool] || '');
}
$('arrangeSec').addEventListener('click', (e) => {
  const a = e.target.closest('[data-align]'), d = e.target.closest('[data-dist]');
  if (a) vp.alignSelection(a.dataset.align);
  else if (d) vp.distributeSelection(d.dataset.dist);
});

// ---------------------------------------------------------------------------
// quick pens: three saved pens, one tap (or 1 / 2 / 3) away
// ---------------------------------------------------------------------------
const penMatches = (p) => {
  const st = vp.settings.styles[p.tool];
  return vp.tool === p.tool && st.color.toLowerCase() === p.color.toLowerCase() && st.size === p.size;
};
function renderPens() {
  document.querySelectorAll('[data-pens]').forEach((host) => {
    host.innerHTML = '';
    prefs.pens.forEach((p, i) => {
      const b = document.createElement('button');
      b.className = 'pen';
      b.dataset.pen = i;
      const label = `${p.tool === 'highlighter' ? 'Highlighter' : 'Pen'}, size ${p.size}`;
      b.setAttribute('aria-label', `Quick pen ${i + 1}: ${label}`);
      b.dataset.tip = touchFirst() ? label : `${label}. Right-click to save the current pen here`;
      b.dataset.key = String(i + 1);
      const w = Math.min(14, Math.max(1.5, (p.tool === 'highlighter' ? p.size * 1.6 : p.size) * 0.7));
      b.innerHTML = '<svg viewBox="0 0 28 26" aria-hidden="true"><path d="M3 18C8 5 12 22 17 12s6-4 8-5" fill="none" stroke-linecap="round"/></svg><b></b>';
      const path = b.querySelector('path');
      path.setAttribute('stroke', p.color); path.setAttribute('stroke-width', w); path.setAttribute('stroke-opacity', p.tool === 'highlighter' ? 0.6 : 1);
      b.querySelector('b').textContent = i + 1;
      host.appendChild(b);
    });
  });
  syncPens();
}
function syncPens() {
  document.querySelectorAll('.pen').forEach((b) => b.setAttribute('aria-pressed', String(penMatches(prefs.pens[b.dataset.pen]))));
}
function usePen(i) {
  const p = prefs.pens[i];
  vp.setTool(p.tool);
  vp.setToolStyle(p.tool, { color: p.color, size: p.size });
}
function storePen(i) {
  const t = vp.tool;
  if (t !== 'pen' && t !== 'highlighter') { vp.toast('Pick the pen or highlighter first, then save it here'); return; }
  const st = vp.settings.styles[t];
  prefs.pens[i] = { tool: t, color: st.color, size: st.size };
  savePrefs(); renderPens();
  vp.toast(`Saved to quick pen ${i + 1}`);
}
let penHold = null, penHeld = false;
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.pen');
  if (!b) return;
  if (penHeld) { penHeld = false; return; }
  usePen(Number(b.dataset.pen));
});
document.addEventListener('contextmenu', (e) => {
  const b = e.target.closest && e.target.closest('.pen');
  if (b) { e.preventDefault(); if (!penHeld) storePen(Number(b.dataset.pen)); }
});
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest && e.target.closest('.pen');
  if (!b || e.pointerType === 'mouse') return;
  penHold = setTimeout(() => { penHeld = true; storePen(Number(b.dataset.pen)); }, 550);
});
for (const t of ['pointerup', 'pointercancel']) document.addEventListener(t, () => clearTimeout(penHold));

// ---------------------------------------------------------------------------
// command list: feeds the menu bar, command search and the right-click menu
// ---------------------------------------------------------------------------
const hasSel = () => vp.selectedCount > 0;
const cmds = {};
function add(id, label, icon, run, extra = {}) { cmds[id] = { id, label, icon, run, ...extra }; }
add('new', 'New board', 'file-plus', () => vp.runCommand('new'));
add('open', 'Open file…', 'folder', () => vp.runCommand('open'), { key: 'Ctrl O' });
add('save', 'Save to file', 'save', () => vp.runCommand('save'), { key: 'Ctrl S' });
add('saveas', 'Save as…', 'save', () => vp.runCommand('saveas'), { key: 'Ctrl ⇧ S' });
add('import', 'Import PDF or image…', 'image', () => vp.runCommand('import'), { key: 'I' });
add('export', 'Export…', 'download', () => vp.runCommand('export'), { key: 'Ctrl ⇧ E' });
add('install', 'Install app', 'install', () => vp.promptInstall(), { when: () => !$('installItem').hidden });
add('settings', 'Settings', 'settings', () => vp.runCommand('settings'));

add('undo', 'Undo', 'undo', () => vp.undo(), { key: 'Ctrl Z', when: () => vp.canUndo });
add('redo', 'Redo', 'redo', () => vp.redo(), { key: 'Ctrl ⇧ Z', when: () => vp.canRedo });
add('cut', 'Cut', 'cut', () => vp.copySelection(true), { key: 'Ctrl X', when: hasSel });
add('copy', 'Copy', 'copy', () => vp.copySelection(false), { key: 'Ctrl C', when: hasSel });
add('paste', 'Paste', 'clipboard', () => vp.pasteLocal(), { key: 'Ctrl V', when: () => vp.hasClip });
add('duplicate', 'Duplicate', 'copy', () => vp.duplicateSelection(), { key: 'Ctrl D', when: hasSel });
add('delete', 'Delete', 'trash', () => vp.deleteSelection(), { key: 'Del', when: hasSel, danger: true });
add('selectall', 'Select all', 'select', () => vp.selectAll(), { key: 'Ctrl A' });
add('front', 'Bring to front', 'front', () => vp.reorderSelection(true), { key: ']', when: hasSel });
add('back', 'Send to back', 'back', () => vp.reorderSelection(false), { key: '[', when: hasSel });
add('lock', 'Lock in place', 'lock', () => vp.lockSelection(), { when: hasSel });
add('unlock', 'Unlock all items', 'unlock', () => vp.unlockAll());

add('zoomin', 'Zoom in', 'plus', () => vp.zoomBy(1.25), { key: '+' });
add('zoomout', 'Zoom out', 'minus', () => vp.zoomBy(0.8), { key: '−' });
add('zoom100', 'Zoom to 100%', 'fit', () => vp.zoomTo100(), { key: '⇧ 0' });
add('fit', 'Fit to screen', 'fit', () => vp.fitView(), { key: '0' });
add('zoomsel', 'Zoom to selection', 'fit', () => vp.zoomToSelection(), { key: '⇧ 2', when: hasSel });
add('togglepages', 'Pages sidebar', 'side-l', () => setPages(!prefs.pages), { key: 'Ctrl B', desk: true, on: () => prefs.pages });
add('toggleinsp', 'Inspector', 'side-r', () => setInsp(!prefs.insp), { key: 'Ctrl I', desk: true, on: () => prefs.insp });
add('zen', 'Focus mode', 'focus', () => vp.setZen(true), { key: '\\' });
add('themes', 'Themes and fonts…', 'palette', () => openGallery());

add('newpaper', 'New paper page', 'portrait', () => vp.addPage('paper', 'portrait'), { key: 'Ctrl ⇧ N' });
add('newwide', 'New landscape page', 'landscape', () => vp.addPage('paper', 'landscape'));
add('newcanvas', 'New infinite canvas', 'infinite', () => vp.addPage('infinite'));
add('nextpage', 'Next page', 'chev-right', () => vp.goToPage(vp.doc.currentPageIndex + 1), { key: 'PgDn', when: () => vp.doc.currentPageIndex < vp.doc.pages.length - 1 });
add('prevpage', 'Previous page', 'chev-left', () => vp.goToPage(vp.doc.currentPageIndex - 1), { key: 'PgUp', when: () => vp.doc.currentPageIndex > 0 });
add('renamepage', 'Rename page…', 'edit', () => vp.renamePage(vp.doc.currentPageIndex));
add('duppage', 'Duplicate page', 'copy', () => vp.duplicatePage(vp.doc.currentPageIndex));
add('template', 'Paper template…', 'paper', (anchor) => vp.openTemplateMenu(anchor && anchor.isConnected ? anchor : $('pagePill')));
add('clear', 'Clear page', 'trash', () => vp.runCommand('clear'), { danger: true });
add('delpage', 'Delete page', 'trash', () => vp.deletePage(vp.doc.currentPageIndex), { danger: true, when: () => vp.doc.pages.length > 1 });

add('shortcuts', 'Keyboard shortcuts', 'keyboard', () => vp.runCommand('shortcuts'), { key: '?' });
add('search', 'Search actions', 'search', () => openPalette(), { key: 'Ctrl K' });
add('guide', 'Feature guide', 'book', () => { location.href = 'guide.html'; });
add('classic', 'Switch to Classic version', 'swap', () => { location.href = './'; });

const TOOL_ROWS = [
  ['select', 'Select', 'select', 'V'], ['hand', 'Pan', 'hand', 'H'], ['pen', 'Pen', 'pen', 'P'], ['highlighter', 'Highlighter', 'highlighter', 'M'],
  ['eraser-stroke', 'Stroke eraser', 'eraser', 'E'], ['eraser-precision', 'Precision eraser', 'eraser-cut', 'X'], ['laser', 'Laser pointer', 'laser', 'L'],
  ['rect', 'Rectangle', 'rect', 'R'], ['ellipse', 'Ellipse', 'ellipse', 'O'], ['triangle', 'Triangle', 'triangle', '⇧ T'], ['diamond', 'Diamond', 'diamond', 'D'],
  ['line', 'Line', 'line', '⇧ L'], ['arrow', 'Arrow', 'arrow', 'A'], ['text', 'Text', 'text', 'T'], ['node', 'Text box', 'node', 'N'], ['sticky', 'Sticky note', 'sticky', 'S'], ['connector', 'Connector', 'connector', 'C'],
];
for (const [tool, label, icon, key] of TOOL_ROWS) add('tool-' + tool, label, icon, () => vp.setTool(tool), { key, group: 'Tools' });
const twoPlus = () => vp.selectedCount >= 2, threePlus = () => vp.selectedCount >= 3;
for (const [m, label, icon] of [['left', 'Align left', 'al-l'], ['hcenter', 'Align centers', 'al-hc'], ['right', 'Align right', 'al-r'], ['top', 'Align top', 'al-t'], ['vcenter', 'Align middles', 'al-vc'], ['bottom', 'Align bottom', 'al-b']]) {
  add('align-' + m, label, icon, () => vp.alignSelection(m), { when: twoPlus, group: 'Arrange' });
}
add('dist-x', 'Space evenly across', 'di-x', () => vp.distributeSelection('x'), { when: threePlus, group: 'Arrange' });
add('dist-y', 'Space evenly down', 'di-y', () => vp.distributeSelection('y'), { when: threePlus, group: 'Arrange' });
for (const t of THEMES) add('theme-' + t.id, `Theme: ${t.name}`, 'palette', () => setLook({ theme: t.id }), { group: 'Themes', on: () => choice.theme === t.id });
for (const f of FONTS) add('font-' + f.id, `Font: ${f.label}`, 'text', () => setLook({ font: f.id }), { group: 'Fonts', on: () => choice.font === f.id });

const MENUS = [
  ['File', ['new', 'open', '-', 'save', 'saveas', '-', 'import', 'export', '-', 'install', 'settings']],
  ['Edit', ['undo', 'redo', '-', 'cut', 'copy', 'paste', 'duplicate', 'delete', '-', 'selectall', '-', 'front', 'back', 'lock', 'unlock']],
  ['View', ['zoomin', 'zoomout', 'zoom100', 'fit', 'zoomsel', '-', 'togglepages', 'toggleinsp', 'zen', '-', 'themes']],
  ['Page', ['newpaper', 'newwide', 'newcanvas', '-', 'prevpage', 'nextpage', '-', 'renamepage', 'duppage', 'template', '-', 'clear', 'delpage']],
  ['Help', ['search', 'shortcuts', 'guide', '-', 'classic']],
];
for (const [name, ids] of MENUS) for (const id of ids) if (cmds[id] && !cmds[id].group) cmds[id].group = name;

const enabled = (c) => !c.when || c.when();
function fillMenu(el, ids) {
  el.innerHTML = '';
  for (const id of ids) {
    if (id === '-') { if (el.lastElementChild && el.lastElementChild.tagName !== 'HR') el.appendChild(document.createElement('hr')); continue; }
    const c = cmds[id];
    if (c.id === 'install' && !enabled(c)) continue;
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.dataset.c = id;
    b.disabled = !enabled(c);
    if (c.danger) b.className = 'danger';
    const icon = c.on && c.on() ? 'check' : c.icon;
    b.innerHTML = `<svg class="ic ic-sm" aria-hidden="true"><use href="#i-${icon}"/></svg><span></span>`;
    b.querySelector('span').textContent = c.label;
    if (c.key) { const k = document.createElement('kbd'); k.textContent = c.key; b.appendChild(k); }
    el.appendChild(b);
  }
  if (el.lastElementChild && el.lastElementChild.tagName === 'HR') el.lastElementChild.remove();
}

// menu bar
const menubar = $('menubar'), mbMenu = $('mbMenu');
let openMenuName = null;
function openMenu(btn) {
  const name = btn.textContent;
  fillMenu(mbMenu, MENUS.find((m) => m[0] === name)[1]);
  mbMenu.setAttribute('aria-label', name);
  openMenuName = name;
  vp.openPopover(mbMenu, btn, 'bottom', { reopen: true, onClose: () => { if (openMenuName === name) openMenuName = null; } });
}
for (const [name] of MENUS) {
  const b = document.createElement('button');
  b.textContent = name;
  b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false');
  b.addEventListener('click', () => { if (openMenuName === name) vp.closePopovers(); else openMenu(b); });
  b.addEventListener('pointerenter', () => { if (openMenuName && openMenuName !== name) openMenu(b); });
  b.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const sib = e.key === 'ArrowRight' ? b.nextElementSibling || menubar.firstElementChild : b.previousElementSibling || menubar.lastElementChild;
    e.preventDefault(); sib.focus(); if (openMenuName) openMenu(sib);
  });
  menubar.appendChild(b);
}
mbMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]');
  if (!b || b.disabled) return;
  vp.closePopovers();
  cmds[b.dataset.c].run();
});

// phone main menu: the two entries the engine does not know about
$('mainMenu').addEventListener('click', (e) => {
  if (e.target.closest('[data-scmd="search"]')) { vp.closePopovers(); openPalette(); }
  if (e.target.closest('[data-scmd="themes"]')) { vp.closePopovers(); openGallery(); }
});

// ---------------------------------------------------------------------------
// right-click menu (long-press with the Select tool on touch)
// ---------------------------------------------------------------------------
const ctxMenu = $('ctxMenu');
let ctxAt = { x: 0, y: 0 };
add('stickyhere', 'Sticky note here', 'sticky', () => vp.addTextAt('sticky', ctxAt.x, ctxAt.y));
add('texthere', 'Text here', 'text', () => vp.addTextAt('text', ctxAt.x, ctxAt.y));
function openCtx(x, y) {
  ctxAt = { x, y };
  const onItem = vp.selectAt(x, y);
  fillMenu(ctxMenu, onItem
    ? ['cut', 'copy', 'duplicate', '-', 'front', 'back', 'lock', '-', 'delete']
    : ['paste', 'stickyhere', 'texthere', '-', 'selectall', 'fit', '-', 'template']);
  vp.openPopover(ctxMenu, null, null, { custom: true, focus: false, reopen: true });
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.round(G.clamp(x, 8, innerWidth - r.width - 8)) + 'px';
  ctxMenu.style.top = Math.round(G.clamp(y, 8, innerHeight - r.height - 8)) + 'px';
}
ctxMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]');
  if (!b || b.disabled) return;
  vp.closePopovers();
  cmds[b.dataset.c].run($('pagePill'));
});
canvas.addEventListener('contextmenu', (e) => {
  if (e.pointerType && e.pointerType !== 'mouse') return;
  openCtx(e.clientX, e.clientY);
});

// ---------------------------------------------------------------------------
// touch: two-finger tap undoes, three-finger tap redoes, long-press opens the menu
// ---------------------------------------------------------------------------
const taps = new Map();
let tapStart = 0, tapMax = 0, tapSpoiled = false, pressTimer = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  if (!taps.size) { tapStart = performance.now(); tapMax = 0; tapSpoiled = false; }
  taps.set(e.pointerId, { x: e.clientX, y: e.clientY });
  tapMax = Math.max(tapMax, taps.size);
  clearTimeout(pressTimer);
  if (taps.size === 1 && vp.tool === 'select') {
    const { clientX: x, clientY: y } = e;
    pressTimer = setTimeout(() => { if (!tapSpoiled && taps.size === 1) { tapSpoiled = true; openCtx(x, y); } }, 560);
  }
}, true);
canvas.addEventListener('pointermove', (e) => {
  const t = taps.get(e.pointerId);
  if (t && Math.hypot(e.clientX - t.x, e.clientY - t.y) > 14) { tapSpoiled = true; clearTimeout(pressTimer); }
}, true);
function endTap(e) {
  if (!taps.delete(e.pointerId)) return;
  clearTimeout(pressTimer);
  if (e.type === 'pointercancel') tapSpoiled = true;
  if (taps.size || tapSpoiled || performance.now() - tapStart > 300) return;
  if (tapMax === 2 && vp.canUndo) { vp.undo(); vp.toast('Undone'); }
  else if (tapMax === 3 && vp.canRedo) { vp.redo(); vp.toast('Redone'); }
}
canvas.addEventListener('pointerup', endTap, true);
canvas.addEventListener('pointercancel', endTap, true);

// ---------------------------------------------------------------------------
// command search
// ---------------------------------------------------------------------------
const palette = $('palette'), palInput = $('palInput'), palList = $('palList');
let palRows = [], palIndex = 0;
function fuzzy(q, text) {
  const t = text.toLowerCase(), at = t.indexOf(q);
  if (at >= 0) return 200 - at + (at === 0 || t[at - 1] === ' ' ? 60 : 0);
  let from = 0, last = -2, score = 0;
  for (const ch of q) {
    const j = t.indexOf(ch, from);
    if (j < 0) return -1;
    score += j === last + 1 ? 4 : j === 0 || t[j - 1] === ' ' ? 3 : 1;
    last = j; from = j + 1;
  }
  return score;
}
function paletteEntries() {
  const out = Object.values(cmds).filter((c) => !['stickyhere', 'texthere', 'search'].includes(c.id) && !(c.desk && isPhone()));
  vp.doc.pages.forEach((p, i) => {
    const name = p.name || (p.kind === 'paper' ? `Page ${i + 1}` : `Canvas ${i + 1}`);
    out.push({ id: 'page-' + p.id, label: `Go to ${name}`, icon: p.kind === 'paper' ? 'portrait' : 'infinite', group: 'Pages', run: () => vp.goToPage(i), when: () => i !== vp.doc.currentPageIndex });
  });
  return out.filter(enabled);
}
function renderPalette() {
  const q = palInput.value.trim().toLowerCase();
  const all = paletteEntries();
  let groups;
  if (q) {
    const hits = all.map((c) => ({ c, s: Math.max(fuzzy(q, c.label), fuzzy(q, `${c.group} ${c.label}`) - 20) })).filter((h) => h.s > 0).sort((a, b) => b.s - a.s).slice(0, 30);
    groups = [['', hits.map((h) => h.c)]];
  } else {
    const recent = prefs.recent.map((id) => all.find((c) => c.id === id)).filter(Boolean);
    const tools = all.filter((c) => c.group === 'Tools');
    const rest = all.filter((c) => c.group !== 'Tools' && !recent.includes(c));
    groups = [['Recent', recent], ['Tools', tools.filter((c) => !recent.includes(c))]];
    for (const name of ['Pages', 'Arrange', 'File', 'Edit', 'View', 'Page', 'Help']) groups.push([name, rest.filter((c) => c.group === name)]);
  }
  palList.innerHTML = '';
  palRows = [];
  for (const [head, rows] of groups) {
    if (!rows.length) continue;
    if (head) { const h = document.createElement('li'); h.className = 'pal-head'; h.setAttribute('role', 'presentation'); h.textContent = head; palList.appendChild(h); }
    for (const c of rows) {
      const li = document.createElement('li');
      li.className = 'pal-item'; li.id = 'pal-' + palRows.length; li.setAttribute('role', 'option');
      li.dataset.i = palRows.length;
      li.innerHTML = `<svg class="ic ic-sm" aria-hidden="true"><use href="#i-${c.icon}"/></svg><span></span>`;
      li.querySelector('span').textContent = c.label;
      if (c.key) { const k = document.createElement('kbd'); k.textContent = c.key; li.appendChild(k); }
      palList.appendChild(li);
      palRows.push(c);
    }
  }
  if (!palRows.length) {
    const li = document.createElement('li'); li.className = 'pal-empty'; li.setAttribute('role', 'presentation');
    li.textContent = 'Nothing matches that. Try a tool or page name.';
    palList.appendChild(li);
  }
  markPalette(0);
}
function markPalette(i) {
  palIndex = i;
  palList.querySelectorAll('.pal-item').forEach((el, n) => {
    el.setAttribute('aria-selected', String(n === i));
    if (n === i) { palInput.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); }
  });
}
function runPalette(i) {
  const c = palRows[i];
  if (!c) return;
  palette.close();
  if (!c.id.startsWith('page-')) { prefs.recent = [c.id, ...prefs.recent.filter((x) => x !== c.id)].slice(0, 5); savePrefs(); }
  c.run();
}
function openPalette() {
  if (palette.open) return;
  vp.closePopovers();
  palInput.value = '';
  palette.showModal();
  renderPalette();
  palInput.focus();
}
palInput.addEventListener('input', renderPalette);
palInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (palRows.length) markPalette((palIndex + 1) % palRows.length); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (palRows.length) markPalette((palIndex - 1 + palRows.length) % palRows.length); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(palIndex); }
});
palList.addEventListener('click', (e) => { const li = e.target.closest('.pal-item'); if (li) runPalette(Number(li.dataset.i)); });
palList.addEventListener('pointermove', (e) => { const li = e.target.closest('.pal-item'); if (li && Number(li.dataset.i) !== palIndex) markPalette(Number(li.dataset.i)); });
$('paletteBtn').addEventListener('click', openPalette);

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey, lower = e.key.toLowerCase();
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
  if (mod && lower === 'k') { e.preventDefault(); if (palette.open) palette.close(); else if (!document.querySelector('dialog[open]')) openPalette(); return; }
  if (typing || document.querySelector('dialog[open]')) return;
  if (mod && !e.shiftKey && lower === 'b') { e.preventDefault(); if (!isPhone()) setPages(!prefs.pages); return; }
  if (mod && !e.shiftKey && lower === 'i') { e.preventDefault(); if (!isPhone()) setInsp(!prefs.insp); return; }
  if (!mod && !e.altKey && !e.shiftKey && ['1', '2', '3'].includes(e.key)) usePen(Number(e.key) - 1);
});

// ---------------------------------------------------------------------------
// navigator
// ---------------------------------------------------------------------------
const mini = $('minimap'), mctx = mini.getContext('2d');
const baseCv = document.createElement('canvas');
let base = null, map = null, miniDrag = false, frozen = null;
const miniLive = () => !isPhone() && prefs.insp && !document.body.classList.contains('zen');
function contentBounds() {
  const p = vp.page;
  if (p.kind === 'paper') return { minX: 0, minY: 0, maxX: p.w, maxY: p.h };
  const b = R.pageContentBBox(p);
  return G.bboxValid(b) ? b : null;
}
function refreshBase() {
  if (!miniLive()) return;
  const b = contentBounds();
  base = null;
  if (b) {
    const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
    const k = Math.min(220 * Math.min(window.devicePixelRatio || 1, 2) / bw, 140 * Math.min(window.devicePixelRatio || 1, 2) / bh);
    R.renderToCanvas(vp.page, b, k, { canvas: baseCv, dark: vp.isDark, transparent: vp.page.kind !== 'paper', template: vp.page.kind === 'paper', image: vp.getImage, flat: true });
    base = b;
  }
  vp.requestRender();
}
function drawMinimap() {
  if (!miniLive()) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = mini.clientWidth, cssH = mini.clientHeight;
  if (!cssW || !cssH) return;
  if (mini.width !== Math.round(cssW * dpr)) { mini.width = Math.round(cssW * dpr); mini.height = Math.round(cssH * dpr); }
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.clearRect(0, 0, cssW, cssH);
  const view = vp.viewRect();
  // While dragging, the scale stays put so the view box tracks the pointer.
  let m = frozen;
  if (!m) {
    const w = base ? { minX: Math.min(base.minX, view.minX), minY: Math.min(base.minY, view.minY), maxX: Math.max(base.maxX, view.maxX), maxY: Math.max(base.maxY, view.maxY) } : view;
    const pad = 8, bw = Math.max(1, w.maxX - w.minX), bh = Math.max(1, w.maxY - w.minY);
    const k = Math.min((cssW - pad * 2) / bw, (cssH - pad * 2) / bh);
    m = { k, ox: (cssW - bw * k) / 2 - w.minX * k, oy: (cssH - bh * k) / 2 - w.minY * k };
  }
  map = m;
  mctx.imageSmoothingQuality = 'high';
  if (base) mctx.drawImage(baseCv, m.ox + base.minX * m.k, m.oy + base.minY * m.k, (base.maxX - base.minX) * m.k, (base.maxY - base.minY) * m.k);
  mctx.lineWidth = 1.5; mctx.strokeStyle = look.accent;
  mctx.fillStyle = look.accentFill;
  const x = m.ox + view.minX * m.k, y = m.oy + view.minY * m.k, w = (view.maxX - view.minX) * m.k, h = (view.maxY - view.minY) * m.k;
  mctx.fillRect(x, y, w, h); mctx.strokeRect(x, y, w, h);
}
function miniMove(e) {
  if (!map) return;
  const r = mini.getBoundingClientRect();
  vp.centerOn((e.clientX - r.left - map.ox) / map.k, (e.clientY - r.top - map.oy) / map.k);
}
mini.addEventListener('pointerdown', (e) => { miniDrag = true; frozen = map; mini.setPointerCapture(e.pointerId); miniMove(e); });
mini.addEventListener('pointermove', (e) => { if (miniDrag) miniMove(e); });
for (const t of ['pointerup', 'pointercancel']) mini.addEventListener(t, () => { miniDrag = false; frozen = null; vp.requestRender(); });

// On an infinite board it is easy to end up looking at nothing.
const backPill = $('backPill');
function syncBackPill() {
  const p = vp.page;
  let lost = false;
  if (p.kind !== 'paper' && (p.strokes.length || p.media.length)) {
    const b = R.pageContentBBox(p);
    lost = G.bboxValid(b) && !G.rectsIntersect(vp.viewRect(), b);
  }
  if (backPill.hidden === lost) backPill.hidden = !lost;
}
backPill.addEventListener('click', () => vp.fitView());

// ---------------------------------------------------------------------------
// empty board welcome
// ---------------------------------------------------------------------------
const welcome = $('welcome');
let welcomeDismissed = new Set();
function syncWelcome() {
  const p = vp.page;
  welcome.hidden = !(p.kind !== 'paper' && !vp.pageHasContent(p) && !welcomeDismissed.has(p.id));
}
canvas.addEventListener('pointerdown', () => {
  if (welcome.hidden) return;
  welcomeDismissed.add(vp.page.id); welcome.hidden = true;
}, true);
welcome.addEventListener('click', (e) => {
  const b = e.target.closest('[data-w]');
  if (!b) return;
  welcomeDismissed.add(vp.page.id); welcome.hidden = true;
  const w = b.dataset.w;
  if (w === 'pen') vp.setTool('pen');
  else if (w === 'sticky') vp.addTextAt('sticky', innerWidth / 2 + (panelW().left - panelW().right) / 2, innerHeight * 0.42);
  else if (w === 'paper') vp.addPage('paper', 'portrait');
  else vp.runCommand('import');
});

// ---------------------------------------------------------------------------
// theme gallery
// ---------------------------------------------------------------------------
const themeDialog = $('themeDialog'), lookBody = $('lookBody');
function themeCard(t) {
  const r = resolveLook(t.id, null, systemDark.matches), v = r.vars;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'look-card'; b.dataset.theme = t.id;
  const prev = document.createElement('span');
  prev.className = 'look-prev';
  prev.style.background = v['--backdrop'];
  for (const [cls, color] of [['lp-side', v['--panel']], ['lp-line', v['--accent']], ['lp-tray', v['--tray']], ['lp-dot', v['--tray-on']]]) {
    const i = document.createElement('i'); i.className = cls; i.style.background = color; prev.appendChild(i);
  }
  const name = document.createElement('span'); name.textContent = t.name;
  b.append(prev, name);
  return b;
}
function buildGallery() {
  lookBody.innerHTML = '';
  for (const group of ['Exotic', 'Basic']) {
    const h = document.createElement('p'); h.className = 'look-head'; h.textContent = group;
    const grid = document.createElement('div'); grid.className = 'look-grid'; grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', `${group} themes`);
    for (const t of THEMES) if (t.group === group) grid.appendChild(themeCard(t));
    lookBody.append(h, grid);
  }
  const h = document.createElement('p'); h.className = 'look-head'; h.textContent = 'Font';
  const grid = document.createElement('div'); grid.className = 'look-fonts'; grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', 'Font');
  const auto = document.createElement('button');
  auto.type = 'button'; auto.className = 'look-font'; auto.dataset.font = 'auto'; auto.textContent = 'Match theme';
  grid.appendChild(auto);
  for (const f of FONTS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'look-font'; b.dataset.font = f.id; b.textContent = f.label;
    if (f.display) b.style.fontFamily = `'${f.display}', sans-serif`;
    grid.appendChild(b);
  }
  lookBody.append(h, grid);
}
function syncGallery() {
  lookBody.querySelectorAll('.look-card').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === choice.theme)));
  lookBody.querySelectorAll('.look-font').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.font === choice.font)));
}
let fontsPreviewed = false;
function openGallery() {
  vp.closePopovers();
  if (!lookBody.childElementCount) buildGallery();
  syncGallery();
  // Each font button is set in its own face, so load them only when someone looks.
  if (!fontsPreviewed) {
    fontsPreviewed = true;
    const fams = [...new Set(FONTS.flatMap((f) => [f.display]).filter(Boolean))].map((f) => 'family=' + f.replace(/ /g, '+') + ':wght@600').join('&');
    const l = document.createElement('link'); l.rel = 'stylesheet';
    l.href = `https://fonts.googleapis.com/css2?${fams}&display=swap&text=${encodeURIComponent(FONTS.map((f) => f.label).join(''))}`;
    document.head.appendChild(l);
  }
  themeDialog.showModal();
}
lookBody.addEventListener('click', (e) => {
  const t = e.target.closest('.look-card'), f = e.target.closest('.look-font');
  if (t) setLook({ theme: t.dataset.theme });
  else if (f) setLook({ font: f.dataset.font });
});
$('themeBtn').addEventListener('click', openGallery);

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
paintLook();
vp.applyTheme();
renderPens();
ready.then(() => {
  syncContext(vp.panelContext());
  pageSig = '';
  syncPages(); syncPageFacts(); syncWelcome(); refreshBase();
  // Images decode after load; give the thumbnail and navigator another pass.
  setTimeout(() => { if (panelsLive()) vp.paintCurrentThumb(); refreshBase(); }, 700);
});
