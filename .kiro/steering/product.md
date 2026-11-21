# Product — TELETEXT LIVES

## What it is

TELETEXT LIVES is a browser-based recreation of classic broadcast teletext (Ceefax / ORF TELETEXT style). The user types a 3-digit page number — exactly like a TV remote — and sees a faithful 40-column × 24-row MODE-7 grid: black background, 8 colours, double-height headers, mosaic block graphics, a ticking clock in the header. Every page is powered by live 2026 data from free, keyless public APIs.

The dead medium is alive because the data is.

**Category:** Kiroween 2026 — Resurrection  
**Default locale:** Indonesia. Weather defaults to Jakarta (lat −6.2088, lon 106.8456, timezone `Asia/Jakarta`). Markets lead with IDR. City index highlights Indonesian cities.  
**UI language:** English (all on-screen labels and navigation text are in English; Indonesian place names appear as-is).

---

## Page map

Every page is a 40 × 24 teletext screen. Typing the page number (or tapping index entries) navigates instantly. Unlisted numbers in a valid range show the classic "Page not found" screen with a pointer back to 100.

| Page | Name | Content | Data source | Rotation |
|------|------|---------|-------------|----------|
| **100** | INDEX | MODE-7 mosaic logo, today's date, headline of the hour, master index list (101 · 200 · 300 · 400 · 104 · 500 · 888), fastext bar | BBC top story headline + local clock | — |
| **101** | NEWS HEADLINES | Numbered list of ~12 latest headlines (BBC Top + World + Asia, newest first). Each line references "see 102". | BBC RSS (top/world/Asia feeds) via CORS proxy | Auto-rotate: subpages `101/2`, `101/3` every **8 s** when list overflows |
| **102** | NEWS STORY | One story per screen: double-height headline, RSS description snippet, source + timestamp, "Full story: bbc.com/…" link. Story selected from p101 (tap or `102`+digit). | BBC RSS item detail (same cached feed) | Subpage per story `102 1/12`…; rotation **OFF** by default; auto-rotate at 12 s in idle mode |
| **104** | QUIZ | 5 general-knowledge questions; answers hidden behind REVEAL (black-on-black until revealed). HOLD freezes page. Bundled content, no API. | Bundled content (3 sets rotated by day-of-month) | Reveal per question |
| **200** | SPORT | Football headlines (BBC Sport RSS) + "LATEST SCORES" block (ESPN → OpenLigaDB → labelled SAMPLE). Index line to 201. | BBC Sport/Football RSS via proxy; ESPN scoreboard; sample fallback | Scores block refreshes every **5 min** while page is open |
| **201** | FOOTBALL SCORES | Full-page results/fixtures table: ENG/ESP/ITA/GER/UCL + IDN if available. Columns: team, score, minute/status (FT, 67', 20:00). | ESPN scoreboard per league; sample fallback labelled "SAMPLE DATA — live scores unavailable" | One subpage per league, rotate every **10 s** |
| **300** | WEATHER — INDONESIA | Jakarta now: temperature, condition, feels-like, humidity, wind. Today + 7-day outlook. Rotating Indonesian cities: Surabaya, Bandung, Medan, Yogyakarta, Semarang, Denpasar (Bali), Makassar, Palembang, Balikpapan. | Open-Meteo forecast (one call per city, cached 30 min) | Subpage per city group, rotate every **8 s** |
| **301** | WEATHER — WORLD | World cities grid: Singapore, Kuala Lumpur, Bangkok, Tokyo, Sydney, London, New York, Dubai, Amsterdam, Seoul — current temp + condition + local time. | Open-Meteo (multi-location) + fixed geocoding config | 2 subpages, rotate every **8 s** |
| **302** | WEATHER — CITY SEARCH *(stretch)* | On-screen prompt "Type a city name"; results from Open-Meteo Geocoding, then forecast in 300-style layout. Only if task budget remains after core pages pass. | Open-Meteo Geocoding + Forecast | — |
| **400** | MARKETS / CURRENCY | "1 unit → IDR" table: USD, EUR, SGD, JPY, GBP, AUD, CNY, MYR, THB, KRW. Change vs yesterday where API allows. Footer: "Reference rates — updated daily. Not trading prices." + required attributions. Optional BTC/ETH row labelled clearly. | Frankfurter v2 (primary) → open.er-api (fallback) → yesterday's cache | — (refresh on open if cache stale) |
| **500** | ABOUT / HELP | What teletext was (3 short paragraphs), how to use the app, full data-source credits + licences, "Built with Kiro for Kiroween 2026", MIT licence note. | Static | 2 subpages: about / credits |
| **888** | SUBTITLES | Fake "live subtitled broadcast" of an imaginary nature documentary. Straight-faced header "SUBTITLES — ENGLISH 888". Ends with one line about teletext accessibility. Affectionate, not mocking. | Bundled script | Lines advance every **4 s**, loop |

---

## Navigation invariants

- Every page carries the header row (rows 0–1) and the fastext bar (row 23).
- Every page is reachable by typing its number.
- The index (p100) lists all pages.
- `100` is always Home.
- Typing any 3-digit number navigates instantly on the third digit, exactly like a TV remote.
- The URL hash encodes the current page (`#300`, `#102/3`) so pages are shareable and browser Back/Forward works.
- Fastext defaults: 🔴 Red → 101 NEWS · 🟢 Green → 200 SPORT · 🟡 Yellow → 300 WEATHER · 🔵 Cyan → 400 MARKETS.
