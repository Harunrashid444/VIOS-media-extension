/**
 * ============================================================================
 * VIOS – Global Time-Warp Engine  (inject.js)
 * ============================================================================
 *
 * THIS SCRIPT RUNS IN THE **MAIN** EXECUTION WORLD.
 *
 * It is declared in manifest.json as a `"world": "MAIN"` content script at
 * `document_start`, which guarantees it executes *before* any page script —
 * essential, because courseware caches references to `setTimeout` and friends
 * during its own bootstrap.  (Injecting a <script src=chrome-extension://…>
 * tag from the isolated world does NOT give that guarantee, and is blocked
 * outright by strict page CSP.)
 *
 * ── Architecture ──────────────────────────────────────────────────────────
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │                   Page JS Context                       │
 *   │                                                         │
 *   │  courseware calls setTimeout(fn, 5000)                  │
 *   │        │                                                │
 *   │        ▼                                                │
 *   │  VIOS proxy:  nativeSetTimeout(fn, 5000 / multiplier)   │
 *   │        │                                                │
 *   │        ▼                                                │
 *   │  fn() fires in 2500 ms at 2× speed                      │
 *   └─────────────────────────────────────────────────────────┘
 *
 * ── What Gets Hooked ─────────────────────────────────────────────────────
 *
 *   • Date.now()             – returns scaled timestamps
 *   • performance.now()      – returns scaled hi-res timestamps
 *   • new Date()             – constructor returns scaled Date objects
 *   • setTimeout / clearTimeout
 *   • setInterval / clearInterval
 *   • requestAnimationFrame / cancelAnimationFrame
 *   • Element.attachShadow   – so media inside shadow roots is discoverable
 *   • <audio>.playbackRate / <video>.playbackRate
 *
 * ── Communication ────────────────────────────────────────────────────────
 *
 *   The content script (ISOLATED world) sends speed changes via
 *   `window.postMessage({ type: 'VIOS_SET_SPEED', speed: 2.0 })`.
 *
 * ============================================================================
 */

