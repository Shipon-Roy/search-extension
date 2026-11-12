/**
 * ShiponLens — offscreen document
 *
 * Runs the bundled Tesseract.js worker (so the host page's CSP cannot block
 * it), preprocesses the cropped pixels, and returns recognized text.
 *
 * The worker is created once and reused. The last two preprocessed images are
 * kept in memory so "Numbers only" can re-run without re-capturing the screen.
 */

'use strict';

const TESSERACT_BASE = chrome.runtime.getURL('lib/tesseract');
const WORKER_PATH = `${TESSERACT_BASE}/worker.min.js`;
const CORE_PATH = `${TESSERACT_BASE}/tesseract-core-simd-lstm.wasm.js`;
const LANG_PATH = TESSERACT_BASE;

const IDLE_CLOSE_MS = 5 * 60 * 1000;
const FIRST_RUN_TIMEOUT_MS = 120000;
const OCR_TIMEOUT_MS = 60000;
const NUMBERS_WHITELIST = '0123456789.,-+%$/:';

/** @type {import('tesseract.js').Worker | null} */
let worker = null;
let workerLoading = null;
let currentRequestId = null;

/** @type {Map<string, {canvas: HTMLCanvasElement, width: number, height: number, psm: string}>} */
const imageCache = new Map();
const IMAGE_CACHE_LIMIT = 2;

