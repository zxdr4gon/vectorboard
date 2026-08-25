# 🎨 Infinite Canvas

A lightweight, zero-dependency infinite vector whiteboard built with vanilla HTML5 Canvas, CSS3, and JavaScript. Designed for smooth diagramming, note-taking, and sketching across mobile, Chromebooks, and desktop.

---

## ✨ Features

### 🖌️ Drawing & Vector Engine

* **Dynamic Brush Modes:** Switch between Pen, Marker, and Highlighter with custom alpha blending and composite operations.
* **Bézier Path Smoothing:** Midpoint quadratic curve interpolation transforms raw pointer input into smooth vector strokes.
* **Hold-to-Snap Lines:** Automatic geometric line straightening when holding your stroke still at the end of a drawing action.
* **Editable Text Nodes:** Double-click or select the text tool to spawn interactive, auto-resizing text boxes directly on the canvas coordinates.

### 🔍 Camera & Navigation

* **Infinite Workspace:** Pan and zoom seamlessly across an unbounded grid canvas.
* **Smart Grid Rendering:** Adaptive zoom-based grid system with dynamic major and minor axis lines.
* **Coordinates & Zoom Readout:** Live tracking of camera position and scale percentage.

### 📱 UI & Customization

* **Responsive Layout:** Collapsible control panels designed specifically to prevent UI overlap on smartphones, tablets, and Chromebooks.
* **Smooth Dark Mode:** One-click toggle between crisp light paper and dark theme, seamlessly re-indexing canvas grid colors.
* **Custom 3D Iconography:** Built-in whiteboard tab favicon for easy browser bookmarking.

### 💾 Data & Portability

* **Auto-Save Local Storage:** Live state persistence in browser storage prevents accidental progress loss.
* **JSON File Sync:** Export complete canvas states as lightweight `.json` files to save on Google Drive or transfer across devices.
* **Image Export:** Fast high-resolution PNG and SVG rendering.

---

## ⌨️ Controls & Shortcuts

| Action | Control |
| --- | --- |
| **Draw / Write** | Left-Click + Drag / Touch Drag |
| **Pan Canvas** | Middle-Click Drag / Two-Finger Drag / Hand Tool |
| **Zoom In / Out** | Mouse Wheel / Pinch Gesture |
| **Snap Straight Line** | Hold stylus/mouse still for `600ms` at end of stroke |
| **Add Text** | Select Text Tool $\rightarrow$ Click anywhere on Canvas |
| **Toggle UI Panels** | Click the arrow button ($\land$ / $\lor$) on any panel |

---

## 🚀 Quick Start

No installation or build steps required.

1. **Clone or Download** this repository:
```bash
git clone https://github.com/your-username/infinite-canvas.git

```


2. **Open** `index.html` in any modern web browser.
3. **Deploy** directly to **GitHub Pages** for instant multi-device sync!

---

## 🗺️ Technical Architecture

```text
├── index.html            # Core structural DOM & UI control panels
├── CSS Styles            # Flexbox layout, CSS variables & mobile media queries
└── JavaScript App State
    ├── Camera System     # World-to-Screen / Screen-to-World coordinate matrix
    ├── Render Loop       # Dynamic canvas repaint with theme-aware grid logic
    ├── Event Handlers    # Pointer events, snap timers & floating DOM text nodes
    └── Storage Manager   # LocalStorage & Blob JSON import/export

```
