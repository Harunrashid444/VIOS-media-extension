/**
 * ============================================================================
 * VIOS – Content Script & UI Bridge  (content.js)
 * ============================================================================
 *
 * THIS SCRIPT RUNS IN THE **ISOLATED** WORLD.
 *
 * Responsibilities:
 *   1. Render a floating speed-control overlay (top frame only).
 *   2. Bridge speed changes to the MAIN world engine via `window.postMessage`.
 *   3. Relay user-initiated changes through the service worker so that
 *      *every* frame in the tab — the courseware is usually in an iframe —
 *      applies the same multiplier.
 *
 * `inject.js` is no longer injected from here: it is declared in the manifest
 * as a `"world": "MAIN"` content script, which runs it before any page script
 * and sidesteps page CSP entirely.
 *
 * ============================================================================
 */

(function () {
  'use strict';

  // =========================================================================
  // 0.  Guard – Only Run Once Per Frame
  // =========================================================================

  if (window.__VIOS_CONTENT_LOADED__) return;
  window.__VIOS_CONTENT_LOADED__ = true;

  /**
   * The engine runs in every frame, but the overlay must not: courseware
   * pages routinely nest several same-origin iframes, and one panel per frame
   * meant a stack of overlays piled in the corner.
   */
  let isTopFrame = true;
  try { isTopFrame = window.top === window; } catch (_) { isTopFrame = false; }

  // =========================================================================
  // 1.  State
  // =========================================================================

  let currentSpeed = 1.0;
  const MIN_SPEED  = 0.25;
  const MAX_SPEED  = 4.0;
  const STEP       = 0.25;

  let ui = null; // Populated once the DOM is ready (top frame only).

  // =========================================================================
  // 2.  Helpers
  // =========================================================================

  function roundTo(value, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  function formatSpeed(speed) {
    return speed.toFixed(2) + '×';
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /**
   * `chrome.runtime.sendMessage` rejects asynchronously, so a bare try/catch
   * never sees the failure — it surfaces as an unchecked `lastError` console
   * error instead.  The callback swallows it.
   */
  function safeSendMessage(message, onReply) {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          // Extension reloaded, or the worker went away mid-flight.
          if (onReply) onReply(null);
          return;
        }
        if (onReply) onReply(response);
      });
    } catch (_) {
      // Extension context invalidated (page outlived the extension).
      if (onReply) onReply(null);
    }
  }

  // =========================================================================
  // 3.  Build the Floating UI Overlay
  // =========================================================================

  /**
   * The overlay is a fixed-position panel in the bottom-right corner with
   * a very high z-index.  It provides:
   *   – A speed display (e.g. "2.00×")
   *   – A "−" button  (decrease by 0.25)
   *   – A "+" button  (increase by 0.25)
   *   – A "Reset" button (back to 1.0×)
   *
   * All elements are created in the ISOLATED world DOM so page CSS cannot
   * interfere.  We use inline styles exclusively for encapsulation.
   */

  function buildOverlay() {
    // ----- Container -----
    const container = document.createElement('div');
    container.id = '__vios_overlay__';
    Object.assign(container.style, {
      position:       'fixed',
      bottom:         '20px',
      right:          '20px',
      zIndex:         '2147483647',          // max 32-bit int
      display:        'flex',
      alignItems:     'center',
      gap:            '0',
      fontFamily:     "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
      fontSize:       '13px',
      lineHeight:     '1',
      color:          '#E2E8F0',
      background:     'linear-gradient(135deg, rgba(30, 30, 46, 0.95), rgba(45, 40, 70, 0.95))',
      backdropFilter: 'blur(12px) saturate(1.4)',
      borderRadius:   '14px',
      boxShadow:      '0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(108,92,231,0.3), inset 0 1px 0 rgba(255,255,255,0.06)',
      padding:        '6px 6px',
      userSelect:     'none',
      touchAction:    'none',                // let us own pointer gestures
      cursor:         'default',
      transition:     'opacity 0.25s ease, transform 0.25s ease',
      opacity:        '0.92',
      transform:      'translateY(0)',
    });

    // ----- Drag State (declared early: the hover handlers consult it) -----
    let isDragging  = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    // Hover effects.  Suppressed mid-drag — the 2 px lift would otherwise
    // fight the pointer position and make the panel jitter under the cursor.
    container.addEventListener('mouseenter', () => {
      if (isDragging) return;
      container.style.opacity   = '1';
      container.style.transform = 'translateY(-2px)';
      container.style.boxShadow = '0 12px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(108,92,231,0.5), inset 0 1px 0 rgba(255,255,255,0.1)';
    });
    container.addEventListener('mouseleave', () => {
      if (isDragging) return;
      container.style.opacity   = '0.92';
      container.style.transform = 'translateY(0)';
      container.style.boxShadow = '0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(108,92,231,0.3), inset 0 1px 0 rgba(255,255,255,0.06)';
    });

    // ----- VIOS Badge -----
    const badge = document.createElement('div');
    Object.assign(badge.style, {
      padding:        '6px 10px',
      fontSize:       '10px',
      fontWeight:     '700',
      letterSpacing:  '1.5px',
      textTransform:  'uppercase',
      color:          'rgba(108, 92, 231, 0.9)',
      whiteSpace:     'nowrap',
      cursor:         'grab',
    });
    badge.textContent = 'VIOS';

    // ----- Divider -----
    function makeDivider() {
      const d = document.createElement('div');
      Object.assign(d.style, {
        width:       '1px',
        height:      '22px',
        background:  'rgba(255,255,255,0.08)',
        flexShrink:  '0',
      });
      return d;
    }

    // ----- Decrease Button -----
    const btnMinus = makeButton('−', () => {
      requestSpeed(Math.max(MIN_SPEED, roundTo(currentSpeed - STEP, 2)));
    });

    // ----- Speed Label -----
    const speedLabel = document.createElement('div');
    Object.assign(speedLabel.style, {
      minWidth:    '52px',
      textAlign:   'center',
      fontWeight:  '700',
      fontSize:    '15px',
      fontVariantNumeric: 'tabular-nums',
      letterSpacing:      '-0.3px',
      padding:     '6px 4px',
      color:       '#F8F8FF',
    });
    speedLabel.textContent = formatSpeed(currentSpeed);

    // ----- Increase Button -----
    const btnPlus = makeButton('+', () => {
      requestSpeed(Math.min(MAX_SPEED, roundTo(currentSpeed + STEP, 2)));
    });

    // ----- Reset Button -----
    const btnReset = makeButton('↺', () => {
      requestSpeed(1.0);
    }, true /* isReset */);

    // ----- Assemble -----
    container.appendChild(badge);
    container.appendChild(makeDivider());
    container.appendChild(btnMinus);
    container.appendChild(speedLabel);
    container.appendChild(btnPlus);
    container.appendChild(makeDivider());
    container.appendChild(btnReset);

    // ----- Drag Support -----
    //
    // Pointer events with pointer capture, rather than mousemove/mouseup on
    // `document`: a mouseup released outside the viewport (or over an iframe,
    // which is the normal case on courseware) never reached the old document
    // listener, leaving the panel welded to the cursor.

    function clampIntoView() {
      if (container.style.left === '' && container.style.top === '') return;
      const maxX = Math.max(0, window.innerWidth  - container.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - container.offsetHeight);
      container.style.left = `${clamp(parseFloat(container.style.left) || 0, 0, maxX)}px`;
      container.style.top  = `${clamp(parseFloat(container.style.top)  || 0, 0, maxY)}px`;
    }

    container.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Only drag from non-button areas.
      if (e.target.closest && e.target.closest('button')) return;

      const rect = container.getBoundingClientRect();
      isDragging  = true;
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;

      // Freeze the current on-screen box as explicit left/top and drop the
      // hover transform, so the pointer maths starts from what's visible.
      container.style.transition = 'none';
      container.style.transform  = 'translateY(0)';
      container.style.left       = `${rect.left}px`;
      container.style.top        = `${rect.top}px`;
      container.style.right      = 'auto';
      container.style.bottom     = 'auto';
      badge.style.cursor         = 'grabbing';

      try { container.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      e.preventDefault();
    });

    container.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      // Clamped so the panel can never be dragged off-screen and stranded.
      const maxX = Math.max(0, window.innerWidth  - container.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - container.offsetHeight);
      container.style.left = `${clamp(e.clientX - dragOffsetX, 0, maxX)}px`;
      container.style.top  = `${clamp(e.clientY - dragOffsetY, 0, maxY)}px`;
    });

    function endDrag(e) {
      if (!isDragging) return;
      isDragging = false;
      container.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      badge.style.cursor = 'grab';
      try { container.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    }

    container.addEventListener('pointerup', endDrag);
    container.addEventListener('pointercancel', endDrag);

    // A window resize can leave a dragged panel outside the viewport.
    window.addEventListener('resize', clampIntoView);

    // ----- Append to Page -----
    if (document.body) {
      document.body.appendChild(container);
    } else {
      // If body doesn't exist yet, wait for it.
      const obs = new MutationObserver(() => {
        if (document.body) {
          document.body.appendChild(container);
          obs.disconnect();
        }
      });
      obs.observe(document.documentElement, { childList: true });
    }

    // Return the speed label so we can update it later.
    return { speedLabel, container };
  }

  /**
   * Creates a styled button element.
   */
  function makeButton(label, onClick, isReset = false) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    Object.assign(btn.style, {
      all:            'unset',
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      width:          isReset ? '34px' : '30px',
      height:         '30px',
      borderRadius:   '8px',
      cursor:         'pointer',
      fontSize:       isReset ? '16px' : '18px',
      fontWeight:     '500',
      color:          isReset ? 'rgba(108,92,231,0.85)' : '#CBD5E1',
      transition:     'background 0.15s ease, color 0.15s ease, transform 0.1s ease',
      lineHeight:     '1',
      textAlign:      'center',
    });

    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(108, 92, 231, 0.15)';
      btn.style.color      = '#A78BFA';
      btn.style.transform  = 'scale(1.08)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'transparent';
      btn.style.color      = isReset ? 'rgba(108,92,231,0.85)' : '#CBD5E1';
      btn.style.transform  = 'scale(1)';
    });
    btn.addEventListener('mousedown', () => {
      btn.style.transform = 'scale(0.93)';
    });
    btn.addEventListener('mouseup', () => {
      btn.style.transform = 'scale(1.08)';
    });

    btn.addEventListener('click', onClick);
    return btn;
  }

  // =========================================================================
  // 4.  Speed Management
  // =========================================================================

  /**
   * A user-initiated change.  Applied locally at once for responsiveness, then
   * relayed via the service worker to every frame in the tab — the courseware
   * (and therefore its timers and its <audio>) almost always lives in an
   * iframe, so a change confined to this frame would do nothing visible.
   */
  function requestSpeed(newSpeed) {
    newSpeed = clamp(newSpeed, MIN_SPEED, MAX_SPEED);
    applySpeed(newSpeed);
    safeSendMessage({ type: 'VIOS_SET_SPEED', speed: newSpeed });
  }

  /**
   * Applies a speed to *this* frame only: updates state, the label (if this
   * frame owns the overlay) and the MAIN-world engine.
   */
  function applySpeed(newSpeed) {
    currentSpeed = clamp(newSpeed, MIN_SPEED, MAX_SPEED);

    // Update label.
    if (ui?.speedLabel) {
      ui.speedLabel.textContent = formatSpeed(currentSpeed);

      // Colour-code: green for slow, default for normal, orange/red for fast.
      if (currentSpeed < 1.0) {
        ui.speedLabel.style.color = '#6EE7B7'; // green
      } else if (currentSpeed === 1.0) {
        ui.speedLabel.style.color = '#F8F8FF'; // white
      } else if (currentSpeed <= 2.0) {
        ui.speedLabel.style.color = '#FCD34D'; // amber
      } else {
        ui.speedLabel.style.color = '#FB923C'; // orange
      }
    }

    // Hand it to the MAIN world engine in this frame.
    window.postMessage({ type: 'VIOS_SET_SPEED', speed: currentSpeed }, '*');
  }

  // =========================================================================
  // 5.  Messages From the MAIN World
  // =========================================================================

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data) return;

    if (data.type === 'VIOS_ENGINE_READY') {
      // The engine just came up.  Re-send the current speed: without this
      // handshake, a speed set before the engine finished initialising was
      // silently dropped.
      applySpeed(currentSpeed);
    } else if (data.type === 'VIOS_SPEED_ACK') {
      console.log(`[VIOS content] Engine confirmed speed: ${data.speed}×`);
    }
  });

  // =========================================================================
  // 6.  Messages From the Service Worker (tab-wide broadcast)
  // =========================================================================

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'VIOS_APPLY_SPEED' && typeof message.speed === 'number') {
      applySpeed(message.speed);
    }
  });

  // =========================================================================
  // 7.  Keyboard Shortcuts
  // =========================================================================

  /**
   * Alt + ]   →  Increase speed
   * Alt + [   →  Decrease speed
   * Alt + \   →  Reset to 1×
   *
   * Matched on `e.code`, not `e.key`: with Alt held, `e.key` is the *composed*
   * character, which on macOS and on non-US layouts is not "]" / "[" / "\" at
   * all — the shortcuts simply never fired there.  `e.code` is physical-key
   * based and layout independent.
   *
   * Registered in the capture phase so courseware that swallows keydown on
   * `document` can't eat them first.
   */

  document.addEventListener('keydown', (e) => {
    // Alt alone — Ctrl/Meta combinations belong to the page or the browser.
    if (!e.altKey || e.ctrlKey || e.metaKey) return;

    // Ignore if the user is typing.
    const target = e.target;
    const tag = (target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return;

    let next;
    switch (e.code) {
      case 'BracketRight': next = Math.min(MAX_SPEED, roundTo(currentSpeed + STEP, 2)); break;
      case 'BracketLeft':  next = Math.max(MIN_SPEED, roundTo(currentSpeed - STEP, 2)); break;
      case 'Backslash':    next = 1.0; break;
      default: return;
    }

    e.preventDefault();
    e.stopPropagation();
    requestSpeed(next);
  }, true);

  // =========================================================================
  // 8.  Initialise
  // =========================================================================

  function init() {
    if (isTopFrame) ui = buildOverlay();

    /**
     * Announce this frame and adopt the tab's speed.
     *
     * The top frame loading means a fresh page, so the worker resets the tab
     * to 1×.  A subframe instead *joins* at whatever the tab is already set
     * to — otherwise an iframe that loads a few slides in would silently drag
     * the whole tab back to real time.
     */
    safeSendMessage(
      { type: isTopFrame ? 'VIOS_TOP_FRAME_READY' : 'VIOS_FRAME_READY' },
      (response) => {
        applySpeed(typeof response?.speed === 'number' ? response.speed : 1.0);
      },
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  console.log('[VIOS content] Content script loaded.');
})();