(function () {
  'use strict';

  // =========================================================================
  // 0.  Guard Against Double-Injection
  // =========================================================================
  if (window.__VIOS_INJECTED__) return;
  window.__VIOS_INJECTED__ = true;

  console.log('[VIOS inject] Time-Warp Engine initialising…');

  // =========================================================================
  // 1.  Preserve Pristine References to Native APIs
  // =========================================================================
  //
  // Captured FIRST, before we install any override, so every internal helper
  // keeps talking to real wall-clock time.

  const _setTimeout             = window.setTimeout.bind(window);
  const _clearTimeout           = window.clearTimeout.bind(window);
  const _setInterval            = window.setInterval.bind(window);
  const _clearInterval          = window.clearInterval.bind(window);
  const _requestAnimationFrame  = window.requestAnimationFrame.bind(window);
  const _cancelAnimationFrame   = window.cancelAnimationFrame.bind(window);
  const _perfNow                = performance.now.bind(performance);
  const _DateNow                = Date.now;
  const _DateCtor               = Date;
  const _postMessage            = window.postMessage.bind(window);

  // =========================================================================
  // 2.  State
  // =========================================================================

  /** Current global speed multiplier (1.0 = real-time). */
  let SPEED = 1.0;

  const MIN_SPEED = 0.25;
  const MAX_SPEED = 4.0;

  /** Browsers clamp delays above this to "fire immediately". */
  const MAX_DELAY = 2147483647;

  /**
   * Anchor timestamps captured at the moment the speed *last changed*.
   * We need these to calculate the "virtual" elapsed time.
   *
   * virtualNow = anchorVirtual + (realNow - anchorReal) * SPEED
   */
  let anchorReal        = _perfNow();
  let anchorVirtual     = _perfNow();
  let anchorDateReal    = _DateNow();
  let anchorDateVirtual = _DateNow();

  // =========================================================================
  // 3.  Virtual Clock Helpers
  // =========================================================================

  /**
   * Returns the "virtual" high-resolution timestamp.
   * At 2× speed, if 500 ms of *real* time has passed since the anchor,
   * this returns anchor + 1000.
   */
  function virtualPerfNow() {
    const realElapsed = _perfNow() - anchorReal;
    return anchorVirtual + realElapsed * SPEED;
  }

  /**
   * Returns the "virtual" epoch-millisecond timestamp (replaces Date.now()).
   * Native `Date.now()` always yields an integer, so we floor: some courseware
   * feeds the result straight into bitwise arithmetic or uses it as a Map key.
   */
  function virtualDateNow() {
    const realElapsed = _DateNow() - anchorDateReal;
    return Math.floor(anchorDateVirtual + realElapsed * SPEED);
  }

  // =========================================================================
  // 4.  Update Anchors When Speed Changes
  // =========================================================================

  /**
   * Must be called **before** SPEED is updated.
   * Commits the virtual time accumulated so far and resets the real anchor,
   * so the virtual clock stays continuous across a speed change.
   */
  function reanchor() {
    // Capture current virtual positions under the *old* speed.
    anchorVirtual     = virtualPerfNow();
    anchorReal        = _perfNow();
    anchorDateVirtual = virtualDateNow();
    anchorDateReal    = _DateNow();
  }

  // =========================================================================
  // 5.  Override: performance.now()
  // =========================================================================

  performance.now = function now() {
    return virtualPerfNow();
  };

  // =========================================================================
  // 6.  Override: Date.now() and the Date Constructor
  // =========================================================================

  // Keep a direct handle on the override.  The Proxy's `get` trap below MUST
  // return *this* function and never read `Date.now` off the global, because
  // by then the global `Date` *is* the Proxy — that would recurse forever.
  const virtualDateNowFn = function now() {
    return virtualDateNow();
  };

  Date.now = virtualDateNowFn;

  /**
   * We need to handle both `new Date()` (no args → current time) and
   * `new Date(value)` / `new Date(y, m, d, …)` (explicit values).
   *
   * We use a Proxy so `instanceof Date` and `class X extends Date` still work.
   * NOTE: we must NOT assign `DateProxy.prototype` — `Date.prototype` is
   * non-writable, so under 'use strict' that assignment throws a TypeError
   * and kills the rest of this script.  A Proxy already forwards `prototype`
   * to its target, so the prototype chain is intact for free.
   */
  const DateProxy = new Proxy(_DateCtor, {
    construct(target, args, newTarget) {
      // No arguments → caller wants "now" → give virtual now.
      // Forwarding `newTarget` keeps subclassing (`class X extends Date`) working.
      if (args.length === 0) {
        return Reflect.construct(target, [virtualDateNow()], newTarget);
      }
      // Explicit arguments → pass through unchanged.
      return Reflect.construct(target, args, newTarget);
    },
    apply() {
      // `Date()` called as a function returns the current time as a string and
      // ignores any arguments — matching native behaviour, on the virtual clock.
      return new _DateCtor(virtualDateNow()).toString();
    },
    get(target, prop) {
      // Forward static methods like Date.parse / Date.UTC untouched.
      if (prop === 'now') return virtualDateNowFn;
      return Reflect.get(target, prop, target);
    },
  });

  window.Date = DateProxy;

  // =========================================================================
  // 7.  Shared Timer Plumbing
  // =========================================================================

  /**
   * Native timers invoke their callback with `this === window`.  Our wrappers
   * live in a strict-mode IIFE, so a bare `callback(...)` would pass
   * `this === undefined` and break legacy courseware that relies on the
   * classic binding.
   */
  function invokeCallback(callback, args) {
    if (typeof callback === 'function') return callback.apply(window, args);
    // Legacy: setTimeout/setInterval accept a string to eval.
    if (callback != null) return (0, eval)(String(callback)); // eslint-disable-line no-eval
  }

  function normaliseDelay(delay) {
    const d = Number(delay);
    return Number.isFinite(d) && d > 0 ? d : 0;
  }

  /** Converts a *virtual* duration into the real delay to hand the browser. */
  function toRealDelay(virtualMs) {
    return Math.min(MAX_DELAY, Math.max(0, virtualMs / SPEED));
  }

  // Our handles live in high, disjoint numeric ranges so that a `clearTimeout`
  // carrying one of our IDs can never collide with — and silently cancel — an
  // unrelated *native* timer (native IDs are small sequential integers).
  let nextTimeoutId  = 0x40000000;
  let nextIntervalId = 0x50000000;
  let nextRafId      = 0x60000000;

  const pendingTimeouts = new Map(); // ourId → record
  const intervalMap     = new Map(); // ourId → record
  const rafMap          = new Map(); // ourId → record

  // =========================================================================
  // 8.  Override: setTimeout / clearTimeout
  // =========================================================================

  /**
   * We shrink the delay by the speed multiplier: at 2× a 1000 ms timeout fires
   * in 500 ms of wall-clock time.
   *
   * Each pending timeout also remembers its *virtual* deadline so that a speed
   * change mid-flight can re-schedule it (see `rescheduleTimers`).  Without
   * that, a `setTimeout(next, 60000)` armed at 1× would still take a full real
   * minute even after the user selects 4× — which is exactly the case that
   * matters, because slide-advance timers are armed once at slide start.
   */

  window.setTimeout = function setTimeout(callback, delay, ...args) {
    const virtualDelay = normaliseDelay(delay);
    const id = nextTimeoutId++;

    const record = {
      virtualDeadline: virtualPerfNow() + virtualDelay,
      nativeId: null,
      fire() {
        pendingTimeouts.delete(id);
        invokeCallback(callback, args);
      },
    };

    record.nativeId = _setTimeout(record.fire, toRealDelay(virtualDelay));
    pendingTimeouts.set(id, record);
    return id;
  };

  window.clearTimeout = function clearTimeout(id) {
    const record = pendingTimeouts.get(id);
    if (record) {
      _clearTimeout(record.nativeId);
      pendingTimeouts.delete(id);
      return;
    }
    // Per spec the timeout and interval ID spaces are shared, so clearTimeout
    // is allowed to cancel an interval.
    if (intervalMap.has(id)) {
      window.clearInterval(id);
      return;
    }
    // Otherwise it's a native ID from before we hooked (or another realm).
    _clearTimeout(id);
  };

  // =========================================================================
  // 9.  Override: setInterval / clearInterval
  // =========================================================================

  /**
   * Intervals are trickier because the repeat period is fixed at creation.
   * We replace each native interval with a self-rescheduling setTimeout so
   * that every tick can re-read the *current* SPEED value.
   */

  window.setInterval = function setInterval(callback, delay, ...args) {
    const virtualDelay = normaliseDelay(delay);
    const id = nextIntervalId++;

    const record = {
      cancelled: false,
      nativeId: null,
      virtualDeadline: virtualPerfNow() + virtualDelay,
      tick() {
        if (record.cancelled) return;

        invokeCallback(callback, args);

        // The callback may have cleared this interval (or navigated away).
        if (record.cancelled) return;

        record.virtualDeadline = virtualPerfNow() + virtualDelay;
        record.nativeId = _setTimeout(record.tick, toRealDelay(virtualDelay));
      },
    };

    record.nativeId = _setTimeout(record.tick, toRealDelay(virtualDelay));
    intervalMap.set(id, record);
    return id;
  };

  window.clearInterval = function clearInterval(id) {
    const record = intervalMap.get(id);
    if (record) {
      record.cancelled = true;
      _clearTimeout(record.nativeId);
      intervalMap.delete(id);
      return;
    }
    if (pendingTimeouts.has(id)) {
      window.clearTimeout(id);
      return;
    }
    // Might be a native interval created before our hook.
    _clearInterval(id);
  };

  // =========================================================================
  // 9b. Re-scale In-Flight Timers On Speed Change
  // =========================================================================

  /**
   * Called right after SPEED changes.  Every armed timer keeps its *virtual*
   * deadline; only the real delay handed to the browser is recomputed.
   */
  function rescheduleTimers() {
    const vnow = virtualPerfNow();

    for (const record of pendingTimeouts.values()) {
      _clearTimeout(record.nativeId);
      record.nativeId = _setTimeout(record.fire, toRealDelay(record.virtualDeadline - vnow));
    }

    for (const record of intervalMap.values()) {
      if (record.cancelled) continue;
      _clearTimeout(record.nativeId);
      record.nativeId = _setTimeout(record.tick, toRealDelay(record.virtualDeadline - vnow));
    }
  }

  // =========================================================================
  // 10. Override: requestAnimationFrame / cancelAnimationFrame
  // =========================================================================

  /**
   * rAF callbacks receive a DOMHighResTimeStamp.  We hand them the *virtual*
   * timestamp, so courseware computing `dt = timestamp - lastTimestamp` sees
   * `dt * SPEED` and advances its timeline proportionally faster.  That is the
   * whole trick — the real frame rate is untouched.
   *
   * Crucially the callback must be invoked EXACTLY ONCE per request: animation
   * loops re-arm themselves from inside the callback, so any extra invocation
   * multiplies the number of live requests on every frame.
   */

  window.requestAnimationFrame = function requestAnimationFrame(callback) {
    const id = nextRafId++;
    const record = { nativeId: null, cancelled: false };
    rafMap.set(id, record);

    record.nativeId = _requestAnimationFrame(() => {
      if (record.cancelled) return;
      rafMap.delete(id);
      // Deliver the *virtual* timestamp, with the native `this === window`.
      callback.call(window, virtualPerfNow());
    });

    return id;
  };

  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    const record = rafMap.get(id);
    if (record) {
      record.cancelled = true;
      _cancelAnimationFrame(record.nativeId);
      rafMap.delete(id);
      return;
    }
    // Only forward IDs that cannot be ours, or we'd cancel a stranger's frame.
    if (typeof id === 'number' && id >= 0x60000000) return;
    _cancelAnimationFrame(id);
  };

  // =========================================================================
  // 11. Media Element Scanner  –  playbackRate Synchronisation
  // =========================================================================

  /**
   * Courseware can create <audio> / <video> elements at any time and may
   * nest them inside Shadow DOM or same-origin <iframe>s.
   *
   * Strategy:
   *   a. MutationObserver on every reachable root (document, shadow roots,
   *      same-origin iframe documents).
   *   b. Hook `attachShadow` so roots created *after* their host is inserted
   *      — including closed ones, which are otherwise invisible — are caught.
   *   c. Periodic fallback sweep every 2 s (real time) for anything missed.
   *   d. On speed change, immediately sweep all known media elements.
   */

  /** Media elements we've already attached a keeper listener to. */
  const knownMedia = new WeakSet();
  /** Roots that already have a MutationObserver (prevents duplicate observers). */
  const observedRoots = new WeakSet();
  /** Iframes that already have a `load` handler. */
  const hookedIframes = new WeakSet();

  /** Depth cap for the recursive descent, as cheap cycle insurance. */
  const MAX_SCAN_DEPTH = 8;

  /**
   * Ceiling on live MutationObservers.  Shadow roots need one observer each
   * (a document-level observer cannot see inside them), and a component-heavy
   * page can host thousands.  Past this point the 2 s sweep is the safety net.
   */
  const MAX_OBSERVED_ROOTS = 400;
  let observedRootCount = 0;

  /**
   * Pins a media element's playbackRate to the current SPEED and keeps it
   * there.  `defaultPlaybackRate` matters as much as `playbackRate`: when
   * courseware swaps the `src` on a recycled <audio> element (Storyline does
   * this on every slide) the browser resets playbackRate to the *default*.
   */
  function lockMediaRate(el) {
    try {
      el.defaultPlaybackRate = SPEED;
      el.playbackRate = SPEED;
    } catch (_) {
      return; // Unsupported / detached media – nothing we can do.
    }

    if (knownMedia.has(el)) return;
    knownMedia.add(el);

    // Re-apply if the courseware resets it.
    el.addEventListener('ratechange', () => {
      if (Math.abs(el.playbackRate - SPEED) > 0.01) {
        try { el.playbackRate = SPEED; } catch (_) { /* ignore */ }
      }
    });
  }

  /**
   * Attaches a `load` handler to an iframe (once) and, if its document is
   * already reachable, scans and observes it now.
   */
  function handleIframe(iframe, depth) {
    if (!hookedIframes.has(iframe)) {
      hookedIframes.add(iframe);
      iframe.addEventListener('load', () => {
        try {
          const doc = iframe.contentDocument;
          if (doc) scanAndObserve(doc, depth + 1);
        } catch (_) { /* cross-origin */ }
      });
    }

    try {
      const doc = iframe.contentDocument;
      if (doc) scanAndObserve(doc, depth + 1);
    } catch (_) { /* cross-origin */ }
  }

  /**
   * Recursively scans a root node for <audio> and <video> elements,
   * piercing open Shadow DOMs and descending into same-origin <iframe>s.
   *
   * A single `querySelectorAll('*')` walk covers media, shadow hosts and
   * iframes — this runs on a 2 s timer, so the extra passes the previous
   * version made were pure overhead on large courseware DOMs.
   */
  function scanForMedia(root, depth) {
    if (!root || depth > MAX_SCAN_DEPTH) return;
    if (typeof root.querySelectorAll !== 'function') return;

    for (const el of root.querySelectorAll('*')) {
      const tag = el.tagName;
      if (tag === 'AUDIO' || tag === 'VIDEO') {
        lockMediaRate(el);
      } else if (tag === 'IFRAME') {
        handleIframe(el, depth);
      }
      if (el.shadowRoot) scanAndObserve(el.shadowRoot, depth + 1);
    }
  }

  /** Scan a root for existing media *and* watch it for future additions. */
  function scanAndObserve(root, depth = 0) {
    if (!root || depth > MAX_SCAN_DEPTH) return;
    scanForMedia(root, depth);
    observeRoot(root, depth);
  }

  // --- 11a. MutationObserver --------------------------------------------------

  /**
   * Installs a MutationObserver on the given root that watches for newly
   * added <audio>, <video>, <iframe>, and shadow-hosting elements.
   */
  function observeRoot(root, depth = 0) {
    if (!root || observedRoots.has(root)) return;
    if (typeof root.querySelectorAll !== 'function') return;
    if (observedRootCount >= MAX_OBSERVED_ROOTS) return;

    observedRoots.add(root);
    observedRootCount++;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          // The added node itself…
          const tag = node.tagName;
          if (tag === 'AUDIO' || tag === 'VIDEO') {
            lockMediaRate(node);
          } else if (tag === 'IFRAME') {
            handleIframe(node, depth);
          }
          if (node.shadowRoot) scanAndObserve(node.shadowRoot, depth + 1);

          // …and everything underneath it.
          scanForMedia(node, depth);
        }
      }
    });

    observer.observe(root, { childList: true, subtree: true });
  }

  // --- 11b. attachShadow Hook -------------------------------------------------

  /**
   * A shadow root is almost always attached *after* its host lands in the DOM,
   * so the MutationObserver that saw the host sees `shadowRoot === null`.
   * Hooking `attachShadow` catches every root at creation — closed ones too,
   * which no amount of DOM walking can find.
   */
  const _attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadow(init) {
    const root = _attachShadow.call(this, init);
    try { scanAndObserve(root); } catch (_) { /* never break the page */ }
    return root;
  };

  // Start scanning + observing the main document.
  scanAndObserve(document);

  // --- 11c. Periodic Fallback Sweep -------------------------------------------

  _setInterval(() => {
    scanAndObserve(document);
    scaleWebAnimations();
  }, 2000);

  // =========================================================================
  // 12. Courseware Framework Detection & Helpers (Non-Cheat)
  // =========================================================================

  /**
   * NOTE:  Per the project constraints we do NOT set framework variables
   * like `player.SetVar('slide_complete', true)`.  We rely solely on
   * time-warping so the courseware's *own* progression events fire
   * naturally — just faster.
   *
   * However, we log detection of known frameworks for diagnostic purposes.
   */

  function detectFrameworks() {
    const detected = [];

    // Articulate Storyline
    if (typeof window.GetPlayer === 'function') {
      detected.push('Articulate Storyline');
    }

    // Adobe Captivate
    if (window.cp || window.cpCmndGotoSlide) {
      detected.push('Adobe Captivate');
    }

    // iSpring
    if (window.iSpringPresentationConnector) {
      detected.push('iSpring');
    }

    if (detected.length > 0) {
      console.log(`[VIOS inject] Detected courseware framework(s): ${detected.join(', ')}`);
    }
  }

  // Run detection after a short delay to allow courseware to initialise.
  _setTimeout(detectFrameworks, 3000);

  // =========================================================================
  // 13. CSS Animations & Transitions Scaling
  // =========================================================================

  /**
   * Exposes the active multiplier as a custom property so page authors (and
   * our own future stylesheets) can react to it.  The real work for CSS-driven
   * motion happens in §13b: CSS animations *and* transitions are exposed
   * through the Web Animations API, so `updatePlaybackRate` scales them
   * properly without us having to guess their authored durations.
   */

  const STYLE_ID = '__vios_css_timescale__';

  function applyCssTimeScale() {
    let styleEl = document.getElementById(STYLE_ID);

    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(styleEl);
    }

    styleEl.textContent = SPEED === 1 ? '' : `:root { --vios-speed: ${SPEED}; }`;
  }

  // --- 13b. Web Animations API ------------------------------------------------

  /**
   * Scale the playbackRate of all running Web Animations on the document.
   */
  function scaleWebAnimations() {
    try {
      const animations = document.getAnimations();
      for (const anim of animations) {
        if (anim.playbackRate !== SPEED) {
          anim.updatePlaybackRate(SPEED);
        }
      }
    } catch (_) {
      // getAnimations not supported – no-op.
    }
  }

  // =========================================================================
  // 14. Speed-Change Handler  –  Message Listener
  // =========================================================================

  window.addEventListener('message', (event) => {
    // Only accept messages posted into *this* window.  Because the content
    // script and this engine share a window, `event.source === window` also
    // implies same-origin; a cross-origin frame can never satisfy it.
    if (event.source !== window) return;

    const data = event.data;
    if (!data || data.type !== 'VIOS_SET_SPEED') return;

    const newSpeed = typeof data.speed === 'number' ? data.speed : parseFloat(data.speed);

    // Validate.  A non-finite or zero SPEED would turn every scaled delay into
    // Infinity/NaN and permanently wedge the page's timers.
    if (!Number.isFinite(newSpeed) || newSpeed < MIN_SPEED || newSpeed > MAX_SPEED) {
      console.warn(`[VIOS inject] Rejected invalid speed: ${data.speed}`);
      return;
    }

    if (newSpeed === SPEED) return;

    // Commit current virtual time before changing SPEED, so the virtual clock
    // is continuous across the switch.
    reanchor();
    SPEED = newSpeed;
    console.log(`[VIOS inject] Speed set to ${SPEED}×`);

    // Re-scale timers that were already armed under the previous speed.
    rescheduleTimers();

    // Immediately apply to all existing media elements.
    scanAndObserve(document);

    // Apply CSS time-scaling and scale running Web Animations.
    applyCssTimeScale();
    scaleWebAnimations();

    // Acknowledge back to the content script.
    _postMessage({ type: 'VIOS_SPEED_ACK', speed: SPEED }, '*');
  });

  // =========================================================================
  // 15. Initial State
  // =========================================================================

  applyCssTimeScale();

  // Tell the content script we're live.  It replies with the current speed,
  // which closes the load-order race: whichever of the two worlds starts
  // second, the engine still ends up at the speed the UI is showing.
  _postMessage({ type: 'VIOS_ENGINE_READY' }, '*');

  console.log('[VIOS inject] Time-Warp Engine ready.  Speed: ' + SPEED + '×');
})();
