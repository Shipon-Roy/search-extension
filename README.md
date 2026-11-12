# ShiponLens — Select, Copy & Look Up

A fully offline Chrome extension (Manifest V3) that turns any part of a webpage into
editable, copyable text, then turns the detected value into a lookup link you control.

Drag a rectangle over the screen and the pixels inside it are recognized locally with a
bundled Tesseract.js engine. The result panel keeps the text editable, copies it
automatically, and offers configurable type chips (for example **Parcel ID**,
**Merchant ID**, **Phone number**) that build a URL from *your* saved link template and
open it in a new tab.

No account, no network requests, no cloud OCR, no API keys. The recognition engine,
WASM build, and English language data all ship inside this folder. Opening a lookup link
is the only action that uses the network, and it only happens when you click
**Open in new tab** (or press `Enter`).

## Features

### Capture and OCR

- Drag a rectangle in any direction; the selection is clamped to the visible viewport.
- Works on ordinary pages, text inside images and canvases, playing videos, and
  cross-origin iframes — because it recognizes the rendered pixels, not the DOM.
- Editable result panel with **Copy**, **Retry**, and **Close (X)**; `Esc` also closes.
- Recognized text is copied automatically, with a visible “Copied ✓” confirmation. If
  the browser blocks clipboard access, a non-blocking hint offers the Copy button.
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

### Lookup links

- A wrapping row of type chips built from your saved types, in your saved order. The
  shipped defaults are **Parcel ID**, **Merchant ID**, and **Phone number**.
- The last used type is remembered and preselected on the next capture. If it was
  deleted, the first type is used. If the edited text looks like a Bangladeshi mobile
  number, the first type whose cleaning mode is **Phone** is preselected instead — but
  nothing ever opens automatically.
- **Open in new tab** is the primary button. `Enter` (without Shift) in the textarea
  does the same; `Shift+Enter` still inserts a newline. Opening a link keeps the panel
  open so you can retry with another type.
- If the chosen template is still an `example.com` placeholder or is empty, the panel
  says **Set your link in Options**.
- Changes saved in Options appear in an already-open panel through
  `chrome.storage.onChanged`; no extension reload is needed.
- If no types exist, the panel says **Add a type in Options** and disables opening.

## Requirements

- Google Chrome 116 or newer (the extension uses `chrome.runtime.getContexts`).
- English language data only (bundled).
- About 8 MB of disk space; no internet connection at runtime except for the lookup
  page you explicitly open.

## Install (unpacked)

1. Keep the folder structure intact — `manifest.json` must sit at the folder root.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
5. Optionally click the puzzle-piece icon and pin **ShiponLens** to the toolbar.

### Shortcut

The default shortcut is **`Alt+Shift+S`**. If it is already taken by another app or
extension, Chrome leaves it unassigned; set your own at
`chrome://extensions/shortcuts` → **ShiponLens** → **Select an area and OCR it**.

### Opening Options

Use any of these:

- the **⚙** button in the result panel, or **Edit types** in the lookup section;
- right-click the toolbar icon → **Options**;
- `chrome://extensions` → **ShiponLens** → **Details** → **Extension options**.

## Use

### Capture

1. Open a normal `http://` or `https://` page.
2. Click the ShiponLens toolbar icon, or press `Alt+Shift+S`.
3. Drag a rectangle around the text. The area outside the selection dims and a live
   pixel-size label appears.
4. Release the mouse. The overlay disappears, the screen is captured, and the result
   panel opens. The first run loads the engine (a few seconds); later runs are faster.
5. Edit the text if needed, then use **Copy**, **Retry** (select again), **Numbers only**,
   or **Close**. Pressing `Esc` at any time cancels and removes the overlay.

Selecting a region smaller than 5 × 5 CSS pixels is ignored; drag a larger area. While
the overlay is open, triggering the extension again cancels the current session and
starts a fresh selection.

### Look up the value

1. After OCR, pick the matching chip.
2. Edit the textarea if OCR misread a character; the warning line under the chips updates
   immediately.
3. Click **Open in new tab**, or press `Enter` in the textarea.
4. The link opens in a foreground tab and the panel stays available.

The extension never opens links on its own. Only the saved template decides the
destination; OCR text is inserted as a URL-encoded value and can never change the
scheme, host, or path.

## ShiponLens ControlBoard and cleaning

