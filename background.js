/**
 * ShiponLens — service worker
 *
 * Responsibilities:
 *  - Start the capture flow from the toolbar button or the keyboard shortcut.
 *  - Inject the on-demand selection overlay.
 *  - Capture the visible tab and crop the selected rectangle using the real
 *    screenshot/viewport ratio (so devicePixelRatio and browser zoom are correct).
 *  - Manage the offscreen document that owns the Tesseract.js worker.
 *  - Forward OCR progress and results back to the tab.
 *
 * No captured pixels ever leave the machine: everything below is local.
 */

'use strict';

importScripts(chrome.runtime.getURL('lib/links.js'));

const Links = globalThis.PixelOcrLinks;

const OVERLAY_FILES = ['lib/links.js', 'content/overlay.js'];
const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);

const DEFAULT_TITLE = 'Select an area to OCR (Alt+Shift+S)';
const BADGE_CLEAR_MS = 6000;
const CAPTURE_TIMEOUT_MS = 15000;
const OCR_TIMEOUT_MS = 130000;
const MIN_SELECTION_PX = 5;

/** @type {Map<string, number>} requestId -> tabId */
const activeOcrRequests = new Map();
/** @type {Map<number, number>} tabId -> timeout id for the error badge */
const badgeTimers = new Map();

let creatingOffscreen = null;
let offscreenCloseTimer = null;

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

chrome.action.onClicked.addListener((tab) => {
  void startCapture(tab);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'capture-region') return;
  void startCaptureFromActiveTab();
});

chrome.runtime.onStartup.addListener(() => {
  void clearAllBadges();
});

chrome.runtime.onInstalled.addListener(() => {
  void clearAllBadges();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearBadgeTimer(tabId);
});

/* ------------------------------------------------------------------ */
/* Starting a capture                                                  */
/* ------------------------------------------------------------------ */

async function startCaptureFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error('No active tab found.');
    await startCapture(tab);
  } catch (err) {
    console.warn('[ShiponLens] Could not start capture:', err);
  }
}

/**
 * Injects the overlay. The overlay script itself restarts cleanly if it is
 * already present (this is how "trigger while active" is handled).
 */
async function startCapture(tab) {
  if (!tab || typeof tab.id !== 'number') return;
  const tabId = tab.id;

  await clearBadge(tabId);

  if (isRestrictedUrl(tab.url)) {
    await showErrorBadge(tabId, restrictedPageMessage(tab.url));
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: OVERLAY_FILES,
    });
  } catch (err) {
    console.warn('[ShiponLens] Injection failed:', err);
    await showErrorBadge(tabId, injectionErrorMessage(err));
  }
}

function isRestrictedUrl(url) {
  if (!url) return false;
  return (
    /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):/i.test(url) ||
    /^https:\/\/chromewebstore\.google\.com\//i.test(url) ||
    /^https:\/\/chrome\.google\.com\/webstore\//i.test(url)
  );
}

function restrictedPageMessage(url) {
  if (/^chrome-extension:/i.test(url || '')) {
    return 'Chrome does not allow extensions to run on other extensions’ pages.';
  }
  if (/chromewebstore|chrome\.google\.com\/webstore/i.test(url || '')) {
    return 'Chrome does not allow extensions to run on the Chrome Web Store.';
  }
  if (/^chrome:\/\//i.test(url || '')) {
    return 'Chrome does not allow extensions to run on chrome:// pages.';
  }
  return 'This page does not allow extensions to run on it.';
}

function injectionErrorMessage(err) {
  const raw = err && err.message ? err.message : String(err);
  if (/file:\/\//i.test(raw)) {
    return 'To use ShiponLens on local files, enable “Allow access to file URLs” on chrome://extensions.';
  }
  if (/extensions gallery|chrome web store/i.test(raw)) {
    return 'Chrome does not allow extensions to run on the Chrome Web Store.';
  }
  if (/cannot access|missing host permission|not allowed/i.test(raw)) {
    return 'This page does not allow extensions to run on it.';
  }
  return `Could not start on this page. ${raw}`;
}

/* ------------------------------------------------------------------ */
/* Tab badge messages (used when injection is impossible)              */
/* ------------------------------------------------------------------ */

