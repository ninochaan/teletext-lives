# Tech — TELETEXT LIVES

## Stack

**Vanilla HTML/CSS/JS only. No build step. No framework. No npm.**

- `index.html` + `styles.css` + `app.js` + `data/sample-data.js` — that is the entire application.
- GitHub Pages serves it as-is from the repo root.
- No bundler, no transpiler, no package.json. This is deliberate: nothing to break at deploy time.

## Single-page app / router

- One `<div id="stage">` element is re-rendered per page.
- Routing is keyed by the URL hash: `#100`, `#101`, `#102/3`, `#300`, etc.
- Hash format for subpages: `#<page>/<subpage>` e.g. `#102/3`.
- Pages are shareable and deep-linkable. Browser Back/Forward must work.
- Hash routing only — never path routing (avoids GitHub Pages 404 on deep links).

## Grid

- **40 columns × 24 rows** of character cells (true MODE-7 geometry).
- Fixed-aspect stage (`aspect-ratio: 4/3`), scales to viewport, letterboxed on black.
- All layout is in character cells. Headlines wrap at 40 chars. Tables align by padding.
- Text is monospace, one character per cell; no proportional fonts inside the stage.

## Fetch helper

A single `fetchJSON` / `fetchText` helper with:
- **6-second timeout** via `AbortController`.
- **One retry** after timeout/network failure.
- **localStorage cache** keyed by URL, storing `{ fetchedAt, payload }`.

### Cache TTLs

| Source | TTL |
|--------|-----|
| Weather (Open-Meteo) | **30 min** |
| News RSS (BBC) | **10 min** |
| Currency (Frankfurter / open.er-api) | **6 h** |
| Scores (ESPN / OpenLigaDB) | **5 min** |

Cache-first rendering: render cached data immediately, refresh in background, re-render if fresher data arrives (stale-while-revalidate). The app must never show a blank stage — with cache or sample data, every page renders.

## RSS parsing

Parse BBC RSS with `DOMParser` using `text/xml` in the browser — no library.

## Text safety

All API-supplied strings are inserted via `textContent`, never `innerHTML` with raw feed data. RSS is third-party content.

## HTTP requests

All fetches are plain GETs with no custom headers (avoids CORS preflight; several proxies reject custom headers).

## CORS proxy chain — BBC RSS

`feeds.bbci.co.uk` sends no `Access-Control-Allow-Origin` header. All BBC RSS fetches go through this chain in order, each with a **5-second timeout**:

1. `https://api.allorigins.win/raw?url=<encoded>` — returns raw XML
2. `https://api.allorigins.win/get?url=<encoded>` — returns JSON; unwrap `.contents`
3. `https://corsproxy.io/?url=<encoded>`
4. **Cache** — serve the last cached payload regardless of age
5. **Honest error page** — in-universe `SERVICE TEMPORARILY UNAVAILABLE — PLEASE TRY LATER` with a RETRY fastext link

Treat public proxies as unreliable by design and engineer accordingly.

## CORS status per source

| Source | CORS | Fetch strategy |
|--------|------|----------------|
| Open-Meteo (forecast + geocoding) | ✅ `ACAO: *` | Direct |
| Frankfurter v2 (`api.frankfurter.dev/v2`) | ⚠️ Undocumented — test first | Direct; if blocked → v1 host; if still blocked → open.er-api |
| open.er-api.com | ✅ Enabled | Direct |
| ESPN `site.api.espn.com` scoreboard | ✅ Works in practice (unofficial) | Direct; any failure → fallback chain (OpenLigaDB → labelled SAMPLE) |
| OpenLigaDB | ✅ Enabled | Direct |
| BBC RSS (all feeds) | ❌ No CORS header | Proxy chain above |

## Loading and error states (in-universe)

- While fetching: header clock keeps ticking; page area shows `P300 …searching` / a blinking cursor block. No modern spinners.
- On failure with cache: show cached data + yellow footer `DATA FROM CACHE — HH:MM`.
- On failure without cache: show honestly-labelled bundled sample where the brief permits it; for news/weather show the in-universe error page. A broken-looking page is worse than an honest teletext error page.

## Clock

One `setInterval` (1 s) updates only the header time text node — no full re-render on each tick.

## Per-page timers

Subpage rotation timers and score-refresh timers are created per-page and **cleaned up on navigation**. Rotation pauses when the tab is hidden (`visibilitychange` event).

## Rendering helpers

Implement as pure functions that produce DOM (not template strings with `innerHTML` on untrusted data):

- `row(cells)` — builds one 40-col row from an array of cell descriptors
- `span(text, fg, bg)` — produces a cell span with the given foreground/background colour
- `doubleHeight(text, fg, bg)` — produces a 2-row block for double-height headers
- `mosaic(artLines, palette)` — renders a Unicode block-element artwork from a string-map

One renderer function, used by all pages.

## Accessibility

- Respect `prefers-reduced-motion`: disable flashing text and CRT effects when the user has requested reduced motion.
- The one permitted flashing element is the "LIVE" tag on p200.
