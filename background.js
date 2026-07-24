/**
 * ============================================================================
 * VIOS – Service Worker (background.js)
 * ============================================================================
 *
 * Lightweight Manifest V3 service worker responsible for:
 *   1. Extension lifecycle management (install, update).
 *   2. Responding to messages from content scripts if cross-tab state
 *      synchronization is ever needed.
 *   3. Providing a badge indicator showing the current speed multiplier.
 *
 * This file intentionally remains thin.  All heavy lifting happens in
 * inject.js (MAIN world) and content.js (ISOLATED world).
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// 1.  Lifecycle Events
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[VIOS background] Extension installed.');
  } else if (details.reason === 'update') {
    console.log(`[VIOS background] Extension updated to v${chrome.runtime.getManifest().version}.`);
  }
});

// ---------------------------------------------------------------------------
// 2.  Message Listener  –  Badge Updates from Content Scripts
// ---------------------------------------------------------------------------

/**
 * Content scripts can send { type: 'VIOS_SET_BADGE', speed: 2.0 } to update
 * the extension badge so the user can see the active multiplier at a glance.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'VIOS_SET_BADGE' && sender.tab?.id != null) {
    const label = message.speed === 1 ? '' : `${message.speed}x`;

    chrome.action.setBadgeText({ text: label, tabId: sender.tab.id });
    chrome.action.setBadgeBackgroundColor({ color: '#6C5CE7', tabId: sender.tab.id });

    sendResponse({ ok: true });
  }
});

// ---------------------------------------------------------------------------
// 3.  Keep-Alive Heartbeat (optional safety net for MV3 idle termination)
// ---------------------------------------------------------------------------

/**
 * MV3 service workers are terminated after ~30 s of inactivity.  For this
 * extension that is perfectly fine — all state lives in the page context.
 * We log the wake-up just for debugging convenience.
 */
self.addEventListener('activate', () => {
  console.log('[VIOS background] Service worker activated.');
});