async function showErrorBadge(tabId, message) {
  try {
    clearBadgeTimer(tabId);
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#c62828' });
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setTitle({ tabId, title: `ShiponLens: ${message}` });
    const timer = setTimeout(() => {
      badgeTimers.delete(tabId);
      void clearBadge(tabId, true);
    }, BADGE_CLEAR_MS);
    badgeTimers.set(tabId, timer);
  } catch (err) {
    // Badge APIs can fail on some restricted tabs; nothing else to do.
    console.warn('[ShiponLens] Could not show badge:', err);
  }
}

async function clearBadge(tabId, resetTitle = false) {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
    if (resetTitle) {
      await chrome.action.setTitle({ tabId, title: DEFAULT_TITLE });
    }
  } catch {
    // Ignore: tab may be gone.
  }
}

async function clearAllBadges() {
  for (const tabId of badgeTimers.keys()) {
    clearBadgeTimer(tabId);
    await clearBadge(tabId, true);
  }
}

function clearBadgeTimer(tabId) {
  const timer = badgeTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    badgeTimers.delete(tabId);
  }
}

/* ------------------------------------------------------------------ */
/* Message handling                                                    */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  if (message.target === 'background' && message.type === 'OFFSCREEN_IDLE') {
    if (activeOcrRequests.size === 0) void closeOffscreen();
    return undefined;
  }

  if (message.target === 'background' && message.type === 'OCR_STATUS') {
    forwardStatus(message);
    return undefined;
  }

  if (message.type === 'PIXEL_OCR_CAPTURE') {
    handleCaptureRequest(sender, message)
      .then(sendResponse)
      .catch((err) => {
        console.warn('[ShiponLens] Capture failed:', err);
        sendResponse({ ok: false, error: friendlyError(err) });
      });
    return true;
  }

  if (message.type === 'PIXEL_OCR_REOCR') {
    handleReocrRequest(sender, message)
      .then(sendResponse)
      .catch((err) => {
        console.warn('[ShiponLens] Re-OCR failed:', err);
        sendResponse({ ok: false, error: friendlyError(err) });
      });
    return true;
  }

  if (message.type === 'PIXEL_OCR_OPEN_URL') {
    handleOpenLookup(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: friendlyError(err) }));
    return true;
  }

  if (message.type === 'PIXEL_OCR_OPEN_OPTIONS') {
    chrome.runtime
      .openOptionsPage()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
    return true;
  }

  return undefined;
});

function forwardStatus(message) {
  const tabId = activeOcrRequests.get(message.requestId);
  if (typeof tabId !== 'number') return;
  chrome.tabs
    .sendMessage(tabId, {
      channel: 'pixel-ocr',
      type: 'STATUS',
      requestId: message.requestId,
      state: message.state,
      progress: message.progress,
      detail: message.detail,
    })
    .catch(() => {
      // The overlay may have been cancelled or the tab closed.
    });
}

/* ------------------------------------------------------------------ */
/* Capture + crop                                                      */
/* ------------------------------------------------------------------ */

async function handleCaptureRequest(sender, message) {
  const tabId = sender.tab && sender.tab.id;
  if (typeof tabId !== 'number') throw new Error('No tab information for this capture.');

  const requestId = crypto.randomUUID();
  activeOcrRequests.set(requestId, tabId);
  scheduleOffscreenClose(true);

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      throw new Error('This tab is not active. Click the page, then try again.');
    }

    const rect = normalizeRect(message.rect);
    const viewport = normalizeViewport(message.viewport);
    if (!rect) throw new Error('The selection was invalid. Please try again.');
    if (rect.w < MIN_SELECTION_PX || rect.h < MIN_SELECTION_PX) {
      throw new Error('Selection is too small. Drag a larger area.');
    }

    const screenshot = await withTimeout(
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }),
      CAPTURE_TIMEOUT_MS,
      'Taking the screenshot timed out. Click the page and try again.',
    );

    const captureId = crypto.randomUUID();

    // The screenshot is safely in memory; the overlay may show the panel now.
    chrome.tabs
      .sendMessage(tabId, {
        channel: 'pixel-ocr',
        type: 'CAPTURED',
        requestId,
        captureId,
      })
      .catch(() => {});

    const crop = await cropScreenshot(screenshot, rect, viewport, message.dpr);

    const result = await withTimeout(
      sendToOffscreen({
        type: 'OCR_RUN',
        requestId,
        captureId,
        image: crop.dataUrl,
        numbersOnly: Boolean(message.numbersOnly),
      }),
      OCR_TIMEOUT_MS,
      'OCR took too long. Please try again.',
    );

    if (!result || !result.ok) {
      throw new Error((result && result.error) || 'OCR failed.');
    }

    return {
      ok: true,
      captureId,
      requestId,
      text: result.text,
      empty: Boolean(result.empty),
      psm: result.psm,
      numbersOnly: Boolean(result.numbersOnly),
    };
  } finally {
    activeOcrRequests.delete(requestId);
    scheduleOffscreenClose(false);
  }
}