Each type has a **name** (max 24 characters, required, unique), a **link template**, and a
**cleaning mode**.

### Link templates

- Put `{value}` anywhere: `https://example.com/merchant?id={value}`.
- Or omit it and the cleaned value is appended:
  `https://example.com/parcel/` + `ABC123` → `https://example.com/parcel/ABC123`.
- Templates must be absolute URLs starting with `https://`. `http://` is allowed only
  for localhost (`localhost`, `127.0.0.1`, `::1`, `*.localhost`). Spaces, non-URL text,
  and other schemes (`javascript:`, `data:`, `file:`, etc.) are rejected with an inline
  error.
- The value is always encoded with `encodeURIComponent` before insertion.
- The three shipped templates point at `example.com` and are deliberately marked as
  examples. Replace them with your real links; until you do, the panel shows
  **Set your link in Options**.

### Cleaning modes

| Mode | What it does |
| --- | --- |
| **ID** | Trim, use the first non-empty line, remove all whitespace, keep only `A-Z a-z 0-9 - _`. If there is more than one line, the panel shows **Using first value**. |
| **Phone** | Convert Bengali digits `০–৯` to English, keep a leading `+`, strip spaces/dashes/brackets/dots, normalize `+8801XXXXXXXXX` and `8801XXXXXXXXX` to `01XXXXXXXXX`. If the result is not a valid BD mobile (`01[3-9]` + 8 digits), opening is still allowed but the panel warns **Doesn't look like a valid BD number**. |
| **Raw text** | Trim outer whitespace only; everything else is kept. |

Cleaning always runs on the **edited textarea text**, and the service worker cleans the
value again from its own copy of the saved template before opening anything.

## Options page

The Options page lists every type as an editable row: name, link template, cleaning mode,
and actions. It supports:

- **+ Add type** — adds an empty row using the `ID` mode.
- **↑ / ↓** — reorder rows; this is the chip order.
- **Delete** — click once, then **Confirm** within four seconds.
- **Test** — validates the row and opens the template with the sample value `TEST123` in
  a new tab.
- **Save** — validates every row and persists the list. `Ctrl/Cmd+S` also saves.
- **Reset to defaults** — asks for confirmation, restores the three example types, and
  saves immediately.

Validation rules: unique names, at most 24 characters per name, at most 100 types, and
valid `https://` (or localhost `http://`) templates up to 2,048 characters. Invalid rows
get an inline message and are not saved. The page fits at least 20 rows without
horizontal scrolling and follows light/dark mode.

### Storage

Types are stored under `pixelOcrTypes` and the last chip under `pixelOcrLastTypeId` in
`chrome.storage.sync`. If sync is unavailable or rejects the write (for example, the
per-item quota is exceeded by many long templates), the extension removes the stale sync
copy and falls back to `chrome.storage.local`. Reads check sync first, then local, so the
same data is used by the panel, the Options page, and the service worker.

## How it works

```
toolbar click / Alt+Shift+S
        │
        ▼
background.js (service worker)
  ├─ rejects chrome://, Web Store, other extension pages → badge + tooltip
  ├─ injects lib/links.js + content/overlay.js via chrome.scripting.executeScript
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
  ├─ chips + warning notices from saved types
  ├─ auto-copy via navigator.clipboard, with execCommand fallback
  └─ removes all DOM and listeners on close

“Open in new tab” / Enter
        │
        ▼
background.js
  ├─ reloads the saved types (the panel never sends a URL)
  ├─ finds the type by id, cleans the edited value, rebuilds the URL
  ├─ rejects missing types, empty values, and non-http(s) results
  └─ chrome.tabs.create({ url, active: true })
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

### Lookup security model

- OCR text is only ever a **value**, never a URL. The service worker reloads the saved
  type by id and rebuilds the link from the stored template.
- The cleaned value is URL-encoded before insertion.
- The rebuilt URL is parsed and must have the `https:` or `http:` scheme; anything else
  is rejected. Templates themselves are validated when saved.
- All UI text uses `textContent`/`value`; OCR output is never inserted as HTML.

## Permissions

| Permission | Why it is needed | What it does **not** allow |
| --- | --- | --- |
| `activeTab` | Grants temporary access to the current tab only after you click the icon or press the shortcut. Needed to inject the overlay and call `captureVisibleTab`. | No persistent access to any site; no `<all_urls>` host permission. The grant ends on navigation or tab close. |
| `scripting` | Runs the on-demand overlay script in the active tab. | Does not read page content by itself. |
| `offscreen` | Creates the hidden document that hosts the local Tesseract.js worker. | No network access; assets are extension-local. |
| `storage` | Saves your ShiponLens ControlBoard and the last-used chip. | No access to page data, cookies, or history. |

Also relevant:

- **No `host_permissions`** and no content scripts registered at install time.
- **No `tabs` permission.** `chrome.tabs.create({ url })` does not require it.
- **No `clipboardWrite` permission.** Copying happens in the page context through the
  Clipboard API, with a hidden-textarea + `execCommand('copy')` fallback.
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
├── background.js              # triggers, capture, crop, lookup opening, offscreen lifecycle
├── content/
│   └── overlay.js             # selection UI + result panel (Shadow DOM)
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js           # preprocessing + Tesseract worker
├── options/
│   ├── options.html           # editable lookup-type rows
│   ├── options.css
│   └── options.js
├── lib/
│   ├── links.js               # shared cleaning, URL building, validation, storage
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
├── test/
│   └── links.test.js          # plain Node unit tests, no framework
└── README.md
```

