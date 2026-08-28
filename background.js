/**
 * ============================================================================
 * VIOS – Service Worker (background.js)
 * ============================================================================
 *
 * Lightweight Manifest V3 service worker responsible for:
 *   1. Extension lifecycle management (install, update).
 *   2. Holding the authoritative speed for each tab and broadcasting changes
 *      to *every* frame in that tab.
 *   3. Providing a badge indicator showing the current speed multiplier.
 *
 * Why the worker owns the speed: courseware runs inside iframes, so the frame
 * that hosts the overlay is almost never the frame that hosts the timers and
 * the <audio>.  Routing changes through here is what keeps them in step — and
 * it gives a late-loading iframe somewhere to ask what speed it should join at.
 *
 * All the heavy lifting still happens in inject.js (MAIN world) and
 * content.js (ISOLATED world).
 * ============================================================================
 */

const MIN_SPEED = 0.25;
const MAX_SPEED = 4.0;

// ---------------------------------------------------------------------------
// 1.  Per-Tab Speed Store
// ---------------------------------------------------------------------------

/**
 * In-memory cache backed by `chrome.storage.session`.  The cache answers the
 * common case synchronously; the session store survives the ~30 s idle
 * termination of the service worker, which the cache alone would not.
 */
const speedCache = new Map(); // tabId → speed

const storageKey = (tabId) => `vios_speed_${tabId}`;

async function readSpeed(tabId) {
  if (speedCache.has(tabId)) return speedCache.get(tabId);
  try {
    const key = storageKey(tabId);
    const result = await chrome.storage.session.get(key);
    const stored = result[key];
    const speed = typeof stored === 'number' ? stored : 1.0;
    speedCache.set(tabId, speed);
    return speed;
  } catch (_) {
    return 1.0;
  }
}

function writeSpeed(tabId, speed) {
  speedCache.set(tabId, speed);
  chrome.storage.session
    .set({ [storageKey(tabId)]: speed })
    .catch(() => { /* session storage unavailable – cache still works */ });
}

function forgetTab(tabId) {
  speedCache.delete(tabId);
  chrome.storage.session.remove(storageKey(tabId)).catch(() => {});
}

function normaliseSpeed(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n) || n < MIN_SPEED || n > MAX_SPEED) return null;
  return n;
}

// ---------------------------------------------------------------------------
// 2.  Badge
// ---------------------------------------------------------------------------

/**
 * The badge fits roughly four characters, so `2` renders as "2x" while `1.25`
 * drops the suffix rather than being truncated to a misleading "1.25x".
 */
function badgeLabel(speed) {
  if (speed === 1) return '';
  return Number.isInteger(speed) ? `${speed}x` : `${speed}`;
}

function updateBadge(tabId, speed) {
  // A tab can disappear between the message and this call.
  chrome.action.setBadgeText({ text: badgeLabel(speed), tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#6C5CE7', tabId }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 3.  Lifecycle Events
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[VIOS background] Extension installed.');
  } else if (details.reason === 'update') {
    console.log(`[VIOS background] Extension updated to v${chrome.runtime.getManifest().version}.`);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

// ---------------------------------------------------------------------------
// 4.  Message Router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId == null || !message?.type) return false;

  switch (message.type) {
    /**
     * A user-initiated change from any frame's overlay or keyboard shortcut.
     * Store it, badge it, and push it to every frame in the tab (omitting
     * `frameId` makes `tabs.sendMessage` fan out to all of them).
     */
    case 'VIOS_SET_SPEED': {
      const speed = normaliseSpeed(message.speed);
      if (speed === null) {
        sendResponse({ ok: false });
        return false;
      }
      writeSpeed(tabId, speed);
      updateBadge(tabId, speed);
      chrome.tabs.sendMessage(tabId, { type: 'VIOS_APPLY_SPEED', speed }, () => {
        void chrome.runtime.lastError; // frames without a listener are fine
      });
      sendResponse({ ok: true, speed });
      return false;
    }

    /**
     * The top-level document loaded: this is a brand-new page, so the tab goes
     * back to real time.  (Doing the reset here, rather than in every frame,
     * is what stops a late-loading iframe from yanking the tab back to 1×.)
     */
    case 'VIOS_TOP_FRAME_READY': {
      writeSpeed(tabId, 1.0);
      updateBadge(tabId, 1.0);
      // Also push the reset out: a subframe can announce itself before the
      // top frame does, in which case it will have joined at the *previous*
      // page's speed and needs pulling back to real time.
      chrome.tabs.sendMessage(tabId, { type: 'VIOS_APPLY_SPEED', speed: 1.0 }, () => {
        void chrome.runtime.lastError;
      });
      sendResponse({ ok: true, speed: 1.0 });
      return false;
    }

    /** A subframe came up and needs to join the tab at the current speed. */
    case 'VIOS_FRAME_READY': {
      readSpeed(tabId).then((speed) => sendResponse({ ok: true, speed }));
      return true; // response is async
    }

    default:
      return false;
  }
});