async function handleReocrRequest(sender, message) {
  const tabId = sender.tab && sender.tab.id;
  if (typeof tabId !== 'number') throw new Error('No tab information for this re-run.');

  const requestId = crypto.randomUUID();
  activeOcrRequests.set(requestId, tabId);
  scheduleOffscreenClose(true);

  try {
    if (!message.captureId || typeof message.captureId !== 'string') {
      throw new Error('The captured image is no longer available. Select the area again.');
    }

    const result = await withTimeout(
      sendToOffscreen({
        type: 'OCR_RERUN',
        requestId,
        captureId: message.captureId,
        numbersOnly: Boolean(message.numbersOnly),
      }),
      OCR_TIMEOUT_MS,
      'OCR took too long. Please try again.',
    );

    if (!result || !result.ok) {
      throw new Error((result && result.error) || 'OCR failed.');
    }

    return {
      ok: true,
      captureId: message.captureId,
      requestId,
      text: result.text,
      empty: Boolean(result.empty),
      psm: result.psm,
      numbersOnly: Boolean(result.numbersOnly),
    };
  } finally {
    activeOcrRequests.delete(requestId);
    scheduleOffscreenClose(false);
  }
}

/**
 * Builds a lookup URL from the *saved* template and the edited value, then
 * opens it. The panel never sends a URL: only the stored template can decide
 * the destination, and OCR text is only a value.
 */
async function handleOpenLookup(message) {
  const typeId = message && typeof message.typeId === 'string' ? message.typeId : '';
  const text = message && typeof message.text === 'string' ? message.text : '';
  if (!typeId) throw new Error('Choose a lookup type first.');
  if (!text.trim()) throw new Error('Enter a value to look up.');

  const types = await Links.loadTypes();
  const type = types.find((item) => item.id === typeId);
  if (!type) {
    throw new Error('That lookup type no longer exists. Choose another type or update Options.');
  }

  const cleaned = Links.cleanValue(text, type.cleaning);
  if (!cleaned.value) {
    throw new Error('There is nothing to look up after cleaning this value.');
  }

  const url = Links.buildUrl(type.template, cleaned.value);
  if (!url) {
    throw new Error('This type does not have a valid link template. Set it in Options.');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The lookup URL was not valid.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http(s) lookup links can be opened.');
  }

  await chrome.tabs.create({ url: parsed.href, active: true });
  void Links.saveLastTypeId(type.id);
  return {
    ok: true,
    url: parsed.href,
    usedFirstValue: cleaned.usedFirstValue,
    invalidPhone: cleaned.invalidPhone,
  };
}

function normalizeRect(value) {
  if (!value || typeof value !== 'object') return null;
  const nums = [value.x, value.y, value.w, value.h].map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = nums;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function normalizeViewport(value) {
  if (!value || typeof value !== 'object') return null;
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Could not read the page viewport size.');
  }
  return { width, height };
}

/**
 * Crops the screenshot to the selection.
 *
 * The screenshot's pixel size is not always exactly `viewport * devicePixelRatio`
 * (fractional browser zoom and display scaling round differently), so we derive
 * the true scale from the screenshot itself. This is the robust equivalent of
 * multiplying by devicePixelRatio and is what makes 125%/150% scaling and
 * 80%/150% browser zoom line up.
 */