There is no build step. Every file is plain JavaScript, HTML, CSS, or a static asset.

## Verification

The extension was exercised end-to-end in Chrome for Testing **157.0.8103.50** with
Puppeteer, driving real pointer selections against local fixtures, plus plain Node unit
tests for the shared link logic. **95/95 checks passed** across the final runs:

| Suite | Checks | Result |
| --- | --- | --- |
| `node test/links.test.js` (unit) | 19 | 19/19 |
| Lookup chips, open, Enter, live storage updates | 26 | 26/26 |
| Options persistence, reorder, reset, restart | 13 | 13/13 |
| OCR, scaling, cleanup, restricted pages, offline | 28 | 28/28 |
| Direct image, fallback storage, 20 types, long URL, empty state | 9 | 9/9 |

> **Note:** the in-panel link preview and the **Export JSON** / **Import JSON** options
> were removed after this run, so a few of the checks above no longer apply to the
> current build.

Highlights:

- **Recognition:** normal paragraphs (line breaks preserved), white-on-dark text via
  automatic inversion, digits inside a canvas, text over a playing video frame, text
  inside an iframe, an image opened directly in a tab, and a “Numbers only” re-run using
  the same capture.
- **Scaling:** device pixel ratios 1 / 1.25 / 1.5 / 2 (display scaling 100 / 125 / 150 /
  200%) and browser zoom 80 / 100 / 150%. Crops aligned at every combination tested.
- **Selection behavior:** any drag direction, clamping at viewport edges, 5 × 5 px
  minimum, `Esc` during selection/OCR, duplicate trigger while active, and the result
  panel staying fully inside the viewport near the bottom-right corner.
- **Cleanup:** 21 consecutive captures with no leftover overlay nodes, no DOM growth, and
  bounded JS heap. The overlay was absent from the captured screenshot (sampled pixels
  were pure white).
- **Offline:** the engine cold-started with the tab in offline mode; all extension assets
  loaded from `chrome-extension://` (or local `data:`/`blob:`) resources — no external
  traffic. Opening a lookup link is the only network action and is always user-initiated.
- **Failure path:** a `chrome://extensions` tab produced the red `!` badge and the
  tooltip “Chrome does not allow extensions to run on chrome:// pages.”
- **Lookup acceptance:** with test templates `https://x.test/parcel/`,
  `https://x.test/merchant?id={value}`, and `https://x.test/phone/`, the three defaults
  opened `https://x.test/parcel/ABC123`, `https://x.test/merchant?id=M-77`, and
  `https://x.test/phone/01712345678` in foreground tabs. The panel stayed open each time.
- **Phone cleaning:** `+880 1712-345678`, `8801712345678`, and `০১৭১২৩৪৫৬৭৮` all became
  `01712345678`. Non-BD input warned but remained openable.
- **Editing and warnings:** empty or whitespace-only text disabled the button. Multi-line
  ID text used the first value and
  showed **Using first value**. Placeholder templates showed **Set your link in Options**.
- **Options:** adding **Order ID** while the panel was open made the chip appear without
  a reload; it opened `https://x.test/order/ORD-9`, could be renamed, reordered, tested,
  and deleted. Duplicate names and non-localhost `http://` templates were rejected with
  inline errors without overwriting saved data.
