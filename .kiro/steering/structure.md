# Structure — TELETEXT LIVES

## Repository layout

```
/
├── index.html                 # Single HTML file; the stage div lives here
├── styles.css                 # All visual styling: grid, palette classes, CRT overlay, keypad
├── app.js                     # Entire application: router, renderer, data layer, page modules
├── data/
│   └── sample-data.js         # Labelled fallback samples, quiz question sets, subtitle script
├── assets/                    # Optional: Bedstead webfont files (stretch goal only)
├── .kiro/
│   ├── steering/
│   │   ├── product.md         # What the app is, page map, navigation invariants
│   │   ├── tech.md            # Stack rules, fetch helper, cache TTLs, CORS chains
│   │   └── structure.md       # This file — repo layout and file purposes
│   ├── specs/
│   │   └── teletext-lives/
│   │       ├── requirements.md  # User stories per page with acceptance criteria
│   │       ├── design.md        # Palette, grid geometry, renderer helpers, clock, timers
│   │       └── tasks.md         # Task list T0–T11 in checkbox format
│   └── hooks/                 # Optional: e.g. a README-check pre-commit hook
├── LICENSE                    # MIT licence — must be detectable by GitHub (repo About sidebar)
└── README.md                  # What it is, live URL, how to run locally, data credits, Kiro note
```

## File purposes

### `index.html`
Declares the page shell: `<head>` with VT323 Google Font link and CSS link; a `<div id="stage">` that the renderer populates; the on-screen numeric keypad markup below the stage; `<script>` tags loading `data/sample-data.js` then `app.js`. No inline scripts. No inline styles.

### `styles.css`
- Stage sizing (`aspect-ratio: 4/3`, scales to viewport, letterboxed on black).
- Palette utility classes: `.fg-black`, `.fg-red`, `.fg-green`, `.fg-yellow`, `.fg-blue`, `.fg-magenta`, `.fg-cyan`, `.fg-white` and matching `.bg-*` variants.
- Double-height class (CSS transform or font-size technique — defined once here, used everywhere).
- CRT scanline + text-glow overlay, toggled by `.crt-on` on the stage element (default ON).
- On-screen keypad layout and tap-target sizing.
- `@media (prefers-reduced-motion)` rule that removes the CRT effect and disables flash animations.

### `app.js`
Divided into logical sections (not separate files — one file, zero build):
1. **Constants** — page numbers, city configs, API URLs, TTLs.
2. **Fetch + cache layer** — `fetchJSON`, `fetchText`, localStorage helpers, proxy chain for BBC.
3. **RSS parser** — `parseRSS(xmlText)` using `DOMParser`.
4. **Renderer helpers** — `row()`, `span()`, `doubleHeight()`, `mosaic()`, truncation/wrap utilities.
5. **Header + clock** — renders rows 0–1; runs the 1-second `setInterval` on the time text node only.
6. **Router** — reads `location.hash`, maps to a page renderer, cleans up previous page timers.
7. **Page modules** (one function per page) — `renderPage100()` … `renderPage888()`.
8. **Input system** — keyboard digit entry, fastext key handlers (R/G/Y/C), HOLD, subpage steppers, on-screen keypad event listeners.

### `data/sample-data.js`
Exports (or assigns to `window.SAMPLE_DATA`) three objects:
- `footballSamples` — a realistic results table, **always labelled "SAMPLE DATA — live scores unavailable"** when displayed.
- `quizSets` — 3 sets of 5 questions + answers for p104, rotated by `(dayOfMonth % 3)`.
- `subtitleScript` — array of timed lines for p888's fake documentary.

### `.kiro/`
All Kiro steering files, spec files, and optional hooks. **This directory must never appear in `.gitignore`.** The hackathon rules require `/.kiro` to be present and visible in the public repo. Verify with `git status` before the first push and again before submission.

### `LICENSE`
MIT licence text. Must be present so GitHub detects the licence and shows it in the repo's About sidebar — a hard rule requirement.

### `README.md`
- One-paragraph description of what TELETEXT LIVES is.
- Live GitHub Pages URL.
- How to run locally (serve over HTTP — `python3 -m http.server` or equivalent; `file://` breaks fetch/CORS).
- Data-source credits and licence attributions (Open-Meteo CC BY 4.0, BBC RSS, Frankfurter, ExchangeRate-API attribution link).
- "Built with Kiro for Kiroween 2026" note.
- MIT licence note.
- Screenshots (index + weather + markets) — added in task T11.

## Rules constraint

`.kiro/` is **never gitignored**. If `.gitignore` was generated from a template that excludes it, remove that line before the first push. Run `git status` to confirm `.kiro/` appears as tracked.
