# Pixel OCR — Select & Copy

A fully offline Chrome extension (Manifest V3) that turns any part of a webpage into
editable, copyable text. Drag a rectangle over the screen, and the pixels inside it are
recognized locally with a bundled Tesseract.js engine.

No account, no network requests, no cloud OCR, no API keys. The recognition engine,
WASM build, and English language data all ship inside this folder.

## Features

- Drag a rectangle in any direction; the selection is clamped to the visible viewport.
- Works on ordinary pages, text inside images and canvases, playing videos, and
  cross-origin iframes — because it recognizes the rendered pixels, not the DOM.
- Editable result panel with **Copy**, **Retry**, and **Close (X)**; `Esc` also closes.
- Recognized text is copied automatically, with a visible “Copied ✓” confirmation.
- **Numbers only** switch re-runs OCR on the *same* captured image with the whitelist
  `0123456789.,-+%$/:` — ideal for invoices, serials, prices, and tables of digits.
- Automatic preprocessing: upscale small selections, grayscale, contrast stretch,
  invert light-on-dark text, and add a quiet white border.
- Keeps line breaks, trims trailing whitespace, and reports **No text detected** rather
  than copying an empty string.
- Light and dark UI that follows the system color scheme.
- Trigger from the toolbar icon or the `Alt+Shift+S` keyboard shortcut.
- Graceful failure on `chrome://` pages, the Chrome Web Store, and other restricted
  pages, with a red `!` badge and an explanatory tooltip.
- The OCR worker stays warm between captures and closes after roughly five minutes idle
  to release memory.

## Requirements

- Google Chrome 116 or newer (the extension uses `chrome.runtime.getContexts`).
- English language data only (bundled).
- About 8 MB of disk space; no internet connection at runtime.

## Install (unpacked)

1. Keep the folder structure intact — `manifest.json` must sit at the folder root.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
5. Optionally click the puzzle-piece icon and pin **Pixel OCR** to the toolbar.

### Shortcut

The default shortcut is **`Alt+Shift+S`**. If it is already taken by another app or
extension, Chrome leaves it unassigned; set your own at
`chrome://extensions/shortcuts` → **Pixel OCR** → **Select an area and OCR it**.

## Use

1. Open a normal `http://` or `https://` page.
2. Click the Pixel OCR toolbar icon, or press `Alt+Shift+S`.
3. Drag a rectangle around the text. The area outside the selection dims and a live
   pixel-size label appears.
4. Release the mouse. The overlay disappears, the screen is captured, and the result
   panel opens. The first run loads the engine (a few seconds); later runs are faster.
5. Edit the text if needed, then use **Copy**, **Retry** (select again), **Numbers only**,
   or **Close**. Pressing `Esc` at any time cancels and removes the overlay.

Selecting a region smaller than 5 × 5 CSS pixels is ignored; drag a larger area. While
the overlay is open, triggering the extension again cancels the current session and
starts a fresh selection.

## How it works

```
toolbar click / Alt+Shift+S
        │
        ▼
background.js (service worker)
  ├─ rejects chrome://, Web Store, other extension pages → badge + tooltip
  ├─ injects content/overlay.js with chrome.scripting.executeScript
  ├─ waits while the overlay hides itself and paints twice
  ├─ chrome.tabs.captureVisibleTab → PNG of the visible tab
  ├─ crops the selection using the real screenshot/viewport scale
  └─ sends the crop to the offscreen document
        │
        ▼
offscreen/offscreen.html + offscreen.js
  ├─ preprocesses pixels (upscale, grayscale, invert, contrast, white border)
  ├─ picks PSM 6 normally, PSM 7 for a single line of text
  ├─ runs the bundled Tesseract.js worker (created once, reused)
  ├─ caches the last two preprocessed images for “Numbers only”
  └─ returns text + progress to the overlay
        │
        ▼
content/overlay.js (Shadow DOM)
  ├─ editable textarea, Copy / Retry / Close, Numbers only
  ├─ auto-copy via navigator.clipboard, with execCommand fallback
  └─ removes all DOM and listeners on close
```

### Why an offscreen document?

Manifest V3 service workers have no DOM and cannot create the canvas or web worker that
Tesseract.js needs. An offscreen document also isolates OCR from the host page’s
Content-Security-Policy. The worker is reused across captures; only one offscreen
document exists at a time.

### Crop accuracy

The screenshot is not assumed to be exactly `viewport × devicePixelRatio`: fractional
browser zoom and OS display scaling can round differently. The extension derives the
actual scale from the captured PNG’s width and height and the CSS viewport, then crops
with `floor`/`ceil` bounds so no row or column is clipped.

## Permissions

