# Design — TELETEXT LIVES

Covers visual design (brief §4) and the rendering engine spec (brief §6.4).

---

## 1. The grid (non-negotiable)

- Canvas: **40 columns × 24 rows** of character cells, true MODE-7 geometry.
- Stage element: fixed-aspect container with `aspect-ratio: 4/3` (approximately), scales to the viewport, letterboxed on black.
- All layout is done in character cells. Headlines wrap at 40 characters. Tables align by padding. If it doesn't fit the grid, it doesn't ship.
- Text is monospace, one character per cell; no proportional fonts anywhere inside the stage.
- **CRT flavour** (toggleable, default ON): slight scanline overlay + very soft text glow. Must not reduce legibility. Disabled automatically via `prefers-reduced-motion`.

---

## 2. Palette

Exact teletext colours — no substitutions.

| Name | Hex | Primary usage |
|------|-----|---------------|
| Black | `#000000` | Background (default for entire stage) |
| Red | `#FF0000` | Fastext red key, alerts, "LIVE" tag |
| Green | `#00FF00` | Fastext green key, positive market moves |
| Yellow | `#FFFF00` | Fastext yellow key, page headers, highlights |
| Blue | `#0000FF` | Background blocks / banners (white or yellow text on top) |
| Magenta | `#FF00FF` | Fastext-adjacent accents, quiz page |
| Cyan | `#00FFFF` | Fastext cyan key, weather data, links |
| White | `#FFFFFF` | Body text (default) |

Colour is a per-cell attribute: a `<span>` can carry any fg + bg combination (e.g. yellow-on-blue). Flashing text is used **once only**: the "LIVE" tag on p200. Disabled under `prefers-reduced-motion`.

---

## 3. Typography

**Primary font: VT323** (Google Fonts, SIL OFL licence)  
Link in `<head>`:
```html
<link href="https://fonts.googleapis.com/css2?family=VT323&display=swap" rel="stylesheet">
```
VT323 reads immediately as "retro screen text" and requires zero build friction.

**Stretch — Bedstead** (true MODE-7 glyphs, generated from the Mullard SAA5050 character generator, self-hosted as a webfont): implement only if a task slot remains after core pages pass. VT323 is the fallback. Never block the build on Bedstead.

---

## 4. Header row (rows 0–1, every page)

Classic format, white/yellow on black:

```
P100  TELETEXT LIVES   Wed 19 Nov   21:47:32
```

- **Left:** `P` + current page number. When a subpage is active: `P<page> <n>/<total>` (e.g. `P101 2/3`).
- **Centre:** service name `TELETEXT LIVES`.
- **Right:** abbreviated day-of-week + date (e.g. `Wed 19 Nov`), then a live ticking clock `HH:MM:SS` in `Asia/Jakarta` timezone, updated every second.

Row 1 (or the row immediately below): page title in **double-height** text on a blue or black band.

The ticking clock is an iconic teletext feature — do not omit it. The clock update must only touch the time text node, not re-render the page.

---

## 5. Double-height technique

Implement with one of these two approaches — choose one and use it consistently everywhere:

**Option A — CSS transform:**
```css
.double-height {
  display: block;
  transform: scaleY(2);
  transform-origin: top;
  line-height: 1;  /* prevents gap doubling */
}
```
Reserve 2 character-cell rows for a double-height block; the transform fills both rows.

**Option B — font-size:**
```css
.double-height {
  font-size: 200%;
  line-height: 1;
}
```

Pick one in the design spec and apply it everywhere — do not mix the two. The result must visually occupy 2 rows of the grid.

---

## 6. Mosaic graphics

MODE-7 graphics use 2×3 block mosaics per character cell. Implement using Unicode block elements in coloured `<span>` elements:

```
▀ ▄ ▌ ▐ █ ▖ ▗ ▘ ▝ ▚ ▞
```
Plus quadrant blocks (`▙ ▛ ▜ ▟`) where supported.

String-map artworks are defined inline in `app.js`. Required artworks:
- **p100 logo** — "TELETEXT LIVES" masthead mosaic, rows 2–7 (≤ 12 rows max).
- **Weather icons** on p300/301 — sun, cloud, rain/cloud, storm (≤ 12 rows each).
- **Football** on p200 (optional but recommended).
- **Bar charts** on p400 — horizontal bars from `█` characters, length proportional to value.

Each artwork is ≤ 12 rows.

---

## 7. Layout per page type

