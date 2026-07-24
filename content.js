/**
 * ============================================================================
 * VIOS – Content Script & UI Bridge  (content.js)
 * ============================================================================
 *
 * THIS SCRIPT RUNS IN THE **ISOLATED** WORLD.
 *
 * Responsibilities:
 *   1. Inject `inject.js` into the MAIN world so it can hook native APIs.
 *   2. Render a floating speed-control overlay (always-on-top).
 *   3. Bridge user interactions from the overlay to the MAIN world engine
 *      via `window.postMessage`.
 *   4. Forward the active speed to the background service worker so it can
 *      update the extension badge.
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

  // =========================================================================
  // 1.  Inject `inject.js` into the MAIN World
  // =========================================================================

  /**
   * Manifest V3 allows `world: "MAIN"` in `content_scripts`, but that
   * requires the script to be declared statically.  For maximum flexibility
   * (and because some browsers / versions lag behind), we inject manually
   * via a <script> tag whose `src` points to a web_accessible_resource.
   *
   * This guarantees inject.js executes in the PAGE's JS context and can
   * override `window.setTimeout`, etc.
   */

  function injectMainWorldScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.dataset.vios = 'injected'; // marker for debugging
    (document.head || document.documentElement).appendChild(script);

    // Clean up the <script> tag once loaded (optional, keeps DOM tidy).
    script.addEventListener('load', () => script.remove());
    script.addEventListener('error', (err) => {
      console.error('[VIOS content] Failed to inject time-warp script:', err);
    });
  }

  injectMainWorldScript();

  // =========================================================================
  // 2.  State
  // =========================================================================

  let currentSpeed = 1.0;
  const MIN_SPEED  = 0.25;
  const MAX_SPEED  = 4.0;
  const STEP       = 0.25;

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
      cursor:         'default',
      transition:     'opacity 0.25s ease, transform 0.25s ease',
      opacity:        '0.92',
      transform:      'translateY(0)',
    });

    // Hover effects.
    container.addEventListener('mouseenter', () => {
      container.style.opacity   = '1';
      container.style.transform = 'translateY(-2px)';
      container.style.boxShadow = '0 12px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(108,92,231,0.5), inset 0 1px 0 rgba(255,255,255,0.1)';
    });
    container.addEventListener('mouseleave', () => {
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
      setSpeed(Math.max(MIN_SPEED, roundTo(currentSpeed - STEP, 2)));
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
      setSpeed(Math.min(MAX_SPEED, roundTo(currentSpeed + STEP, 2)));
    });

    // ----- Reset Button -----
    const btnReset = makeButton('↺', () => {
      setSpeed(1.0);
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
    let isDragging  = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    container.addEventListener('mousedown', (e) => {
      // Only drag from non-button areas.
      if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
      isDragging = true;
      const rect = container.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      container.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      container.style.left   = `${e.clientX - dragOffsetX}px`;
      container.style.top    = `${e.clientY - dragOffsetY}px`;
      container.style.right  = 'auto';
      container.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        container.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      }
    });

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
  // 4.  Helpers
  // =========================================================================

  function roundTo(value, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  function formatSpeed(speed) {
    return speed.toFixed(2) + '×';
  }

  // =========================================================================
  // 5.  Speed Management
  // =========================================================================

  let ui = null; // Populated once the DOM is ready.

  /**
   * Sets the speed:
   *   1. Updates local state.
   *   2. Updates the UI label.
   *   3. Posts a message to the MAIN world (inject.js).
   *   4. Notifies the background service worker to update the badge.
   */
  function setSpeed(newSpeed) {
    currentSpeed = newSpeed;

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

    // Broadcast to MAIN world.
    window.postMessage({ type: 'VIOS_SET_SPEED', speed: currentSpeed }, '*');

    // Update badge.
    try {
      chrome.runtime.sendMessage({ type: 'VIOS_SET_BADGE', speed: currentSpeed });
    } catch (_) {
      // Extension context may have been invalidated (page outlived extension).
    }

    console.log(`[VIOS content] Speed → ${currentSpeed}×`);
  }

  // =========================================================================
  // 6.  Listen for Acknowledgements from the MAIN World
  // =========================================================================

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data?.type === 'VIOS_SPEED_ACK') {
      console.log(`[VIOS content] Engine confirmed speed: ${event.data.speed}×`);
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
   * These shortcuts are deliberately obscure to avoid conflicts with
   * courseware hotkeys.
   */

  document.addEventListener('keydown', (e) => {
    // Ignore if the user is typing in an input.
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

    if (!e.altKey) return;

    if (e.key === ']') {
      e.preventDefault();
      setSpeed(Math.min(MAX_SPEED, roundTo(currentSpeed + STEP, 2)));
    } else if (e.key === '[') {
      e.preventDefault();
      setSpeed(Math.max(MIN_SPEED, roundTo(currentSpeed - STEP, 2)));
    } else if (e.key === '\\') {
      e.preventDefault();
      setSpeed(1.0);
    }
  });

  // =========================================================================
  // 8.  Initialise UI When DOM Is Ready
  // =========================================================================

  function init() {
    ui = buildOverlay();
    // Broadcast the initial speed so inject.js is aware (in case it loaded
    // before the content script, which shouldn't happen but is good practice).
    setSpeed(currentSpeed);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  console.log('[VIOS content] Content script loaded.');
})();
