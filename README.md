# VIOS – Video & Timeline Accelerator

> A Chrome Extension (Manifest V3) that uniformly accelerates both HTML5 media **and** the underlying JavaScript animation timelines on e-learning platforms — eliminating the audio-visual desynchronization caused by standard `playbackRate` hacks.

![License](https://img.shields.io/badge/license-MIT-6C5CE7?style=flat-square)
![Manifest](https://img.shields.io/badge/Manifest-V3-4CAF50?style=flat-square)
![Chrome](https://img.shields.io/badge/Chrome-Extension-FCD34D?style=flat-square)

---

## The Problem

Modern e-learning platforms (Articulate Storyline, Adobe Captivate, iSpring, etc.) compile courses into JavaScript-driven single-page applications. The visual slides, CSS animations, and "Next" button unlock logic are all governed by **internal JavaScript timers** — not by the `<audio>` element's clock.

Setting `audio.playbackRate = 2` speeds up the narration, but the visual timeline stays locked at real-time. The learner hears silence for half the slide while waiting for the JS state machine to catch up.

VIOS fixes this by **warping time itself** at the browser API level.

---

## How It Works

VIOS injects a time-warp script directly into the page's MAIN execution world and overrides the browser's core timing APIs:

| API Hooked | Effect at 2× Speed |
|---|---|
| `Date.now()` | Returns timestamps that advance 2× faster |
| `performance.now()` | Returns hi-res timestamps at 2× the real rate |
| `setTimeout(fn, 1000)` | Fires in ~500 ms of real time |
| `setInterval(fn, 500)` | Ticks every ~250 ms of real time |
| `requestAnimationFrame` | Delivers virtual timestamps so per-frame `dt` is 2× larger |
| `audio/video.playbackRate` | Locked to the same multiplier via MutationObserver |
| Web Animations API | `animation.updatePlaybackRate()` applied to all running animations |

Because courseware computes `dt = now - lastTimestamp`, it naturally sees a larger delta per tick and advances its internal slide clock at the target speed — without any framework-specific hacks.

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│ ISOLATED World                                           │
│   content.js  →  Floating UI overlay                     │
│                  window.postMessage(VIOS_SET_SPEED)  ─── │──┐
└──────────────────────────────────────────────────────────┘  │
                                                               ▼
┌──────────────────────────────────────────────────────────┐
│ MAIN World                                               │
│   inject.js   →  Hooks: Date / performance / timers / rAF│
│                  Locks: audio + video playbackRate        │
│                  Scales: CSS & Web Animations             │
└──────────────────────────────────────────────────────────┘
                                                               │
┌──────────────────────────────────────────────────────────┐  │
│ Service Worker                                           │◄─┘
│   background.js  →  Badge update / lifecycle             │
└──────────────────────────────────────────────────────────┘
```

---

## Features

- ⚡ **Global time-warp** — scales `setTimeout`, `setInterval`, `requestAnimationFrame`, `Date.now`, `performance.now` simultaneously
- 🎵 **Media sync** — locks `playbackRate` of all `<audio>` and `<video>` elements to the active speed multiplier
- 🌑 **Shadow DOM + iframe piercing** — finds media elements in nested shadow roots and same-origin iframes
- 🔄 **Hot speed changes** — re-anchors the virtual clock on every speed change (no timestamp jumps)
- 🎨 **Draggable glassmorphism overlay** — fixed-position floating UI with micro-animations
- ⌨️ **Keyboard shortcuts** — `Alt+]` / `Alt+[` / `Alt+\` for speed up, slow down, reset
- 🏷️ **Extension badge** — shows active multiplier at a glance in the browser toolbar
- 📐 **Speed range** — 0.25× to 4.0× in 0.25× increments

---

## Installation

### From Source (Developer Mode)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the project folder

The VIOS badge will appear in your browser toolbar.

---

## Usage

Navigate to any e-learning course. The floating VIOS panel appears in the **bottom-right corner**.

| Control | Action |
|---|---|
| **+** button | Increase speed by 0.25× |
| **−** button | Decrease speed by 0.25× |
| **↺** button | Reset to 1.0× (real-time) |
| Drag panel | Reposition the overlay anywhere on screen |
| `Alt + ]` | Increase speed (keyboard) |
| `Alt + [` | Decrease speed (keyboard) |
| `Alt + \` | Reset to 1.0× (keyboard) |

The speed label colour-codes the active multiplier:
- 🟢 **Green** — slower than real-time (< 1×)
- ⚪ **White** — real-time (1.0×)
- 🟡 **Amber** — moderately fast (1.25× – 2.0×)
- 🟠 **Orange** — very fast (2.25× – 4.0×)

---

## Compatibility

Tested against:

| Platform | Mechanism | Status |
|---|---|---|
| Articulate Storyline 360 | JS state machine + hidden `<audio>` | ✅ Works |
| Adobe Captivate | JS timeline + `<audio>` | ✅ Works |
| iSpring Suite | JS slideshow + `<audio>` | ✅ Works |
| Generic HTML5 video | Native `<video>` element | ✅ Works |

> **Note:** Cross-origin iframes and DRM-protected media cannot be accelerated due to browser security restrictions.

---

## Project Structure

```
VIOS-media-extension/
├── manifest.json       # MV3 extension manifest
├── background.js       # Service worker (lifecycle + badge)
├── content.js          # Isolated-world script + floating UI
├── inject.js           # MAIN-world time-warp engine
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── README.md
├── LICENSE
└── .gitignore
```

---

## ⚠️ Disclaimer

By accelerating internal JavaScript timelines, VIOS may affect time-in-seat tracking and SCORM/xAPI completion reporting. This can interfere with compliance logging for regulated training (e.g., OSHA, professional certifications). **Use responsibly and only on courseware you are authorised to access.**

---

## License

[MIT](LICENSE) © 2026 VIOS Contributors
