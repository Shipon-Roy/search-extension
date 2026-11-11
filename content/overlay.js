/**
 * Pixel OCR — selection overlay and result panel.
 *
 * This file is injected on demand by the service worker. It deliberately does
 * not run as a permanent content script: it only exists after the user asks for
 * a capture, and removes all of its DOM and listeners afterwards.
 *
 * Everything is rendered inside an open shadow root with `all: initial`, so the
 * host page's CSS cannot change the UI and the UI cannot change the page.
 */

(() => {
  'use strict';

  // Re-injection guard: the service worker may ask for a capture while this
  // page already has the overlay. Restart instead of adding a second copy.
  if (window.__pixelOcrOverlay) {
    window.__pixelOcrOverlay.restart();
    return;
  }

  const LinkTools = window.PixelOcrLinks;
  if (!LinkTools) {
    console.warn('[Pixel OCR] Lookup helpers failed to load.');
  }

  const HOST_ID = 'pixel-ocr-overlay-host';
  const Z_INDEX = '2147483647';
  const MIN_SELECTION = 5;
  const COPY_FLASH_MS = 1500;
  const OCR_CLIENT_TIMEOUT_MS = 150000;

  let host = null;
  let shadow = null;
  let refs = null;
  let sessionAC = null;
  let keyAC = null;

  let state = 'idle'; // idle | selecting | busy | result
  let dragStart = null;
  let dragCurrent = null;
  let lastRect = null;
  let currentCaptureId = null;
  let lastStatus = null;
  let lastNumbersOnly = false;
  let requestToken = 0;

  let copyFlashTimer = null;
  let watchdogTimer = null;

  let lookupTypes = [];
  let lastUsedTypeId = '';
  let selectedTypeId = '';
  let settingsLoaded = false;
  let settingsLoadPromise = null;
  let settingsGeneration = 0;
  let settingsError = '';
  let lookupToken = 0;

  const api = {
    restart: () => startSelection(),
    destroy: () => cancelOverlay(),
    isActive: () => Boolean(host),
  };
  window.__pixelOcrOverlay = api;

  /* ---------------------------------------------------------------- */
  /* Shadow UI                                                        */
  /* ---------------------------------------------------------------- */

  function createHost() {
    if (host && host.isConnected) return;

    host = document.createElement('div');
    host.id = HOST_ID;
    // Inline !important declarations protect the host from page-level rules.
    host.style.cssText =
      'all: initial !important;' +
      'position: fixed !important;' +
      'inset: 0 !important;' +
      `z-index: ${Z_INDEX} !important;` +
      'display: block !important;' +
      'pointer-events: auto !important;' +
      'background: transparent !important;' +
      'border: 0 !important;' +
      'margin: 0 !important;' +
      'padding: 0 !important;' +
      'overflow: hidden !important;';

    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          inset: 0;
          z-index: ${Z_INDEX};
          display: block;
          overflow: hidden;
          color-scheme: light dark;
          --po-bg: #ffffff;
          --po-fg: #111827;
          --po-muted: #667085;
          --po-border: #d0d5dd;
          --po-field: #f9fafb;
          --po-accent: #2563eb;
          --po-accent-fg: #ffffff;
          --po-accent-hover: #1d4ed8;
          --po-danger: #b42318;
          --po-success: #067647;
          --po-shadow: 0 18px 50px rgba(15, 23, 42, 0.28), 0 2px 8px rgba(15, 23, 42, 0.16);
          font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-size: 13px;
          line-height: 1.4;
          text-align: left;
          -webkit-font-smoothing: antialiased;
        }
        @media (prefers-color-scheme: dark) {
          :host {
            --po-bg: #1b2130;
            --po-fg: #e8eaf0;
            --po-muted: #a0a8b8;
            --po-border: #3a4356;
            --po-field: #121722;
            --po-accent: #5b9dff;
            --po-accent-fg: #0b1220;
            --po-accent-hover: #7db2ff;
            --po-danger: #ff8a80;
            --po-success: #4ade80;
            --po-shadow: 0 22px 60px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4);
          }
        }
        *, *::before, *::after { box-sizing: border-box; }

        .shade {
          position: fixed;
          inset: 0;
          background: rgba(8, 12, 20, 0.42);
          cursor: crosshair;
          opacity: 1;
          transition: opacity 70ms linear;
        }

        .selection {
          position: fixed;
          left: 0;
          top: 0;
          width: 0;
          height: 0;
          display: none;
          border: 1.5px solid #5b9dff;
          border-radius: 2px;
          box-shadow: 0 0 0 100vmax rgba(8, 12, 20, 0.46);
          pointer-events: none;
        }

        .size {
          position: fixed;
          left: 0;
          top: 0;
          display: none;
          padding: 3px 7px;
          border-radius: 5px;
          background: #0b1220;
          color: #ffffff;
          font: 600 11px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          letter-spacing: 0.01em;
          white-space: nowrap;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
          pointer-events: none;
        }

        .hint {
          position: fixed;
          top: 14px;
          left: 50%;
          transform: translateX(-50%);
          max-width: calc(100vw - 24px);
          padding: 8px 14px;
          border-radius: 999px;
          background: rgba(11, 18, 32, 0.92);
          color: #ffffff;
          font: 500 12px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
          pointer-events: none;
        }

        .panel {
          position: fixed;
          left: 0;
          top: 0;
          display: none;
          flex-direction: column;
          width: min(430px, calc(100vw - 16px));
          max-height: min(640px, calc(100vh - 16px));
          padding: 0;
          border: 1px solid var(--po-border);
          border-radius: 12px;
          background: var(--po-bg);
          color: var(--po-fg);
          box-shadow: var(--po-shadow);
          overflow: hidden;
          pointer-events: auto;
        }

        .panel-head {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px 8px 14px;
          border-bottom: 1px solid var(--po-border);
        }
        .panel-title {
          flex: 1 1 auto;
          margin: 0;
          color: var(--po-fg);
          font: 650 13px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          letter-spacing: 0.005em;
        }
        .icon-btn {
          flex: 0 0 auto;
          width: 26px;
          height: 26px;
          padding: 0;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--po-muted);
          font: 400 20px/1 system-ui, sans-serif;
          cursor: pointer;
        }
        .icon-btn:hover { background: var(--po-field); color: var(--po-fg); }
        .icon-btn:focus-visible { outline: 2px solid var(--po-accent); outline-offset: 1px; }

        .panel-body {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 10px 12px 6px;
          min-height: 0;
          overflow: auto;
        }

        .loading {
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 14px 4px 16px;
          color: var(--po-muted);
          font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        .spinner {
          flex: 0 0 auto;
          width: 16px;
          height: 16px;
          border: 2px solid var(--po-border);
          border-top-color: var(--po-accent);
          border-radius: 50%;
          animation: po-spin 700ms linear infinite;
        }
        @keyframes po-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .spinner { animation: none; border-top-color: var(--po-border); border-right-color: var(--po-accent); }
        }

        .message {
          display: none;
          padding: 8px 2px 10px;
        }
        .message-title {
          margin: 0 0 3px;
          color: var(--po-fg);
          font: 650 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        .message-detail {
          margin: 0;
          color: var(--po-muted);
          font: 400 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          overflow-wrap: anywhere;
        }
        .message.is-error .message-title { color: var(--po-danger); }

        textarea {
          display: none;
          width: 100%;
          min-height: 116px;
          max-height: 36vh;
          padding: 9px 10px;
          border: 1px solid var(--po-border);
          border-radius: 8px;
          background: var(--po-field);
          color: var(--po-fg);
          font: 400 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          resize: vertical;
          outline: none;
          white-space: pre-wrap;
          overflow: auto;
        }
        textarea:focus { border-color: var(--po-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--po-accent) 22%, transparent); }

        .hintline {
          display: none;
          margin: 0;
          color: var(--po-muted);
          font: 400 11.5px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          overflow-wrap: anywhere;
        }
        .hintline.is-error { color: var(--po-danger); }
        .hintline.is-success { color: var(--po-success); }

        .lookup {
          display: none;
          flex-direction: column;
          gap: 7px;
          padding-top: 2px;
        }
        .lookup-head {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .lookup-title {
          flex: 1 1 auto;
          color: var(--po-muted);
          font: 650 10.5px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          letter-spacing: 0.055em;
          text-transform: uppercase;
        }
        .link-btn {
          padding: 1px 2px;
          border: 0;
          background: transparent;
          color: var(--po-accent);
          font: 600 11.5px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          cursor: pointer;
        }
        .link-btn:hover { text-decoration: underline; }
        .link-btn:focus-visible { outline: 2px solid var(--po-accent); outline-offset: 1px; }

        .chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .chip {
          max-width: 100%;
          padding: 4px 9px;
          border: 1px solid var(--po-border);
          border-radius: 999px;
          background: var(--po-field);
          color: var(--po-fg);
          font: 600 11.5px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          cursor: pointer;
        }
        .chip:hover { border-color: var(--po-accent); }
        .chip:focus-visible { outline: 2px solid var(--po-accent); outline-offset: 1px; }
        .chip[aria-checked="true"] {
          border-color: transparent;
          background: var(--po-accent);
          color: var(--po-accent-fg);
        }

        .type-empty {
          margin: 0;
          padding: 2px 0;
          color: var(--po-muted);
          font: 400 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        }

        .notice-line {
          margin: 0;
          color: var(--po-danger);
          font: 500 11.5px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          overflow-wrap: anywhere;
        }

        .preview {
          display: flex;
          flex-direction: column;
          gap: 3px;
          min-width: 0;
        }
        .preview-label {
          color: var(--po-muted);
          font: 500 10.5px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          letter-spacing: 0.03em;
        }
        .url-preview {
          width: 100%;
          padding: 5px 8px;
          border: 1px solid var(--po-border);
          border-radius: 6px;
          background: var(--po-field);
          color: var(--po-fg);
          font: 400 11.5px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          user-select: all;
        }
        .url-preview.is-empty { color: var(--po-muted); }

        .panel-foot {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          padding: 8px 12px 11px;
          border-top: 1px solid var(--po-border);
        }

        .numbers {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-right: auto;
          color: var(--po-muted);
          font: 500 12px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          cursor: pointer;
          user-select: none;
        }
        .numbers input {
          width: 14px;
          height: 14px;
          margin: 0;
          accent-color: var(--po-accent);
          cursor: pointer;
        }

        button.action {
          flex: 0 0 auto;
          min-width: 66px;
          padding: 6px 12px;
          border: 1px solid var(--po-border);
          border-radius: 7px;
          background: var(--po-bg);
          color: var(--po-fg);
          font: 600 12px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          cursor: pointer;
        }
        button.action:hover { background: var(--po-field); }
        button.action:focus-visible { outline: 2px solid var(--po-accent); outline-offset: 1px; }
        button.action:disabled { opacity: 0.45; cursor: default; background: var(--po-bg); }
        button.action.primary {
          border-color: transparent;
          background: var(--po-accent);
          color: var(--po-accent-fg);
        }
        button.action.primary:hover:not(:disabled) { background: var(--po-accent-hover); }
        button.action.copied {
          border-color: transparent;
          background: var(--po-success);
          color: #ffffff;
        }
      </style>

      <div class="shade"></div>
      <div class="selection"></div>
      <div class="size"></div>
      <div class="hint">Drag to select an area&nbsp; · &nbsp;Esc to cancel</div>

      <section class="panel" role="dialog" aria-label="Recognized text" aria-modal="false">
        <div class="panel-head">
          <h2 class="panel-title">Recognized text</h2>
          <button class="icon-btn" type="button" data-action="options" title="Lookup types options" aria-label="Options">⚙</button>
          <button class="icon-btn" type="button" data-action="close" title="Close (Esc)" aria-label="Close">×</button>
        </div>
        <div class="panel-body">
          <div class="loading" role="status" aria-live="polite">
            <span class="spinner" aria-hidden="true"></span>
            <span class="loading-text">Recognizing…</span>
          </div>
          <textarea spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Recognized text"></textarea>
          <div class="message" role="alert">
            <p class="message-title"></p>
            <p class="message-detail"></p>
          </div>
          <p class="hintline" role="status" aria-live="polite"></p>

          <section class="lookup" aria-label="Lookup link">
            <div class="lookup-head">
              <span class="lookup-title">Look up as</span>
              <button class="link-btn" type="button" data-action="options">Edit types</button>
            </div>
            <div class="chips" role="radiogroup" aria-label="Lookup type"></div>
            <p class="type-empty" hidden>Add a type in Options.</p>
            <p class="notice-line" role="status" aria-live="polite"></p>
            <div class="preview">
              <span class="preview-label">Link preview</span>
              <div class="url-preview is-empty" tabindex="0" role="textbox" aria-readonly="true" aria-label="Link preview"></div>
            </div>
          </section>
        </div>
        <div class="panel-foot">
          <label class="numbers">
            <input type="checkbox" data-action="numbers">
            <span>Numbers only</span>
          </label>
          <button class="action" type="button" data-action="retry">Retry</button>
          <button class="action" type="button" data-action="copy" disabled>Copy</button>
          <button class="action primary" type="button" data-action="open" disabled>Open in new tab</button>
        </div>
      </section>
    `;

    refs = {
      shade: shadow.querySelector('.shade'),
      selection: shadow.querySelector('.selection'),
      size: shadow.querySelector('.size'),
      hint: shadow.querySelector('.hint'),
      panel: shadow.querySelector('.panel'),
      loading: shadow.querySelector('.loading'),
      loadingText: shadow.querySelector('.loading-text'),
      textarea: shadow.querySelector('textarea'),
      message: shadow.querySelector('.message'),
      messageTitle: shadow.querySelector('.message-title'),
      messageDetail: shadow.querySelector('.message-detail'),
      hintline: shadow.querySelector('.hintline'),
      numbers: shadow.querySelector('input[data-action="numbers"]'),
      copyBtn: shadow.querySelector('button[data-action="copy"]'),
      retryBtn: shadow.querySelector('button[data-action="retry"]'),
      closeBtn: shadow.querySelector('button[data-action="close"]'),
      optionsBtns: shadow.querySelectorAll('button[data-action="options"]'),
      lookup: shadow.querySelector('.lookup'),
      chips: shadow.querySelector('.chips'),
      typeEmpty: shadow.querySelector('.type-empty'),
      notice: shadow.querySelector('.notice-line'),
      previewWrap: shadow.querySelector('.preview'),
      preview: shadow.querySelector('.url-preview'),
      openBtn: shadow.querySelector('button[data-action="open"]'),
    };

    refs.closeBtn.addEventListener('click', () => cancelOverlay());
    refs.retryBtn.addEventListener('click', () => startSelection());
    refs.copyBtn.addEventListener('click', () => void handleCopyClick());
    refs.numbers.addEventListener('change', () => void rerunWithNumbers());
    refs.openBtn.addEventListener('click', () => void openLookup());
    refs.optionsBtns.forEach((button) =>
      button.addEventListener('click', () => void openOptionsPage()),
    );
    refs.textarea.addEventListener('input', () => updateLookupPreview());
    refs.textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      void openLookup();
    });

    const root = document.fullscreenElement || document.documentElement;
    root.appendChild(host);
  }

  /* ---------------------------------------------------------------- */
  /* Selection                                                         */
  /* ---------------------------------------------------------------- */

  function startSelection() {
    cancelOverlay({ preserveGlobal: true });
    lookupToken += 1;
    settingsError = '';
    state = 'selecting';
    dragStart = null;
    dragCurrent = null;
    lastRect = null;
    currentCaptureId = null;
    lastStatus = null;
    lastNumbersOnly = false;

    createHost();
    host.style.display = 'block';
    host.style.pointerEvents = 'auto';
    refs.hint.style.display = 'block';
    refs.shade.style.display = 'block';
    refs.shade.style.opacity = '1';
    refs.shade.style.pointerEvents = 'auto';
    refs.selection.style.display = 'none';
    refs.size.style.display = 'none';
    refs.panel.style.display = 'none';
    refs.textarea.style.display = 'none';
    refs.message.style.display = 'none';
    refs.loading.style.display = 'flex';
    refs.numbers.checked = false;
    refs.numbers.disabled = false;
    refs.copyBtn.disabled = true;
    refs.openBtn.disabled = true;
    hideLookup();
    resetCopyButton();

    keyAC = new AbortController();
    window.addEventListener('keydown', onKeyDown, { capture: true, signal: keyAC.signal });
    window.addEventListener('resize', onViewportChange, { signal: keyAC.signal });

    sessionAC = new AbortController();
    const signal = sessionAC.signal;
    window.addEventListener('pointerdown', onPointerDown, { capture: true, signal });
    window.addEventListener('pointermove', onPointerMove, { capture: true, signal });
    window.addEventListener('pointerup', onPointerUp, { capture: true, signal });
    window.addEventListener('pointercancel', onPointerCancel, { capture: true, signal });
  }

  function onPointerDown(event) {
    if (state !== 'selecting' || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    dragStart = {
      x: clamp(event.clientX, 0, window.innerWidth),
      y: clamp(event.clientY, 0, window.innerHeight),
    };
    dragCurrent = { ...dragStart };

    refs.hint.style.display = 'none';
    refs.selection.style.display = 'block';
    refs.shade.style.opacity = '0';

    try {
      refs.shade.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a nice-to-have; window listeners still work.
    }
    updateSelectionUI();
  }

  function onPointerMove(event) {
    if (state !== 'selecting' || !dragStart) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dragCurrent = {
      x: clamp(event.clientX, 0, window.innerWidth),
      y: clamp(event.clientY, 0, window.innerHeight),
    };
    updateSelectionUI();
  }

  function onPointerUp(event) {
    if (state !== 'selecting' || !dragStart) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    if (dragCurrent) {
      dragCurrent = {
        x: clamp(event.clientX, 0, window.innerWidth),
        y: clamp(event.clientY, 0, window.innerHeight),
      };
    }

    const rect = selectionRect();
    releasePointerCapture(event.pointerId);
    dragStart = null;
    dragCurrent = null;

    if (!rect || rect.w < MIN_SELECTION || rect.h < MIN_SELECTION) {
      resetDragHint();
      return;
    }

    void beginCapture(rect);
  }

  function onPointerCancel(event) {
    if (state !== 'selecting') return;
    releasePointerCapture(event.pointerId);
    dragStart = null;
    dragCurrent = null;
    resetDragHint();
  }

  function resetDragHint() {
    refs.selection.style.display = 'none';
    refs.size.style.display = 'none';
    refs.shade.style.opacity = '1';
    refs.hint.textContent = 'Selection too small — drag at least 5 × 5 px · Esc to cancel';
    refs.hint.style.display = 'block';
  }

  function releasePointerCapture(pointerId) {
    try {
      if (refs && refs.shade.hasPointerCapture(pointerId)) {
        refs.shade.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore.
    }
  }

  function selectionRect() {
    if (!dragStart || !dragCurrent) return null;
    const x = Math.min(dragStart.x, dragCurrent.x);
    const y = Math.min(dragStart.y, dragCurrent.y);
    const w = Math.abs(dragCurrent.x - dragStart.x);
    const h = Math.abs(dragCurrent.y - dragStart.y);
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }

  function updateSelectionUI() {
    const rect = selectionRect();
    if (!rect) return;

    refs.selection.style.left = `${rect.x}px`;
    refs.selection.style.top = `${rect.y}px`;
    refs.selection.style.width = `${rect.w}px`;
    refs.selection.style.height = `${rect.h}px`;

    const label = `${Math.round(rect.w)} × ${Math.round(rect.h)} px`;
    refs.size.textContent = label;
    refs.size.style.display = 'block';

    const labelRect = refs.size.getBoundingClientRect();
    const labelX = clamp(rect.x, 4, Math.max(4, window.innerWidth - labelRect.width - 4));
    let labelY = rect.y - labelRect.height - 6;
    if (labelY < 4) labelY = rect.y + 6;
    labelY = clamp(labelY, 4, Math.max(4, window.innerHeight - labelRect.height - 4));
    refs.size.style.left = `${labelX}px`;
    refs.size.style.top = `${labelY}px`;
  }

  /* ---------------------------------------------------------------- */
  /* Capture -> OCR                                                    */
  /* ---------------------------------------------------------------- */

  async function beginCapture(rect) {
    state = 'busy';
    lastRect = rect;
    currentCaptureId = null;
    lastStatus = null;
    const token = ++requestToken;

    // Stop listening for selection gestures, but keep Esc alive.
    if (sessionAC) {
      sessionAC.abort();
      sessionAC = null;
    }

    // Hide every pixel of UI, then wait for two paints before the service
    // worker takes the screenshot. The host is display:none so nothing can be
    // captured, even if a page style makes one of the children visible.
    refs.shade.style.display = 'none';
    refs.selection.style.display = 'none';
    refs.size.style.display = 'none';
    refs.hint.style.display = 'none';
    host.style.pointerEvents = 'none';
    host.style.display = 'none';
    await nextPaint();

    const payload = {
      type: 'PIXEL_OCR_CAPTURE',
      rect: {
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      dpr: window.devicePixelRatio || 1,
    };

    startWatchdog(token);

    let response;
    try {
      response = await sendRuntimeMessage(payload, OCR_CLIENT_TIMEOUT_MS);
    } catch (err) {
      if (token !== requestToken) return;
      clearWatchdog();
      showErrorPanel('Could not capture the selection', userMessage(err));
      return;
    }

    if (token !== requestToken) return;
    clearWatchdog();
    applyResponse(response);
  }

  async function rerunWithNumbers() {
    if (state !== 'result' && state !== 'busy') return;
    lastNumbersOnly = refs.numbers.checked;
    const token = ++requestToken;
    state = 'busy';
    lastStatus = null;

    ensurePanel();
    setPanelLoading(lastNumbersOnly ? 'Re-reading numbers…' : 'Recognizing…');
    refs.copyBtn.disabled = true;
    refs.numbers.disabled = true;
    refs.retryBtn.disabled = false;
    startWatchdog(token);

    let response;
    try {
      response = await sendRuntimeMessage(
        {
          type: 'PIXEL_OCR_REOCR',
          captureId: currentCaptureId,
          numbersOnly: lastNumbersOnly,
        },
        OCR_CLIENT_TIMEOUT_MS,
      );
    } catch (err) {
      if (token !== requestToken) return;
      clearWatchdog();
      showErrorPanel('Could not re-run OCR', userMessage(err));
      return;
    }

    if (token !== requestToken) return;
    clearWatchdog();
    applyResponse(response);
  }

  function applyResponse(response) {
    if (!response || !response.ok) {
      showErrorPanel(
        'Could not recognize the text',
        (response && response.error) || 'The OCR engine returned no result.',
      );
      return;
    }

    if (response.captureId) currentCaptureId = response.captureId;
    state = 'result';
    ensurePanel();
    renderResult(response);
  }

  /* ---------------------------------------------------------------- */
  /* Panel rendering                                                   */
  /* ---------------------------------------------------------------- */

  function ensurePanel() {
    if (!host) return;
    host.style.display = 'block';
    host.style.pointerEvents = 'none';
    refs.panel.style.display = 'flex';
    placePanel();
  }

  function setPanelLoading(text) {
    state = 'busy';
    ensurePanel();
    refs.loading.style.display = 'flex';
    refs.loadingText.textContent = text || 'Recognizing…';
    refs.textarea.style.display = 'none';
    refs.message.style.display = 'none';
    refs.hintline.style.display = 'none';
    refs.numbers.disabled = false;
    refs.copyBtn.disabled = true;
    refs.openBtn.disabled = true;
    hideLookup();
    resetCopyButton();
    placePanel();
  }

  function renderResult(response) {
    const text = typeof response.text === 'string' ? response.text : '';
    lastNumbersOnly = Boolean(response.numbersOnly);
    refs.numbers.checked = lastNumbersOnly;
    refs.numbers.disabled = false;
    refs.loading.style.display = 'none';
    refs.message.style.display = 'none';
    hideHintline();
    resetCopyButton();

    if (!text) {
      state = 'result';
      refs.textarea.value = '';
      refs.textarea.style.display = 'none';
      refs.copyBtn.disabled = true;
      refs.openBtn.disabled = true;
      hideLookup();
      refs.message.classList.remove('is-error');
      refs.messageTitle.textContent = 'No text detected';
      refs.messageDetail.textContent = lastNumbersOnly
        ? 'Try a larger area or turn off “Numbers only”.'
        : 'Try a larger, clearer area, or enable “Numbers only” for digits.';
      refs.message.style.display = 'block';
      refs.retryBtn.focus({ preventScroll: true });
      placePanel();
      setHintline(
        'Nothing was copied. Use Retry to select a different area.',
        'normal',
      );
      return;
    }

    refs.textarea.value = text;
    refs.textarea.style.display = 'block';
    refs.message.style.display = 'none';
    refs.copyBtn.disabled = false;
    refs.message.classList.remove('is-error');
    state = 'result';
    placePanel();

    // Focus the field (without scrolling), then attempt the automatic copy.
    refs.textarea.focus({ preventScroll: true });
    void autoCopy(text);
    void setupLookup(text);
  }

  function showErrorPanel(title, detail) {
    state = 'result';
    if (!host) createHost();
    host.style.display = 'block';
    host.style.pointerEvents = 'none';
    refs.panel.style.display = 'flex';
    refs.loading.style.display = 'none';
    refs.textarea.style.display = 'none';
    refs.message.style.display = 'block';
    refs.message.classList.add('is-error');
    refs.messageTitle.textContent = title || 'Something went wrong';
    refs.messageDetail.textContent = detail || 'Please try again.';
    refs.hintline.style.display = 'none';
    refs.copyBtn.disabled = true;
    refs.openBtn.disabled = true;
    hideLookup();
    refs.numbers.disabled = true;
    resetCopyButton();
    refs.retryBtn.disabled = false;
    placePanel();
    refs.retryBtn.focus({ preventScroll: true });
  }

  function setHintline(text, kind) {
    if (!refs) return;
    refs.hintline.textContent = text;
    refs.hintline.classList.toggle('is-error', kind === 'error');
    refs.hintline.classList.toggle('is-success', kind === 'success');
    refs.hintline.style.display = text ? 'block' : 'none';
    placePanel();
  }

  function hideHintline() {
    if (!refs) return;
    refs.hintline.textContent = '';
    refs.hintline.style.display = 'none';
    refs.hintline.classList.remove('is-error', 'is-success');
  }

  function placePanel() {
    if (!refs || !refs.panel || refs.panel.style.display === 'none') return;
    const panel = refs.panel;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 8;
    const gap = 10;

    // Measure while invisible to avoid a visible jump.
    const previousVisibility = panel.style.visibility;
    panel.style.visibility = 'hidden';
    const box = panel.getBoundingClientRect();
    const width = Math.min(box.width, Math.max(0, viewportWidth - margin * 2));
    const height = Math.min(box.height, Math.max(0, viewportHeight - margin * 2));

    let x;
    let y;

    if (lastRect) {
      x = lastRect.x + lastRect.w + gap;
      if (x + width > viewportWidth - margin) {
        x = lastRect.x - width - gap;
      }
      if (x < margin) {
        x = clamp(lastRect.x, margin, Math.max(margin, viewportWidth - width - margin));
      }

      y = lastRect.y;
      if (y + height > viewportHeight - margin) {
        y = lastRect.y + lastRect.h - height;
      }
      if (y < margin) {
        y = lastRect.y - height - gap;
      }
    } else {
      x = (viewportWidth - width) / 2;
      y = (viewportHeight - height) / 2;
    }

    x = clamp(x, margin, Math.max(margin, viewportWidth - width - margin));
    y = clamp(y, margin, Math.max(margin, viewportHeight - height - margin));

    panel.style.left = `${Math.round(x)}px`;
    panel.style.top = `${Math.round(y)}px`;
    panel.style.visibility = previousVisibility || 'visible';
  }

  function onViewportChange() {
    if (!host) return;
    if (state === 'selecting' && dragStart && dragCurrent) {
      dragStart.x = clamp(dragStart.x, 0, window.innerWidth);
      dragStart.y = clamp(dragStart.y, 0, window.innerHeight);
      dragCurrent.x = clamp(dragCurrent.x, 0, window.innerWidth);
      dragCurrent.y = clamp(dragCurrent.y, 0, window.innerHeight);
      updateSelectionUI();
    }
    if (lastRect) {
      lastRect.w = Math.min(lastRect.w, window.innerWidth - lastRect.x);
      lastRect.h = Math.min(lastRect.h, window.innerHeight - lastRect.y);
    }
    placePanel();
  }

  /* ---------------------------------------------------------------- */
  /* Status, clipboard, watchdog                                       */
  /* ---------------------------------------------------------------- */

  function applyStatus(status) {
    if (!status || state !== 'busy') return;
    lastStatus = status;
    let text = 'Recognizing…';

    if (status.state === 'loading-engine') {
      const pct = status.progress > 0 ? ` ${Math.round(status.progress * 100)}%` : '';
      text = `Loading OCR engine…${pct}`;
    } else if (status.state === 'preparing') {
      text = 'Preparing image…';
    } else if (status.state === 'recognizing') {
      const pct = status.progress > 0 ? ` ${Math.round(status.progress * 100)}%` : '';
      text = `Recognizing…${pct}`;
    }

    if (refs && refs.panel.style.display !== 'none') {
      refs.loadingText.textContent = text;
      placePanel();
    }
  }

  async function autoCopy(text) {
    if (!text) return;
    const ok = await copyText(text);
    if (state !== 'result') return;
    if (ok) {
      flashCopied();
      setHintline('Copied to clipboard automatically.', 'success');
    } else {
      setHintline('Couldn’t copy automatically — click Copy, or select the text and press Ctrl+C.', 'error');
    }
  }

  async function handleCopyClick() {
    if (!refs) return;
    const text = refs.textarea.value;
    if (!text) return;
    const ok = await copyText(text);
    if (ok) {
      flashCopied();
      setHintline('Copied to clipboard.', 'success');
    } else {
      setHintline('Copy failed. Select the text and press Ctrl+C.', 'error');
    }
  }

  async function copyText(text) {
    // Preferred path.
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall through to execCommand.
    }

    // Legacy fallback: hidden textarea + execCommand('copy').
    const active = shadow && shadow.activeElement;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText =
      'position:fixed !important;left:-9999px !important;top:0 !important;' +
      'width:1px !important;height:1px !important;opacity:0 !important;' +
      'pointer-events:none !important;';
    const parent = document.body || document.documentElement;
    parent.appendChild(ta);
    let ok = false;
    try {
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    } finally {
      ta.remove();
      if (active && typeof active.focus === 'function') {
        active.focus({ preventScroll: true });
      }
    }
    return ok;
  }

  /* ---------------------------------------------------------------- */
  /* Lookup types, chips, and URL preview                              */
  /* ---------------------------------------------------------------- */

  function hideLookup() {
    if (!refs || !refs.lookup) return;
    refs.lookup.style.display = 'none';
    refs.notice.textContent = '';
    refs.notice.style.display = 'none';
    refs.openBtn.disabled = true;
  }

  function getSelectedType() {
    return lookupTypes.find((type) => type.id === selectedTypeId) || null;
  }

  function chooseTypeForText(text) {
    if (!lookupTypes.length) return '';
    const phoneType = lookupTypes.find((type) => type.cleaning === 'Phone');
    if (phoneType && LinkTools && LinkTools.looksLikeBdPhone(text)) return phoneType.id;
    if (selectedTypeId && lookupTypes.some((type) => type.id === selectedTypeId)) {
      return selectedTypeId;
    }
    if (lastUsedTypeId && lookupTypes.some((type) => type.id === lastUsedTypeId)) {
      return lastUsedTypeId;
    }
    return lookupTypes[0].id;
  }

  function ensureSettingsLoaded() {
    if (settingsLoaded) return Promise.resolve(true);
    if (!LinkTools) {
      settingsError = 'Lookup settings are unavailable on this page.';
      return Promise.resolve(false);
    }
    if (!settingsLoadPromise) {
      const generation = settingsGeneration;
      settingsLoadPromise = LinkTools.loadSettings()
        .then((settings) => {
          if (generation !== settingsGeneration) return;
          lookupTypes = settings.types;
          lastUsedTypeId = settings.lastTypeId;
          settingsLoaded = true;
          settingsError = '';
        })
        .catch((err) => {
          if (generation !== settingsGeneration) return;
          settingsError = (err && err.message) || 'Could not load lookup types.';
        })
        .finally(() => {
          settingsLoadPromise = null;
        });
    }
    return settingsLoadPromise.then(() => settingsLoaded);
  }

  async function setupLookup(text) {
    if (!refs) return;
    const token = ++lookupToken;
    refs.lookup.style.display = 'flex';

    const loaded = await ensureSettingsLoaded();
    if (token !== lookupToken || state !== 'result' || !refs) return;

    if (!loaded) {
      lookupTypes = [];
      selectedTypeId = '';
      renderChips();
      updateLookupPreview();
      return;
    }

    selectedTypeId = chooseTypeForText(text);
    renderChips();
    updateLookupPreview();
  }

  async function refreshLookupSettings() {
    settingsGeneration += 1;
    settingsLoaded = false;
    settingsLoadPromise = null;
    if (state !== 'result' || !refs) return;

    const token = ++lookupToken;
    const loaded = await ensureSettingsLoaded();
    if (token !== lookupToken || state !== 'result' || !refs) return;

    if (!loaded) {
      lookupTypes = [];
      selectedTypeId = '';
      renderChips();
      updateLookupPreview();
      return;
    }

    if (!lookupTypes.some((type) => type.id === selectedTypeId)) {
      selectedTypeId = lastUsedTypeId && lookupTypes.some((type) => type.id === lastUsedTypeId)
        ? lastUsedTypeId
        : (lookupTypes[0] ? lookupTypes[0].id : '');
    }
    renderChips();
    updateLookupPreview();
  }

  function renderChips() {
    if (!refs) return;
    refs.chips.replaceChildren();
    refs.typeEmpty.hidden = lookupTypes.length > 0;
    refs.previewWrap.style.display = lookupTypes.length ? 'flex' : 'none';

    if (!lookupTypes.length) {
      refs.notice.textContent = settingsError || '';
      refs.notice.style.display = settingsError ? 'block' : 'none';
      return;
    }

    for (const type of lookupTypes) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(type.id === selectedTypeId));
      chip.title = type.name;
      chip.textContent = type.name;
      chip.addEventListener('click', () => {
        selectedTypeId = type.id;
        void LinkTools.saveLastTypeId(type.id);
        renderChips();
        updateLookupPreview();
      });
      refs.chips.appendChild(chip);
    }
  }

  function updateLookupPreview() {
    if (!refs || !refs.lookup || refs.lookup.style.display === 'none') return;

    const type = getSelectedType();
    const notices = [];
    let url = '';

    if (settingsError) notices.push('Could not load lookup types. Open Options.');
    if (!lookupTypes.length) {
      refs.typeEmpty.hidden = false;
      refs.previewWrap.style.display = 'none';
    } else {
      refs.typeEmpty.hidden = true;
      refs.previewWrap.style.display = 'flex';
    }

    if (type) {
      if (LinkTools.isPlaceholderTemplate(type.template)) {
        notices.push('Set your link in Options');
      }
      const cleaned = LinkTools.cleanValue(refs.textarea.value, type.cleaning);
      if (cleaned.usedFirstValue) notices.push('Using first value');
      if (cleaned.invalidPhone) notices.push("Doesn't look like a valid BD number");
      if (cleaned.value) {
        url = LinkTools.buildUrl(type.template, cleaned.value) || '';
        if (!url && !LinkTools.isPlaceholderTemplate(type.template)) {
          notices.push('Set your link in Options');
        }
      }
    }

    refs.notice.textContent = notices.join(' · ');
    refs.notice.style.display = notices.length ? 'block' : 'none';
    refs.preview.textContent = url || 'Enter a value to preview the link.';
    refs.preview.title = url;
    refs.preview.classList.toggle('is-empty', !url);
    refs.openBtn.disabled = !url;
    refs.openBtn.title = url ? `Open ${url}` : 'Enter a value to enable';
    placePanel();
  }

  async function openLookup() {
    if (!refs || refs.openBtn.disabled) return;
    const type = getSelectedType();
    if (!type) return;
    const text = refs.textarea.value;
    if (!text.trim()) return;

    refs.openBtn.disabled = true;
    try {
      const response = await sendRuntimeMessage(
        { type: 'PIXEL_OCR_OPEN_URL', typeId: type.id, text },
        15000,
      );
      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'The link could not be opened.');
      }
      selectedTypeId = type.id;
      void LinkTools.saveLastTypeId(type.id);
      setHintline('Opened in a new tab.', 'success');
    } catch (err) {
      setHintline(`Could not open link: ${userMessage(err)}`, 'error');
    } finally {
      updateLookupPreview();
    }
  }

  async function openOptionsPage() {
    try {
      const response = await sendRuntimeMessage({ type: 'PIXEL_OCR_OPEN_OPTIONS' }, 10000);
      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'Options could not be opened.');
      }
    } catch (err) {
      setHintline(`Could not open Options: ${userMessage(err)}`, 'error');
    }
  }

  function flashCopied() {
    if (!refs) return;
    if (copyFlashTimer) clearTimeout(copyFlashTimer);
    refs.copyBtn.textContent = 'Copied ✓';
    refs.copyBtn.classList.add('copied');
    copyFlashTimer = setTimeout(() => {
      copyFlashTimer = null;
      resetCopyButton();
    }, COPY_FLASH_MS);
  }

  function resetCopyButton() {
    if (copyFlashTimer) {
      clearTimeout(copyFlashTimer);
      copyFlashTimer = null;
    }
    if (!refs) return;
    refs.copyBtn.textContent = 'Copy';
    refs.copyBtn.classList.remove('copied');
  }

  function startWatchdog(token) {
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      if (token !== requestToken) return;
      showErrorPanel('OCR timed out', 'The OCR engine did not respond in time. Please try again.');
    }, OCR_CLIENT_TIMEOUT_MS + 5000);
  }

  function clearWatchdog() {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Cleanup                                                           */
  /* ---------------------------------------------------------------- */

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelOverlay();
  }

  function cancelOverlay(options) {
    const preserveGlobal = Boolean(options && options.preserveGlobal);
    requestToken += 1;
    if (sessionAC) {
      sessionAC.abort();
      sessionAC = null;
    }
    if (keyAC) {
      keyAC.abort();
      keyAC = null;
    }
    clearWatchdog();
    if (copyFlashTimer) {
      clearTimeout(copyFlashTimer);
      copyFlashTimer = null;
    }
    if (host) {
      host.remove();
      host = null;
    }
    shadow = null;
    refs = null;
    state = 'idle';
    dragStart = null;
    dragCurrent = null;
    lastRect = null;
    currentCaptureId = null;
    lastStatus = null;
    lastNumbersOnly = false;
    if (!preserveGlobal) {
      // Keep window.__pixelOcrOverlay and the runtime listener so a later
      // injection can restart without duplicating the listener.
    }
  }

  /* ---------------------------------------------------------------- */
  /* Messaging helpers                                                 */
  /* ---------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.channel !== 'pixel-ocr') return;

    if (message.type === 'CAPTURED') {
      if (state !== 'busy') return;
      if (message.captureId) currentCaptureId = message.captureId;
      ensurePanel();
      setPanelLoading(lastStatus ? loadingTextFor(lastStatus) : 'Recognizing…');
      return;
    }

    if (message.type === 'STATUS') {
      applyStatus(message);
    }
  });

  function loadingTextFor(status) {
    if (status.state === 'loading-engine') {
      const pct = status.progress > 0 ? ` ${Math.round(status.progress * 100)}%` : '';
      return `Loading OCR engine…${pct}`;
    }
    if (status.state === 'preparing') return 'Preparing image…';
    if (status.state === 'recognizing') {
      const pct = status.progress > 0 ? ` ${Math.round(status.progress * 100)}%` : '';
      return `Recognizing…${pct}`;
    }
    return 'Recognizing…';
  }

  function sendRuntimeMessage(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('The extension did not respond in time. Please try again.'));
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message || 'The extension is unavailable.'));
            return;
          }
          if (response === undefined) {
            reject(new Error('The extension returned no response.'));
            return;
          }
          resolve(response);
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  function userMessage(err) {
    const raw = err && err.message ? err.message : String(err);
    if (/context invalidated|extension is unavailable/i.test(raw)) {
      return 'The extension was reloaded. Reload this page, then try again.';
    }
    if (/not respond|timed out/i.test(raw)) {
      return 'The OCR engine did not respond in time. Please try again.';
    }
    return raw;
  }

  function nextPaint() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      // Safety net if rAF is throttled for some reason.
      setTimeout(finish, 500);
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  if (LinkTools && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes) => {
      if (!changes || !changes[LinkTools.TYPES_KEY]) return;
      void refreshLookupSettings();
    });
  }

  // Warm the saved types while the user is still selecting, then start.
  void ensureSettingsLoaded();
  startSelection();
})();