- **Persistence and fallback:** types survived a full Chrome restart. Twenty long
  templates that exceeded the sync quota were saved to `chrome.storage.local`, loaded
  back correctly, and rendered as 20 wrapping chips without horizontal overflow; the
  Options page also fit 20 rows.
- **No console errors** were found in the page, offscreen document, Options page, or
  service worker during the final runs. (The service worker records its own errors to
  `chrome.storage.session` for the harness, because attaching Network/Runtime CDP to the
  MV3 worker closes it in this Chrome build.)
- **Manifest:** production permissions are exactly `activeTab`, `scripting`, `offscreen`,
  and `storage`, with no host permissions; `chrome.commands.getAll()` reports
  `capture-region` → `Alt+Shift+S`.

### Known testing limitations

- The automated harness injects the overlay through a test-only copy of the extension
  that adds `<all_urls>`. The shipped manifest does not contain it. Chrome’s toolbar and
  browser-level shortcut handling cannot be clicked from Puppeteer, and synthetic key
  events do not invoke extension commands, so the real toolbar-click / `activeTab` grant
  path was verified by manifest inspection and command registration rather than by an
  automated click. A quick manual click of the pinned icon is recommended after
  installation.
- The five-minute idle auto-close was not waited out in the final automated run; the
  close path itself was exercised directly. Both the background timer and the offscreen
  document’s idle timer use the same five-minute constant.
- The video fixture uses a text caption track rendered over a playing video, not OCR of
  text baked into the video frames. Recognition operates on whatever pixels are visible,
  so both cases use the same path.
- Test lookup links use the reserved `x.test` domain. Tabs and exact URLs were verified,
  but the pages themselves do not resolve; that is expected.

## Privacy

Captured pixels are held in memory only long enough to crop and recognize them. The
service worker, offscreen document, and content script never send data off the device.
There is no analytics, telemetry, remote configuration, or update fetch. The extension
contains no remote code and does not use `eval` on strings. ShiponLens ControlBoard stay in Chrome’s
extension storage.

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
- **Lookup links need internet** and a reachable host. The extension does not probe or
  validate the destination beyond URL syntax and scheme.
- **Phone normalization is Bangladeshi-specific.** Other numbers are cleaned but warned
  about rather than reformatted.

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
| “Set your link in Options” | The selected type still uses an `example.com` example template or has none. Open Options and replace it with your real `https://` URL. |
| “Add a type in Options” | All ShiponLens ControlBoard were deleted. Add one in Options; the panel updates on its own. |
| “Using first value” | The textarea has multiple lines and the ID mode uses the first one. Edit the text if the wrong value was chosen. |
| “Doesn't look like a valid BD number” | The Phone mode could not normalize the value to `01[3-9]` + 8 digits. You can still open it, or correct the text. |
| Open button disabled / no warning shown | The cleaned value is empty, no type is selected, or the template is invalid. Check the textarea and Options. |
| “That lookup type no longer exists” | The type was deleted after the panel loaded. Pick another chip or reopen Options. |
| Saved types disappear or fall back | Sync may be disabled or over quota; the extension then uses local storage. Re-enter the types in Options. |

## Development notes

- No bundler or build step: edit the files and reload the extension at
  `chrome://extensions`.
- Run the unit tests with plain Node (no packages needed):

  ```powershell
  node test/links.test.js
  ```

- `lib/links.js` is the single source of truth for cleaning, URL building, template
  validation, and storage. It is loaded by `importScripts` in
  the service worker, injected before `content/overlay.js`, loaded by the Options page,
  and required by the Node tests.
- `content/overlay.js` is injected on demand, not declared in the manifest. It guards
  against duplicate injection and exposes a single `window.__pixelOcrOverlay` handle so a
  second trigger restarts the flow instead of stacking overlays.
- The overlay is a single host element with an open Shadow DOM, `all: initial`, and
  `z-index: 2147483647`; the page’s styles cannot leak in.
- OCR timeouts are enforced on both sides (client watchdog and service-worker timeout),
  and a timed-out worker is discarded so the next attempt starts clean.
- The background never accepts a URL from the panel. It reloads the saved
  type, cleans the value, rebuilds the link, and validates the scheme before calling
  `chrome.tabs.create`.
