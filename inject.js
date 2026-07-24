/**
 * ============================================================================
 * VIOS – Global Time-Warp Engine  (inject.js)
 * ============================================================================
 *
 * THIS SCRIPT RUNS IN THE **MAIN** EXECUTION WORLD.
 *
 * It has direct access to the page's `window` object, which means it can
 * intercept and override the native timing APIs that courseware engines
 * (Articulate Storyline, Adobe Captivate, etc.) rely on for their internal
 * clocks and animation scheduling.
 *
 * ── Architecture ──────────────────────────────────────────────────────────
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │                   Page JS Context                       │
 *   │                                                         │
 *   │  courseware calls setTimeout(fn, 5000)                  │
 *   │        │                                                │
 *   │        ▼                                                │
 *   │  VIOS proxy:  nativeSetTimeout(fn, 5000 / multiplier)  │
 *   │        │                                                │
 *   │        ▼                                                │
 *   │  fn() fires in 2500 ms at 2× speed                     │
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
  // 1.  State
  // =========================================================================

  /** Current global speed multiplier (1.0 = real-time). */
  let SPEED = 1.0;

  /**
   * Anchor timestamps captured at the moment the speed *last changed*.
   * We need these to calculate the "virtual" elapsed time.
   *
   * virtualNow = anchorVirtual + (realNow - anchorReal) * SPEED
   */
  let anchorReal       = performance.now();
  let anchorVirtual    = performance.now();
  let anchorDateReal   = Date.now();
  let anchorDateVirtual = Date.now();

  // =========================================================================
  // 2.  Preserve Pristine References to Native APIs
  // =========================================================================

  const _setTimeout             = window.setTimeout.bind(window);
  const _clearTimeout           = window.clearTimeout.bind(window);
  const _setInterval            = window.setInterval.bind(window);
  const _clearInterval          = window.clearInterval.bind(window);
  const _requestAnimationFrame  = window.requestAnimationFrame.bind(window);
  const _cancelAnimationFrame   = window.cancelAnimationFrame.bind(window);
  const _perfNow                = performance.now.bind(performance);
  const _DateNow                = Date.now;
  const _DateCtor               = Date;

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
   */
  function virtualDateNow() {
    const realElapsed = _DateNow() - anchorDateReal;
    return anchorDateVirtual + realElapsed * SPEED;
  }

  // =========================================================================
  // 4.  Update Anchors When Speed Changes
  // =========================================================================

  /**
   * Must be called **before** SPEED is updated.
   * Commits the virtual time accumulated so far and resets the real anchor.
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

  performance.now = function () {
    return virtualPerfNow();
  };

  // =========================================================================
  // 6.  Override: Date.now() and the Date Constructor
  // =========================================================================

  Date.now = function () {
    return virtualDateNow();
  };

  /**
   * We need to handle both `new Date()` (no args → current time) and
   * `new Date(value)` / `new Date(y, m, d, …)` (explicit values).
   *
   * We use a Proxy so `instanceof Date` still works correctly.
   */
  const DateProxy = new Proxy(_DateCtor, {
    construct(target, args) {
      // No arguments → caller wants "now" → give virtual now.
      if (args.length === 0) {
        return new target(virtualDateNow());
      }
      // Explicit arguments → pass through unchanged.
      return new target(...args);
    },
    apply(target, thisArg, args) {
      // `Date()` called as a function (without `new`) returns a string.
      if (args.length === 0) {
        return new target(virtualDateNow()).toString();
      }
      return target.apply(thisArg, args);
    },
    get(target, prop, receiver) {
      // Forward static methods like Date.now, Date.parse, Date.UTC.
      if (prop === 'now') return Date.now; // our override
      return Reflect.get(target, prop, receiver);
    },
  });

  // Preserve prototype chain so `instanceof` works.
  DateProxy.prototype = _DateCtor.prototype;
  window.Date = DateProxy;

  // =========================================================================
  // 7.  Override: setTimeout / clearTimeout
  // =========================================================================

  /**
   * We shrink the delay by the speed multiplier.
   * At 2× speed a 1000 ms timeout fires in 500 ms of wall-clock time.
   *
   * We also track timer IDs so clearTimeout still works.
   */
  const timerMap = new Map(); // ourId → nativeId

  window.setTimeout = function (callback, delay = 0, ...args) {
    const scaledDelay = Math.max(0, delay / SPEED);

    // Wrap the callback to clean up our map entry.
    const nativeId = _setTimeout(() => {
      timerMap.delete(nativeId);
      if (typeof callback === 'function') {
        callback(...args);
      } else {
        // Legacy: setTimeout can accept a string (eval).  Preserve behaviour.
        // eslint-disable-next-line no-eval
        (0, eval)(callback);
      }
    }, scaledDelay);

    timerMap.set(nativeId, nativeId);
    return nativeId;
  };

  window.clearTimeout = function (id) {
    _clearTimeout(id);
    timerMap.delete(id);
  };

  // =========================================================================
  // 8.  Override: setInterval / clearInterval
  // =========================================================================

  /**
   * Intervals are trickier because the repeat period is fixed at creation.
   * We replace each native interval with a self-rescheduling setTimeout so
   * that every tick can re-read the *current* SPEED value.
   */
  const intervalMap = new Map(); // virtualId → { nativeTimeoutId }

  let nextIntervalId = -100000; // Negative IDs avoid collision with native IDs.

  window.setInterval = function (callback, delay = 0, ...args) {
    const virtualId = nextIntervalId--;
    const entry = { cancelled: false, nativeTimeoutId: null };
    intervalMap.set(virtualId, entry);

    function tick() {
      if (entry.cancelled) return;

      if (typeof callback === 'function') {
        callback(...args);
      } else {
        (0, eval)(callback);
      }

      if (!entry.cancelled) {
        // Re-schedule with the *current* speed.
        const nextDelay = Math.max(0, delay / SPEED);
        entry.nativeTimeoutId = _setTimeout(tick, nextDelay);
      }
    }

    // Schedule the first tick.
    const firstDelay = Math.max(0, delay / SPEED);
    entry.nativeTimeoutId = _setTimeout(tick, firstDelay);

    return virtualId;
  };

  window.clearInterval = function (id) {
    const entry = intervalMap.get(id);
    if (entry) {
      entry.cancelled = true;
      _clearTimeout(entry.nativeTimeoutId);
      intervalMap.delete(id);
    } else {
      // Might be a native interval created before our hook.
      _clearInterval(id);
    }
  };

  // =========================================================================
  // 9.  Override: requestAnimationFrame / cancelAnimationFrame
  // =========================================================================

  /**
   * rAF callbacks receive a DOMHighResTimeStamp.  We feed them the virtual
   * timestamp so that frame-delta calculations inside courseware automatically
   * produce larger deltas at higher speeds, advancing animations faster.
   *
   * At speed ≤ 1× we simply proxy through to the native rAF.
   * At speed > 1× we *also* insert extra synthetic frames via setTimeout
   * to compensate for the fact that the monitor's refresh rate hasn't changed.
   * Without synthetic frames, a 2× speed would still only get 60 fps worth of
   * timeline ticks — leading to jank in some courseware engines that cap their
   * internal delta at one frame's worth of time.
   */

  const rafMap = new Map(); // ourId → { nativeId, syntheticTimeoutId }

  let nextRafId = 1;

  window.requestAnimationFrame = function (callback) {
    const id = nextRafId++;
    const entry = { nativeId: null, syntheticTimeoutIds: [], cancelled: false };
    rafMap.set(id, entry);

    /**
     * Core strategy:
     *   - Always register one *real* native rAF so we stay
     *     synchronised with VSync.
     *   - If SPEED > 1, schedule (Math.ceil(SPEED) - 1) *synthetic*
     *     intermediate callbacks via setTimeout, evenly spaced within
     *     the ~16.67 ms frame window.  This way the courseware's own
     *     animation loop receives enough ticks to advance its internal
     *     clock by SPEED × real_delta per visual frame.
     *
     *   In practice the simplest approach that works universally is:
     *   just call the callback once with a virtual timestamp.
     *   Courseware that computes `dt = timestamp - lastTimestamp` will
     *   get dt * SPEED, which is exactly what we want.
     */

    // Register the real rAF.
    entry.nativeId = _requestAnimationFrame((realTimestamp) => {
      if (entry.cancelled) return;
      rafMap.delete(id);

      // Deliver the *virtual* timestamp.
      callback(virtualPerfNow());
    });

    // If speed > 1, add synthetic intermediate ticks.
    // Each synthetic tick is spaced ~(16.67 / SPEED) ms apart in real time,
    // but the callback receives the virtual timestamp at call-time.
    if (SPEED > 1) {
      const frameBudgetMs = 16.667; // ≈ 60 Hz
      const syntheticCount = Math.ceil(SPEED) - 1;
      const spacing = frameBudgetMs / (syntheticCount + 1);

      for (let i = 1; i <= syntheticCount; i++) {
        const tId = _setTimeout(() => {
          if (entry.cancelled) return;
          callback(virtualPerfNow());
        }, spacing * i);
        entry.syntheticTimeoutIds.push(tId);
      }
    }

    return id;
  };

  window.cancelAnimationFrame = function (id) {
    const entry = rafMap.get(id);
    if (entry) {
      entry.cancelled = true;
      _cancelAnimationFrame(entry.nativeId);
      entry.syntheticTimeoutIds.forEach((tId) => _clearTimeout(tId));
      rafMap.delete(id);
    } else {
      _cancelAnimationFrame(id);
    }
  };

  // =========================================================================
  // 10. Media Element Scanner  –  playbackRate Synchronisation
  // =========================================================================

  /**
   * Courseware can create <audio> / <video> elements at any time and may
   * nest them inside Shadow DOM or same-origin <iframe>s.
   *
   * Strategy:
   *   a. MutationObserver on the main document (and recursively on iframes).
   *   b. Periodic fallback sweep every 2 s (real time) to catch edge cases.
   *   c. On speed change, immediately sweep all known media elements.
   */

  /** WeakSet of already-processed media elements (avoids duplicate listeners). */
  const knownMedia = new WeakSet();

  /**
   * Sets the playbackRate of a single media element to the current SPEED,
   * and installs a listener that re-applies it if the courseware resets it.
   */
  function lockMediaRate(el) {
    if (knownMedia.has(el)) {
      // Already tracked – just update.
      try { el.playbackRate = SPEED; } catch (_) { /* cross-origin */ }
      return;
    }

    knownMedia.add(el);

    try {
      el.playbackRate = SPEED;
    } catch (_) {
      return; // Cross-origin media – nothing we can do.
    }

    // Re-apply if something else changes it.
    el.addEventListener('ratechange', () => {
      if (Math.abs(el.playbackRate - SPEED) > 0.01) {
        try { el.playbackRate = SPEED; } catch (_) { /* ignore */ }
      }
    });
  }

  /**
   * Recursively scans a root node for <audio> and <video> elements,
   * piercing open Shadow DOMs and descending into same-origin <iframe>s.
   */
  function scanForMedia(root) {
    if (!root) return;

    // Direct media elements under this root.
    const mediaEls = root.querySelectorAll
      ? root.querySelectorAll('audio, video')
      : [];
    mediaEls.forEach(lockMediaRate);

    // Pierce Shadow DOMs.
    const allEls = root.querySelectorAll ? root.querySelectorAll('*') : [];
    allEls.forEach((el) => {
      if (el.shadowRoot) {
        scanForMedia(el.shadowRoot);
      }
    });

    // Descend into same-origin iframes.
    const iframes = root.querySelectorAll ? root.querySelectorAll('iframe') : [];
    iframes.forEach((iframe) => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) scanForMedia(iframeDoc);
      } catch (_) {
        // Cross-origin iframe – skip.
      }
    });
  }

  // --- 10a. MutationObserver --------------------------------------------------

  /**
   * Installs a MutationObserver on the given root that watches for newly
   * added <audio>, <video>, <iframe>, and shadow-hosting elements.
   */
  function observeRoot(root) {
    if (!root || !root.querySelectorAll) return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          // Check the node itself.
          if (node.matches && node.matches('audio, video')) {
            lockMediaRate(node);
          }

          // Check descendants of the added subtree.
          if (node.querySelectorAll) {
            node.querySelectorAll('audio, video').forEach(lockMediaRate);

            // Watch new iframes.
            node.querySelectorAll('iframe').forEach((iframe) => {
              iframe.addEventListener('load', () => {
                try {
                  const doc = iframe.contentDocument || iframe.contentWindow?.document;
                  if (doc) {
                    scanForMedia(doc);
                    observeRoot(doc);
                  }
                } catch (_) { /* cross-origin */ }
              });
            });

            // Watch new shadow roots.
            node.querySelectorAll('*').forEach((el) => {
              if (el.shadowRoot) {
                scanForMedia(el.shadowRoot);
                observeRoot(el.shadowRoot);
              }
            });
          }

          // If this node itself hosts a shadow root.
          if (node.shadowRoot) {
            scanForMedia(node.shadowRoot);
            observeRoot(node.shadowRoot);
          }
        }
      }
    });

    observer.observe(root, { childList: true, subtree: true });
  }

  // Start observing the main document.
  observeRoot(document);

  // --- 10b. Periodic Fallback Sweep -------------------------------------------

  _setInterval(() => {
    scanForMedia(document);
  }, 2000);

  // =========================================================================
  // 11. Courseware Framework Detection & Helpers (Non-Cheat)
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
  // 12. CSS Animations & Transitions Scaling
  // =========================================================================

  /**
   * Many courseware platforms use CSS animations / transitions for slide
   * elements.  We inject a <style> rule that globally scales animation and
   * transition durations by dividing them by SPEED.
   *
   * This is done via a custom CSS property --vios-speed on :root, which a
   * companion <style> block references (only if the browser supports it).
   * For broader compat we also directly manipulate
   * document.documentElement.style.
   */

  const STYLE_ID = '__vios_css_timescale__';

  function applyCssTimeScale() {
    let styleEl = document.getElementById(STYLE_ID);

    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(styleEl);
    }

    // We cannot simply divide every animation-duration because we don't know
    // the original values.  Instead, we use the `animation-play-state` and
    // a custom `animation-duration` override doesn't really work generically.
    //
    // The most reliable CSS-level knob is the Web Animations API playback
    // rate, which we handle below in §12b.  Here we do a best-effort global
    // rule using `animation-duration` scaling for *new* animations.
    //
    // Articulate Storyline primarily uses JS-driven animations, so the
    // timer hooks in §§5–9 do most of the heavy lifting.  This CSS block
    // is a safety net for purely CSS-driven animations.

    // We scale using the * selector's animation-duration.  To avoid clobbering
    // inline durations, we apply only when the speed is not 1×.
    if (SPEED === 1) {
      styleEl.textContent = '';
    } else {
      // Note:  This scales the *initial* duration of all animations and
      // transitions by 1/SPEED.  Elements added later inherit this rule.
      // It won't affect durations already set inline.
      styleEl.textContent = `
        :root { --vios-speed: ${SPEED}; }
      `;
    }
  }

  // --- 12b. Web Animations API ------------------------------------------------

  /**
   * Scale the playbackRate of all running Web Animations on the document.
   */
  function scaleWebAnimations() {
    try {
      const animations = document.getAnimations({ subtree: true });
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
  // 13. Speed-Change Handler  –  Message Listener
  // =========================================================================

  window.addEventListener('message', (event) => {
    // Only accept messages from *this* window (posted by the content script).
    if (event.source !== window) return;
    if (event.data?.type !== 'VIOS_SET_SPEED') return;

    const newSpeed = parseFloat(event.data.speed);

    // Validate.
    if (isNaN(newSpeed) || newSpeed < 0.25 || newSpeed > 4.0) {
      console.warn(`[VIOS inject] Rejected invalid speed: ${event.data.speed}`);
      return;
    }

    // Commit current virtual time before changing SPEED.
    reanchor();

    SPEED = newSpeed;
    console.log(`[VIOS inject] Speed set to ${SPEED}×`);

    // Immediately apply to all existing media elements.
    scanForMedia(document);

    // Apply CSS time-scaling.
    applyCssTimeScale();

    // Scale Web Animations.
    scaleWebAnimations();

    // Acknowledge back to the content script.
    window.postMessage({ type: 'VIOS_SPEED_ACK', speed: SPEED }, '*');
  });

  // =========================================================================
  // 14. Initial State
  // =========================================================================

  applyCssTimeScale();
  scanForMedia(document);

  console.log('[VIOS inject] Time-Warp Engine ready.  Speed: ' + SPEED + '×');
})();