async function cropScreenshot(dataUrl, rect, viewport, dprHint) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  try {
    const imageWidth = bitmap.width;
    const imageHeight = bitmap.height;
    if (!imageWidth || !imageHeight) throw new Error('The screenshot was empty.');

    let scaleX = imageWidth / viewport.width;
    let scaleY = imageHeight / viewport.height;
    const dpr = Number(dprHint);
    if (!Number.isFinite(scaleX) || scaleX <= 0) scaleX = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    if (!Number.isFinite(scaleY) || scaleY <= 0) scaleY = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;

    // Use floor/ceil so a fractional boundary never clips a row or column.
    const sx = clamp(Math.floor(rect.x * scaleX), 0, imageWidth - 1);
    const sy = clamp(Math.floor(rect.y * scaleY), 0, imageHeight - 1);
    const ex = clamp(Math.ceil((rect.x + rect.w) * scaleX), sx + 1, imageWidth);
    const ey = clamp(Math.ceil((rect.y + rect.h) * scaleY), sy + 1, imageHeight);
    const outWidth = ex - sx;
    const outHeight = ey - sy;

    if (outWidth < 3 || outHeight < 3) {
      throw new Error('The selected area is too small. Drag a larger area.');
    }

    const canvas = new OffscreenCanvas(outWidth, outHeight);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not prepare the image for OCR.');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, sx, sy, outWidth, outHeight, 0, 0, outWidth, outHeight);

    const cropBlob = await canvas.convertToBlob({ type: 'image/png' });
    const cropDataUrl = await blobToDataUrl(cropBlob);

    return { dataUrl: cropDataUrl };
  } finally {
    bitmap.close();
  }
}

/* ------------------------------------------------------------------ */
/* Offscreen document management                                       */
/* ------------------------------------------------------------------ */

async function offscreenExists() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await offscreenExists()) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['WORKERS'],
        justification:
          'Runs the bundled Tesseract.js OCR web worker and image preprocessing locally. No data leaves the device.',
      })
      .catch((err) => {
        // A concurrent create can win the race; that is fine.
        if (!/single offscreen document/i.test(String(err && err.message))) throw err;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function sendToOffscreen(payload) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await ensureOffscreen();
      const response = await chrome.runtime.sendMessage({ target: 'offscreen', ...payload });
      if (response === undefined) throw new Error('The OCR engine did not respond.');
      return response;
    } catch (err) {
      lastError = err;
      // The document may still be loading its scripts; retry briefly.
      await delay(150 + attempt * 150);
    }
  }
  throw lastError || new Error('Could not reach the OCR engine.');
}

function scheduleOffscreenClose(immediate) {
  if (offscreenCloseTimer) {
    clearTimeout(offscreenCloseTimer);
    offscreenCloseTimer = null;
  }
  if (immediate) return;
  // Keep the worker (and its loaded language model) warm for a while, then
  // release its memory. The next capture shows "Loading OCR engine…" again.
  offscreenCloseTimer = setTimeout(() => {
    offscreenCloseTimer = null;
    if (activeOcrRequests.size === 0) void closeOffscreen();
  }, 5 * 60 * 1000);
}

async function closeOffscreen() {
  if (activeOcrRequests.size > 0) return;
  try {
    if (await offscreenExists()) {
      await chrome.offscreen.closeDocument();
    }
  } catch (err) {
    console.warn('[ShiponLens] Could not close the offscreen document:', err);
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

function friendlyError(err) {
  const raw = err && err.message ? err.message : String(err);
  if (/cannot access|chrome:\/\/|extensions gallery|web store/i.test(raw)) {
    return 'This page does not allow extensions to run on it.';
  }
  if (/not active/i.test(raw)) {
    return 'This tab is not active. Click the page, then try again.';
  }
  if (/too small/i.test(raw)) return raw;
  if (/timed out|too long/i.test(raw)) return raw;
  if (/offscreen|ocr engine/i.test(raw)) {
    return 'The OCR engine could not start. Please try again.';
  }
  return raw.length > 240 ? `${raw.slice(0, 237)}…` : raw;
}