| Permission | Why it is needed | What it does **not** allow |
| --- | --- | --- |
| `activeTab` | Grants temporary access to the current tab only after you click the icon or press the shortcut. Needed to inject the overlay and call `captureVisibleTab`. | No persistent access to any site; no `<all_urls>` host permission. The grant ends on navigation or tab close. |
| `scripting` | Runs the on-demand overlay script in the active tab. | Does not read page content by itself. |
| `offscreen` | Creates the hidden document that hosts the local Tesseract.js worker. | No network access; assets are extension-local. |

Also relevant:

- **No `host_permissions`** and no content scripts registered at install time.
- **No `clipboardWrite` permission.** Copying happens in the page context through the
  Clipboard API, with a hidden-textarea + `execCommand('copy')` fallback. Clipboard
  permission is not required for this path.
- **No `storage`, `tabs` history, cookies, or webRequest** access.
- `content_security_policy.extension_pages` adds `'wasm-unsafe-eval'` so the bundled
  WebAssembly can be instantiated. It does not permit remote scripts or JavaScript
  `eval` of downloaded code.

## Offline assets, versions, and licenses

Bundled under `lib/tesseract/`:

| File | Version / source | Size (bytes) | SHA-256 |
| --- | --- | --- | --- |
| `tesseract.min.js` | `tesseract.js@7.0.0/dist/tesseract.min.js` | 62,961 | `000C27D9CD0DEF655F77B36C72A389C0AB13793AA31CB4D7AAB56D09C0AFBC7E` |
| `worker.min.js` | `tesseract.js@7.0.0/dist/worker.min.js` | 111,307 | `576B7DF7E3393E137E51849357C9ADB53FE7AC1BB69BFA06CF3D61520F182C6D` |
| `tesseract-core-simd-lstm.wasm.js` | `tesseract.js-core@7.0.0/tesseract-core-simd-lstm.wasm.js` | 3,899,472 | `C58B46A4C796C0B8AFCCF77591D5B875B6896B45D402BBCE8CAA6F5362447B38` |
| `eng.traineddata` | `tessdata_fast`, commit `87416418657359cb625c412a48b6e1d6d41c29bd` | 4,113,088 | `7D4322BD2A7749724879683FC3912CB542F19906C83BCC1A52132556427170B2` |

The SIMD + LSTM core is used because every Chrome version supported by this extension
supports WebAssembly SIMD. Its `.wasm` binary is embedded inside the `.js` file, so no
separate WASM file is fetched. `workerBlobURL` is disabled because the MV3 extension CSP
does not allow `blob:` workers; the bundled worker file is loaded directly instead.

**Licenses:** Tesseract.js and tesseract.js-core are Apache-2.0. The `tessdata_fast`
English model is Apache-2.0. License texts are included as
`LICENSE-tesseract.js.txt`, `LICENSE-tesseract.js-core.txt`, and
`LICENSE-tessdata.txt`. The icons are original artwork created for this project.

### Re-downloading the assets

If the `lib/tesseract/` files are missing, fetch these exact versions (PowerShell):

```powershell
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force lib\tesseract | Out-Null

Invoke-WebRequest 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js' `
  -OutFile 'lib\tesseract\tesseract.min.js'
Invoke-WebRequest 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js' `
  -OutFile 'lib\tesseract\worker.min.js'
Invoke-WebRequest 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-simd-lstm.wasm.js' `
  -OutFile 'lib\tesseract\tesseract-core-simd-lstm.wasm.js'
Invoke-WebRequest 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata' `
  -OutFile 'lib\tesseract\eng.traineddata'
```

Verify with `Get-FileHash <file> -Algorithm SHA256` against the table above. These
downloads are needed only to rebuild the folder; the shipped extension never fetches
them.

## File structure

```
.
├── manifest.json
├── background.js              # triggers, capture, crop, offscreen lifecycle
├── content/
│   └── overlay.js             # selection UI + result panel (Shadow DOM)
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js           # preprocessing + Tesseract worker
├── lib/
│   └── tesseract/
│       ├── tesseract.min.js
│       ├── worker.min.js
│       ├── tesseract-core-simd-lstm.wasm.js
│       ├── eng.traineddata
│       └── LICENSE-*.txt
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

There is no build step. Every file is plain JavaScript, HTML, CSS, or a static asset.

## Verification

The extension was exercised end-to-end in Chrome for Testing **157.0.8103.50** with
Puppeteer, driving real pointer selections against local fixtures. **52/52 checks
passed** across the final run.

Highlights:

- **Recognition:** normal paragraphs (line breaks preserved), white-on-dark text via
  automatic inversion, digits inside an image, text over a playing video frame, text
  inside an iframe, and a “Numbers only” re-run using the same capture.
- **Scaling:** device pixel ratios 1 / 1.25 / 1.5 / 2 (display scaling 100 / 125 / 150 /
  200%) and browser zoom 80 / 100 / 150%. Crops aligned at every combination tested.
