/* Vector Plane Studio — themes and fonts
   A theme only states a few colours. Everything else (hover states, secondary text,
   canvas grid, selection colour, tray) is derived here, and every text colour is
   pushed until it clears WCAG contrast, so a new theme cannot ship unreadable text.
   No DOM in this file: studio.js applies the result, and a test can import it. */

const hex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const toHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
const mix = (a, b, t) => { const x = hex(a), y = hex(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
const rgba = (h, a) => `rgba(${hex(h).join(',')},${a})`;
const lum = (h) => {
  const [r, g, b] = hex(h).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// Moves fg away from bg, a step at a time, until it reaches the ratio.
function ensure(fg, bg, min) {
  const target = lum(bg) > 0.18 ? '#000000' : '#FFFFFF';
  let c = fg;
  for (let i = 1; i <= 20 && contrast(c, bg) < min; i++) c = mix(fg, target, i / 20);
  return c;
}
const readableOn = (bg) => (contrast('#FFFFFF', bg) >= contrast('#0A0A0A', bg) ? '#FFFFFF' : '#0A0A0A');

export const FONTS = [
  { id: 'clean', label: 'Clean', ui: 'Manrope', display: 'Manrope', weight: 700, scale: 0.84 },
  { id: 'geometric', label: 'Geometric', ui: 'Outfit', display: 'Outfit', weight: 600, scale: 0.88 },
  { id: 'friendly', label: 'Friendly', ui: 'Plus Jakarta Sans', display: 'Plus Jakarta Sans', weight: 700, scale: 0.82 },
  { id: 'future', label: 'Futuristic', ui: 'Sora', display: 'Sora', weight: 600, scale: 0.78 },
  { id: 'editorial', label: 'Editorial', ui: 'DM Sans', display: 'Fraunces', weight: 500, scale: 0.9 },
  { id: 'luxe', label: 'Luxe', ui: 'Jost', display: 'Cormorant Garamond', weight: 600, scale: 1.08 },
  { id: 'rounded', label: 'Rounded', ui: 'Nunito', display: 'Nunito', weight: 800, scale: 0.86 },
  { id: 'technical', label: 'Technical', ui: 'IBM Plex Sans', display: 'JetBrains Mono', weight: 600, scale: 0.74 },
  { id: 'system', label: 'System', ui: null, display: null, weight: 650, scale: 0.84 },
];

const glow = (...spots) => spots.map(([c, x, y, r]) => `radial-gradient(${r}% ${r}% at ${x}% ${y}%, ${c} 0%, transparent 70%)`).join(',');

export const THEMES = [
  // ---- exotic ----
  { id: 'emerald', name: 'Emerald', group: 'Exotic', font: 'clean', canvas: '#07211B', panel: '#0B2C24', ink: '#E4F6EE', accent: '#34E5A8', tray: '#041712' },
  { id: 'glass-purple', name: 'Glass Purple', group: 'Exotic', font: 'geometric', canvas: '#170B33', panel: '#1E1240', ink: '#F0E9FF', accent: '#C58BFF', tray: '#140A2C',
    glass: glow(['#7C2BFF66', 12, 18, 62], ['#FF3DA540', 88, 12, 52], ['#2B5BFF55', 72, 92, 66]) },
  { id: 'gold', name: 'Gold', group: 'Exotic', font: 'luxe', canvas: '#100E08', panel: '#18140B', ink: '#F6ECD2', accent: '#E9BE4A', tray: '#0B0905' },
  { id: 'exotic-blue', name: 'Exotic Blue', group: 'Exotic', font: 'future', canvas: '#03293B', panel: '#053447', ink: '#DDF6FF', accent: '#1FD6F2', tray: '#021C29' },
  { id: 'midnight', name: 'Midnight Blue', group: 'Exotic', font: 'friendly', canvas: '#0A1128', panel: '#101A3A', ink: '#E4EAFB', accent: '#7AA7FF', tray: '#070C1E' },
  { id: 'sapphire', name: 'Royal Sapphire', group: 'Exotic', font: 'editorial', canvas: '#0B1F6B', panel: '#10287E', ink: '#E8EEFF', accent: '#FFD166', tray: '#071650' },
  { id: 'lagoon', name: 'Glass Lagoon', group: 'Exotic', font: 'geometric', canvas: '#052A33', panel: '#07333D', ink: '#E0FBFA', accent: '#3DF2D0', tray: '#03222A',
    glass: glow(['#00C2A855', 10, 80, 60], ['#0077FF4D', 85, 20, 60], ['#7CF5D033', 50, 0, 40]) },
  { id: 'aurora', name: 'Aurora', group: 'Exotic', font: 'future', canvas: '#0A1426', panel: '#101C33', ink: '#E9F5F2', accent: '#6CF7B4', tray: '#081020',
    glass: glow(['#16E0954D', 18, 8, 58], ['#8A3DFF4D', 84, 30, 60], ['#00B2FF3D', 40, 100, 62]) },
  { id: 'ruby', name: 'Ruby', group: 'Exotic', font: 'editorial', canvas: '#1C0710', panel: '#280B17', ink: '#FCE8EE', accent: '#FF5277', tray: '#13040A' },
  { id: 'neon', name: 'Neon Night', group: 'Exotic', font: 'technical', canvas: '#0C0420', panel: '#140A30', ink: '#F3ECFF', accent: '#FF3DA5', tray: '#08021A' },
  { id: 'jade', name: 'Jade', group: 'Exotic', font: 'rounded', canvas: '#E8F3EC', panel: '#F3FAF5', ink: '#0F2A20', accent: '#0B8A63', tray: '#0F2A20' },
  { id: 'rose-gold', name: 'Rose Gold', group: 'Exotic', font: 'editorial', canvas: '#FAEEE9', panel: '#FFF7F3', ink: '#3A2024', accent: '#B5566B', tray: '#3A2024' },
  { id: 'frost', name: 'Glass Frost', group: 'Exotic', font: 'clean', canvas: '#DDE9F5', panel: '#F5FAFF', ink: '#10243A', accent: '#1F7AE0', tray: '#10243A',
    glass: glow(['#8FC8FF80', 15, 15, 60], ['#C9B8FF66', 88, 25, 55], ['#9FF0E066', 60, 100, 60]) },
  // ---- basic ----
  { id: 'system', name: 'Match system', group: 'Basic', follows: { light: 'light', dark: 'dark' } },
  { id: 'light', name: 'Light', group: 'Basic', font: 'clean', canvas: '#F2F3F5', panel: '#FFFFFF', ink: '#16181D', accent: '#2563EB', tray: '#16181D' },
  { id: 'dark', name: 'Dark', group: 'Basic', font: 'clean', canvas: '#141518', panel: '#1C1D21', ink: '#ECEDEF', accent: '#60A5FA', tray: '#0E0F12' },
  { id: 'paper', name: 'Paper', group: 'Basic', font: 'editorial', canvas: '#F3EFE6', panel: '#FAF7F0', ink: '#1D1A15', accent: '#1F4FBF', tray: '#1D1A15' },
  { id: 'mono', name: 'Black & White', group: 'Basic', font: 'technical', canvas: '#0B0B0B', panel: '#121212', ink: '#F2F2F2', accent: '#F2F2F2', tray: '#000000' },
];
export const DEFAULT_THEME = 'emerald';

export function fontHref(font) {
  if (!font.ui) return '';
  const fams = [...new Set([font.ui, font.display])];
  return 'https://fonts.googleapis.com/css2?' + fams.map((f) => `family=${f.replace(/ /g, '+')}:wght@400;500;600;700;800`.replace(/(Cormorant\+Garamond|Jost|IBM\+Plex\+Sans|JetBrains\+Mono|Fraunces):wght@400;500;600;700;800/, '$1:wght@400;500;600;700')).join('&') + '&display=swap';
}

/* Turns a theme id + font choice into everything needed to paint it. */
export function resolveLook(themeId, fontId, systemDark) {
  let t = THEMES.find((x) => x.id === themeId) || THEMES.find((x) => x.id === DEFAULT_THEME);
  const picked = t;
  if (t.follows) t = THEMES.find((x) => x.id === t.follows[systemDark ? 'dark' : 'light']);
  const font = FONTS.find((f) => f.id === fontId) || FONTS.find((f) => f.id === t.font);
  const dark = lum(t.canvas) < 0.18;
  const { panel, ink, canvas, tray } = t;
  const glass = !!t.glass;

  const panel2 = mix(panel, ink, 0.06);
  const ink2 = ensure(mix(ink, panel, 0.18), panel2, 7);
  const ink3 = ensure(mix(ink, panel, 0.36), panel2, 4.6);
  const accentInk = ensure(t.accent, panel2, 4.6);
  const danger = ensure(dark ? '#FF7B72' : '#B3261E', panel2, 4.6);
  const trayInk = ensure(dark ? mix(ink, '#FFFFFF', 0.2) : mix(panel, '#FFFFFF', 0.4), tray, 10);
  const trayOn = ensure(t.accent, tray, 3.2);
  const stack = (name, fallback) => (name ? `'${name}', ${fallback}` : fallback);
  const sans = "system-ui, -apple-system, 'Segoe UI', sans-serif";

  const vars = {
    'color-scheme': dark ? 'dark' : 'light',
    '--font-ui': stack(font.ui, sans),
    '--font-display': stack(font.display, sans),
    '--display-weight': String(font.weight),
    '--display-scale': String(font.scale),
    '--backdrop': glass ? `${t.glass}, ${canvas}` : canvas,
    '--canvas': canvas,
    '--panel': glass ? rgba(panel, dark ? 0.56 : 0.62) : panel,
    '--panel-solid': panel,
    '--pop': glass ? rgba(panel, 0.86) : panel,
    '--panel-2': panel2,
    '--hover': mix(panel, ink, 0.1),
    '--press': mix(panel, ink, 0.17),
    '--line': rgba(ink, dark ? 0.13 : 0.14),
    '--line-strong': rgba(ink, 0.28),
    '--ink': ink,
    '--ink-2': ink2,
    '--ink-3': ink3,
    '--accent': t.accent,
    '--accent-hover': mix(t.accent, dark ? '#FFFFFF' : '#000000', 0.14),
    '--accent-ink': accentInk,
    '--accent-soft': rgba(t.accent, 0.16),
    '--on-accent': readableOn(t.accent),
    '--danger': danger,
    '--danger-soft': rgba(danger, 0.14),
    '--scrim': dark ? 'rgba(0,0,0,0.55)' : rgba(ink, 0.36),
    '--tray': glass ? rgba(tray, 0.72) : tray,
    '--tray-solid': tray,
    '--tray-line': rgba(trayInk, 0.16),
    '--tray-ink': trayInk,
    '--tray-ink-2': ensure(mix(trayInk, tray, 0.32), tray, 4.6),
    '--tray-hover': rgba(trayInk, 0.11),
    '--tray-press': rgba(trayInk, 0.18),
    '--tray-on': trayOn,
    '--tray-on-ink': readableOn(trayOn),
    '--shadow-tray': dark
      ? '0 1px 0 rgba(255,255,255,0.06) inset, 0 2px 6px rgba(0,0,0,0.4), 0 16px 34px rgba(0,0,0,0.5)'
      : `0 1px 0 rgba(255,255,255,0.05) inset, 0 2px 4px ${rgba(ink, 0.16)}, 0 14px 30px ${rgba(ink, 0.24)}`,
    '--shadow-pop': dark
      ? '0 2px 8px rgba(0,0,0,0.4), 0 18px 40px rgba(0,0,0,0.5)'
      : `0 2px 6px ${rgba(ink, 0.1)}, 0 16px 36px ${rgba(ink, 0.16)}`,
  };

  return {
    id: picked.id, dark, glass, vars,
    fontHref: fontHref(font), fontId: font.id, themeColor: panel, accent: t.accent, accentFill: rgba(t.accent, 0.12),
    canvasColors: {
      paper: canvas, desk: mix(canvas, dark ? '#000000' : ink, dark ? 0.4 : 0.12), sheet: dark ? mix(panel, '#FFFFFF', 0.03) : mix(panel, '#FFFFFF', 0.6),
      sheetEdge: rgba(ink, 0.16), gridMajor: rgba(ink, dark ? 0.13 : 0.11), gridMinor: rgba(ink, dark ? 0.055 : 0.05),
      axisX: rgba(t.accent, dark ? 0.45 : 0.34), axisY: rgba(ink, dark ? 0.26 : 0.24),
      connector: rgba(ink, dark ? 0.72 : 0.6), select: dark ? t.accent : accentInk, selectFill: rgba(t.accent, dark ? 0.12 : 0.1),
      seeThrough: glass,
    },
  };
}