let queue = Promise.resolve();
let idleTimer = null;

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;

  if (message.type === 'OCR_RUN' || message.type === 'OCR_RERUN') {
    enqueue(() => handleOcr(message))
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error('[ShiponLens] OCR failed:', err);
        sendResponse({ ok: false, error: friendlyError(err) });
      });
    return true;
  }

  if (message.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

function sendStatus(state, progress, detail) {
  if (!currentRequestId) return;
  try {
    chrome.runtime.sendMessage(
      {
        target: 'background',
        type: 'OCR_STATUS',
        requestId: currentRequestId,
        state,
        progress,
        detail,
      },
      () => void chrome.runtime.lastError,
    );
  } catch {
    // The service worker may be asleep; status is best-effort.
  }
}

async function sendIdleNotice() {
  try {
    await chrome.runtime.sendMessage(
      { target: 'background', type: 'OFFSCREEN_IDLE' },
      () => void chrome.runtime.lastError,
    );
  } catch {
    // Ignore.
  }
}

/* ------------------------------------------------------------------ */
/* OCR job                                                             */
/* ------------------------------------------------------------------ */

async function handleOcr(message) {
  clearIdleTimer();
  currentRequestId = message.requestId || null;
  const numbersOnly = Boolean(message.numbersOnly);

  try {
    let entry;

    if (message.type === 'OCR_RERUN') {
      entry = imageCache.get(message.captureId);
      if (!entry) {
        throw new Error(
          'The captured image is no longer available. Select the area again to re-run OCR.',
        );
      }
      // Refresh LRU position.
      imageCache.delete(message.captureId);
      imageCache.set(message.captureId, entry);
      sendStatus('preparing', 0, 'cached image');
    } else {
      sendStatus('preparing', 0, 'preprocessing');
      const processed = await preprocess(message.image);
      entry = {
        canvas: processed.canvas,
        width: processed.canvas.width,
        height: processed.canvas.height,
        psm: pickPageSegMode(processed.canvas.width, processed.canvas.height, processed.bands),
      };
      rememberImage(message.captureId, entry);
    }

    const firstRun = !worker;
    if (firstRun) sendStatus('loading-engine', 0, 'creating worker');

    const activeWorker = await withTimeout(
      getWorker(),
      FIRST_RUN_TIMEOUT_MS,
      'Loading the OCR engine timed out. Please try again.',
    );
    sendStatus('recognizing', 0, `psm ${entry.psm}`);

    const { data } = await withTimeout(
      recognize(activeWorker, entry.canvas, entry.psm, numbersOnly),
      OCR_TIMEOUT_MS,
      'OCR timed out. The engine may be low on memory; please try again.',
    );

    const text = cleanText(data && typeof data.text === 'string' ? data.text : '');
    return {
      ok: true,
      text,
      empty: text.length === 0,
      psm: entry.psm,
      numbersOnly,
    };
  } catch (err) {
    if (isTimeoutError(err)) {
      // A wedged worker cannot be trusted; let the next attempt start fresh.
      await resetWorker();
    }
    throw err;
  } finally {
    currentRequestId = null;
    scheduleIdleClose();
  }
}

async function recognize(activeWorker, canvas, psm, numbersOnly) {
  await activeWorker.setParameters({
    tessedit_pageseg_mode: psm,
    tessedit_char_whitelist: numbersOnly ? NUMBERS_WHITELIST : '',
    preserve_interword_spaces: '1',
  });

  const { data } = await activeWorker.recognize(canvas, {}, { text: true });
  return { data };
}

/* ------------------------------------------------------------------ */
/* Worker lifecycle                                                    */
/* ------------------------------------------------------------------ */

async function getWorker() {
  if (worker) return worker;
  if (!workerLoading) {
    workerLoading = Tesseract.createWorker('eng', 1, {
      workerPath: WORKER_PATH,
      corePath: CORE_PATH,
      langPath: LANG_PATH,
      workerBlobURL: false, // MV3 extension CSP does not allow blob: workers
      gzip: false, // we bundle the uncompressed eng.traineddata
      legacyCore: false,
      legacyLang: false,
      logger: (m) => {
        // The worker reports initialization and recognition progress. Only
        // surface recognition progress; initialization has its own message.
        if (m && m.status === 'recognizing text') {
          sendStatus('recognizing', Number(m.progress) || 0);
        }
      },
      errorHandler: (err) => {
        console.error('[ShiponLens] Tesseract worker error:', err);
      },
    })
      .then((created) => {
        worker = created;
        return created;
      })
      .catch((err) => {
        workerLoading = null;
        throw err;
      })
      .finally(() => {
        // Keep resolved workerLoading as a resolved promise; it is cheap.
      });
  }
  return workerLoading;
}

async function resetWorker() {
  const current = worker;
  worker = null;
  workerLoading = null;
  if (current) {
    try {
      await current.terminate();
    } catch {
      // Ignore.
    }
  }
}

async function preprocess(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('The captured image was not valid.');
  }

  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const srcW = bitmap.width;
    const srcH = bitmap.height;
    if (!srcW || !srcH) throw new Error('The captured image was empty.');

    // Aim for roughly two to three source pixels per screen pixel so that
    // small UI text lands at ~30 px tall. Very large selections are downscaled
    // only enough to keep memory and OCR time sane.
    let scale = 2;
    if (srcH <= 40) scale = 3;
    if (srcH <= 20) scale = 4;
    if (srcH <= 10) scale = 6;

    const maxSide = 2600;
    const maxPixels = 4_200_000;
    scale = Math.min(
      scale,
      maxSide / srcW,
      maxSide / srcH,
      Math.sqrt(maxPixels / (srcW * srcH)),
    );
    scale = Math.max(0.25, scale);

    const width = Math.max(1, Math.round(srcW * scale));
    const height = Math.max(1, Math.round(srcH * scale));

    const work = document.createElement('canvas');
    work.width = width;
    work.height = height;
    const workCtx = work.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!workCtx) throw new Error('Could not create a canvas for preprocessing.');
    workCtx.imageSmoothingEnabled = true;
    workCtx.imageSmoothingQuality = 'high';
    workCtx.fillStyle = '#ffffff';
    workCtx.fillRect(0, 0, width, height);
    workCtx.drawImage(bitmap, 0, 0, width, height);

    const imageData = workCtx.getImageData(0, 0, width, height);
    processPixels(imageData);
    workCtx.putImageData(imageData, 0, 0);
    const bands = countTextBands(imageData);

    // A quiet white border prevents Tesseract from treating the selection's
    // edge as the page edge.
    const pad = Math.min(18, Math.max(6, Math.round(Math.min(width, height) * 0.04)));
    const out = document.createElement('canvas');
    out.width = width + pad * 2;
    out.height = height + pad * 2;
    const outCtx = out.getContext('2d', { alpha: false });
    if (!outCtx) throw new Error('Could not create the OCR canvas.');
    outCtx.fillStyle = '#ffffff';
    outCtx.fillRect(0, 0, out.width, out.height);
    outCtx.drawImage(work, pad, pad);

    return { canvas: out, bands };
  } finally {
    bitmap.close();
  }
}

/**
 * Grayscale -> optional inversion -> contrast stretch, in place.
 */