- **Scrollbars:** with forced classic scrollbars, `innerWidth` 987 vs `clientWidth` 970,
  `devicePixelRatio` 1.25, the screenshot was 1234 × 884 CSS-scaled pixels and the crop
  remained aligned.
- **Selection behavior:** any drag direction, clamping at viewport edges, 5 × 5 px
  minimum, `Esc` during selection/OCR, duplicate trigger while active, and the result
  panel staying fully inside the viewport near the bottom-right corner.
- **Cleanup:** 21 consecutive captures with no leftover overlay nodes, no DOM growth, and
  bounded JS heap.
- **Offline:** the engine cold-started with the tab in offline mode; all 64 captured
  extension network requests were `chrome-extension://` (or local `data:`/`blob:`)
  resources — no external traffic.
- **Failure path:** a `chrome://extensions` tab produced the red `!` badge and the
  tooltip “Chrome does not allow extensions to run on chrome:// pages.”
- **Visual:** light and dark panels, plus the live selection cutout, were screenshotted
  and checked; the overlay was absent from the captured screenshot (sampled pixel
  255,255,255).
- **Manifest:** production permissions are exactly `activeTab`, `scripting`, and
  `offscreen`, with no host permissions; `chrome.commands.getAll()` reports
  `capture-region` → `Alt+Shift+S`.

### Known testing limitations

- The automated harness injects the overlay through a test-only copy of the extension
  that adds `<all_urls>`. The shipped manifest does not contain it. Chrome’s toolbar and
  browser-level shortcut handling cannot be clicked from Puppeteer, and synthetic
  key events do not invoke extension commands, so the real toolbar-click / `activeTab`
  grant path was verified by manifest inspection and command registration rather than by
  an automated click. A quick manual click of the pinned icon is recommended after
  installation.
- The five-minute idle auto-close was not waited out in the final automated run; the
  close path itself was exercised directly. Both the background timer and the offscreen
  document’s idle timer use the same five-minute constant.
- The video fixture uses a text caption track rendered over a playing video, not OCR of
  text baked into the video frames. Recognition operates on whatever pixels are visible,
  so both cases use the same path.

## Privacy

Captured pixels are held in memory only long enough to crop and recognize them. The
service worker, offscreen document, and content script never send data off the device.
There is no analytics, telemetry, remote configuration, or update fetch. The extension
contains no remote code and does not use `eval` on strings.

## Limitations

- **English only.** The bundled model is `eng.traineddata`; adding another language
  requires bundling its data and changing the worker’s language code.
- **Pixels, not the DOM.** Text outside the visible viewport must be scrolled into view
  first. Text hidden behind overlays, opacity, or clipping cannot be recovered.
- **Accuracy varies.** Handwriting, decorative fonts, very small text, low contrast, and
  heavy compression can reduce accuracy. Select a slightly larger area with some margin.
- **DRM/protected video** may capture as a black frame.
- **Restricted pages:** `chrome://` pages, the Chrome Web Store, other extensions’ pages,
  and the built-in PDF viewer may refuse injection by Chrome policy. For local `file://`
  pages, enable **Allow access to file URLs** on the extension’s details page.
- **One region at a time.** There is no batch mode or history.
- **First run is slower** because the ~3.9 MB WASM core and ~4.1 MB language model must
  be initialized; subsequent captures reuse the warm worker.
- **Memory:** the worker is terminated after about five idle minutes; the next capture
  reloads it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Nothing happens when clicking the icon | Make sure the tab is a normal web page and is the active tab. Reload the page after installing or updating the extension. |
| Red `!` badge | Hover the toolbar icon to read the reason. Switch to a normal `http(s)` page; restricted pages are blocked by Chrome. |
| Shortcut does nothing | Assign it at `chrome://extensions/shortcuts`; another application may already own `Alt+Shift+S`. |
| `file://` pages fail | Open the extension’s details and enable **Allow access to file URLs**. |
| “No text detected” | Select a larger area with margins, avoid transparent overlays, or use a cleaner/high-contrast source. Use **Retry**. |
| Copy failed hint | Click **Copy**, or select the text in the panel and press `Ctrl+C`. Some pages restrict script-driven clipboard access. |
| Slow first recognition | Expected while the local engine loads; later captures are much faster. |
| Garbled numbers | Turn on **Numbers only** and re-run; it restricts recognition to digits and common numeric punctuation. |

## Development notes

- No bundler or build step: edit the files and reload the extension at
  `chrome://extensions`.
- `content/overlay.js` is injected on demand, not declared in the manifest. It guards
  against duplicate injection and exposes a single `window.__pixelOcrOverlay` handle so a
  second trigger restarts the flow instead of stacking overlays.
- The overlay is a single host element with an open Shadow DOM, `all: initial`, and
  `z-index: 2147483647`; the page’s styles cannot leak in.
- OCR timeouts are enforced on both sides (client watchdog and service-worker timeout),
  and a timed-out worker is discarded so the next attempt starts clean.