### Index pages (p100)
- Rows 2–7: masthead mosaic artwork.
- Rows 9–20: index list in two colour-coded groups, page numbers in yellow, page names in white.
- Row 23: fastext bar.

### List pages (p101, p200)
- Rows 2–3: page title (double-height).
- Rows 5–21: one headline per 1–2 rows; story number in cyan; body text in white.
- Row 22: footer hint (e.g. "TAP HEADLINE FOR STORY — TYPE 102+NUM").
- Row 23: fastext bar.

### Detail pages (p102, p300)
- Rows 2–3: double-height headline/city name.
- Rows 4–21: body in white, data values in cyan/yellow; generous blank rows — teletext pages breathe.
- Row 22: data timestamp footer.
- Row 23: fastext bar.

### Table pages (p201, p301, p400)
- Rows 2–3: page title (double-height) on blue background.
- Rows 4–5: column headers in yellow on blue.
- Rows 6–21: data rows, alternating if desired.
- Row 22: footnote (e.g. attribution, rate notice).
- Row 23: fastext bar.

---

## 8. Renderer helper functions

Implement these as pure functions that produce DOM nodes (not raw HTML strings with `innerHTML` on untrusted content).

### `span(text, fg, bg)`
Returns a `<span>` with:
- `textContent` set to `text` (never `innerHTML`).
- CSS classes for `fg-<colour>` and `bg-<colour>` applied from the palette.
- `bg` defaults to `black` if omitted.

### `row(cells)`
Accepts an array of cell descriptors `{ text, fg, bg }` or pre-built span elements.  
Returns a `<div class="row">` containing the spans, padding the row to exactly 40 characters with black-on-black spaces if needed.

### `doubleHeight(text, fg, bg)`
Returns a 2-row block (a `<div>` wrapping two rows, or a single row with the double-height CSS class applied).  
Text must not exceed 40 characters. `fg` defaults to yellow, `bg` defaults to blue.

### `mosaic(artLines, palette)`
Accepts:
- `artLines`: array of strings, each character mapping to a colour key.
- `palette`: object mapping character keys to hex or CSS colour names.

Returns a `<div class="mosaic-block">` with one row per line, one `<span>` per character, using the given colours as `textContent` of Unicode block glyphs.

### Truncation / wrapping utilities
- `truncate(text, maxLen)` — hard-cuts at `maxLen` with `…` appended if truncated.
- `wrapWords(text, maxLen)` — wraps on word boundaries, returns an array of lines each ≤ `maxLen` characters.

Both utilities must respect the 40-column grid.

---

## 9. Clock behaviour

- One `setInterval` at 1000 ms updates the header time text node only.
- Time is formatted `HH:MM:SS` in `Asia/Jakarta` timezone using `Intl.DateTimeFormat` or manual offset calculation.
- The interval is started when the app loads and runs continuously — it is not tied to page lifecycle and is never torn down.
- Clock update does **not** trigger a re-render of any page content.

---

## 10. Per-page timers

| Page | Timer | Interval | Cleanup |
|------|-------|----------|---------|
| p101 | Subpage rotation | 8 s | On navigation away |
| p102 | Subpage rotation (idle mode) | 12 s | On navigation away |
| p200 | Scores block refresh | 5 min | On navigation away |
| p201 | Subpage rotation | 10 s | On navigation away |
| p300 | Subpage rotation | 8 s | On navigation away |
| p301 | Subpage rotation | 8 s | On navigation away |
| p888 | Subtitle line advance | 4 s | On navigation away |

**All per-page timers are cleaned up on navigation** — the router calls a cleanup function before rendering the next page. Rotation pauses entirely when the browser tab is hidden (`visibilitychange` event).

---

## 11. Data flow summary

1. Router reads hash → calls the appropriate page renderer.
2. Page renderer calls the fetch helper for required data.
3. Fetch helper: check localStorage cache → if fresh, return cached payload immediately → schedule background refresh.
4. If cache is stale or empty: attempt network fetch → on success, write to cache, return payload → on failure, return stale cache or null.
5. Page renderer builds the DOM using `row()`, `span()`, `doubleHeight()`, `mosaic()`.
6. All API string values are set via `textContent`.
7. Data timestamp footer is appended (`DATA <HH:MM>` or `DATA FROM CACHE <HH:MM>`).
8. Per-page timers are started.
9. On next navigation: timers are cleaned up → step 1 repeats.