function processPixels(imageData) {
  const data = imageData.data;
  const pixelCount = imageData.width * imageData.height;
  const histogram = new Uint32Array(256);
  let sum = 0;

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    // Rec. 601 luma.
    const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114 + 500) / 1000;
    const v = lum < 0 ? 0 : lum > 255 ? 255 : lum | 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
    histogram[v] += 1;
    sum += v;
  }

  const mean = sum / Math.max(1, pixelCount);
  const invert = mean < 110; // dark backgrounds become dark-on-light

  // Use very small percentile tails rather than min/max, so a speck of noise
  // does not flatten the contrast, but a single sparse line of text still
  // counts and does not get clipped away.
  const lowOriginal = percentile(histogram, pixelCount, 0.0005);
  const highOriginal = percentile(histogram, pixelCount, 0.9995);
  let low = invert ? 255 - highOriginal : lowOriginal;
  let high = invert ? 255 - lowOriginal : highOriginal;

  const range = high - low;
  const stretch = range >= 8;
  const factor = stretch ? 255 / range : 1;

  if (!invert && !stretch) return;

  for (let i = 0; i < data.length; i += 4) {
    let v = data[i];
    if (invert) v = 255 - v;
    if (stretch) {
      v = (v - low) * factor;
      v = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
}

function percentile(histogram, total, fraction) {
  const target = Math.max(1, Math.floor(total * fraction));
  let seen = 0;
  for (let i = 0; i < 256; i += 1) {
    seen += histogram[i];
    if (seen >= target) return i;
  }
  return 255;
}

/**
 * Counts horizontal bands of dark pixels in the preprocessed image. One band
 * means a single line of text, which is the only time PSM 7 is appropriate.
 * Counting bands is more reliable than a width/height ratio: three short lines
 * can also be very wide, but PSM 7 would return nothing for them.
 */
function countTextBands(imageData) {
  const { width, height, data } = imageData;
  const minDarkPerRow = Math.max(2, Math.floor(width * 0.002));
  let bands = 0;
  let inBand = false;
  let blankRun = 0;

  for (let y = 0; y < height; y += 1) {
    let dark = 0;
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[rowStart + x * 4] < 110) dark += 1;
      if (dark >= minDarkPerRow) break;
    }
    const texty = dark >= minDarkPerRow;
    if (texty) {
      if (!inBand) {
        bands += 1;
        inBand = true;
      }
      blankRun = 0;
    } else if (inBand) {
      blankRun += 1;
      if (blankRun >= 3) {
        inBand = false;
        blankRun = 0;
      }
    }
  }
  return bands;
}

function pickPageSegMode(width, height, bands) {
  const aspect = width / Math.max(1, height);
  // PSM 7 only for a genuinely single-line crop; everything else gets PSM 6.
  return bands === 1 && aspect >= 4 && height <= 320 ? '7' : '6';
}

function rememberImage(captureId, entry) {
  if (!captureId) return;
  imageCache.delete(captureId);
  imageCache.set(captureId, entry);
  while (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value;
    imageCache.delete(oldest);
  }
}

function cleanText(raw) {
  const normalized = raw.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n').map((line) => line.replace(/[ \t\u00a0]+$/g, ''));
  return lines.join('\n').replace(/^\n+|\n+$/g, '').trimEnd();
}

/* ------------------------------------------------------------------ */
/* Idle and timeout helpers                                            */
/* ------------------------------------------------------------------ */

function scheduleIdleClose() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void sendIdleNotice();
  }, IDLE_CLOSE_MS);
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function isTimeoutError(err) {
  return Boolean(err && err.__pixelOcrTimeout);
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.__pixelOcrTimeout = true;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function friendlyError(err) {
  const raw = err && err.message ? err.message : String(err);
  if (/traineddata|language|langPath/i.test(raw)) {
    return 'The bundled OCR language data could not be loaded. Reinstall the extension.';
  }
  if (/tesseract core|WebAssembly|wasm|importScripts|worker/i.test(raw)) {
    return 'The OCR engine could not start. Reinstall the extension and try again.';
  }
  if (/no longer available/i.test(raw)) return raw;
  if (/timed out/i.test(raw)) return raw;
  return raw.length > 260 ? `${raw.slice(0, 257)}…` : raw;
}
