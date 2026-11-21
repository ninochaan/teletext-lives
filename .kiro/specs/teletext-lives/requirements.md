# Requirements — TELETEXT LIVES

User stories and acceptance criteria per page, derived from brief sections 3 and 5.

---

## Global / cross-page requirements

**US-G1: Page number entry**  
As a user, I want to type a 3-digit page number and be taken to that page instantly on the third digit, so navigation feels like using a TV remote.

Acceptance criteria:
- Typing digits `0–9` from anywhere starts entry; the header shows `P1__` → `P10_` → navigates on the third digit.
- `Backspace` corrects the last digit; `Esc` cancels entry.
- `0` alone does nothing until 3 digits are entered.
- Entry works from both keyboard and the on-screen numeric keypad.
- An unknown but valid 3-digit number shows the "Page not found" screen with a pointer back to 100.

**US-G2: On-screen keypad (mobile)**  
As a mobile user, I want a remote-control style numeric pad below the stage, so I can navigate without a physical keyboard.

Acceptance criteria:
- Keypad shows digits 0–9, a backspace key (⌫), and a `100` home button.
- Keys have large tap targets; the stage remains fully usable on a phone in portrait orientation.
- Keypad behaviour is identical to keyboard entry.

**US-G3: Fastext bar**  
As a user, I want four colour-coded quick-link keys at the bottom of every page, so I can jump to the main sections without typing.

Acceptance criteria:
- Row 23 always shows: 🔴 Red → 101 NEWS · 🟢 Green → 200 SPORT · 🟡 Yellow → 300 WEATHER · 🔵 Cyan → 400 MARKETS (context-aware overrides allowed per page).
- Keyboard keys `R`, `G`, `Y`, `C` trigger the corresponding fastext link.
- On touch screens the fastext links are large tap targets.
- Rendered as coloured text blocks (not emoji), teletext style.

**US-G4: Hash-based navigation and browser history**  
As a user, I want browser Back/Forward to work and page URLs to be shareable, so I can link directly to a page.

Acceptance criteria:
- The URL hash encodes the current page: `#300`, `#102/3`, etc.
- Navigating to `…/#300` from a fresh browser tab opens p300 directly.
- Browser Back/Forward moves between visited pages.

**US-G5: Header row**  
As a user, I want to see the current page number, service name, date, and a live ticking clock on every page.

Acceptance criteria:
- Rows 0–1 of every page show: `P<number>  TELETEXT LIVES  <day> <date>  <HH:MM:SS>`.
- The clock updates every second (`Asia/Jakarta` timezone).
- When a subpage is active, the header shows `<page> <n>/<total>`.
- The clock update does not re-render the whole page — only the time text node.

**US-G6: HOLD**  
As a user, I want to freeze a rotating page with a HOLD button, so I can read it without it advancing.

Acceptance criteria:
- An on-screen HOLD button and the `H` key both freeze subpage rotation.
- Pressing again releases the hold.
- The header or page shows a visual HOLD indicator while frozen.

**US-G7: Subpage steppers**  
As a user, I want ◀ ▶ buttons and arrow keys to step through subpages manually.

Acceptance criteria:
- ◀ ▶ on-screen and left/right arrow keys step subpages.
- Manual stepping pauses auto-rotation for 30 seconds.

**US-G8: Loading state**  
As a user, I want to see a classic teletext "searching" indicator while data loads, not a modern spinner.

Acceptance criteria:
- While fetching: header clock continues ticking; page area shows `P<n> …searching` or a blinking cursor block.
- No CSS spinner or progress bar.

**US-G9: Offline / cache fallback**  
As a user, I want every page to show something useful even when my network is unavailable.

Acceptance criteria:
- Cached data is rendered immediately; a background refresh replaces it if fresher data arrives.
- If cache exists but fetch fails, cached data is displayed with a yellow footer `DATA FROM CACHE — HH:MM`.
- If no cache and fetch fails: show honestly-labelled bundled sample where the brief permits, or the in-universe error page `SERVICE TEMPORARILY UNAVAILABLE — PLEASE TRY LATER` with a RETRY fastext link.
- The stage is never blank.

**US-G10: Accessibility — reduced motion**  
As a user with reduced-motion preference, I want flashing text and CRT effects disabled automatically.

Acceptance criteria:
- When `prefers-reduced-motion` is set, flashing text (including the "LIVE" tag) and CRT scanline/glow effects are disabled.
- Legibility is unaffected by the CRT overlay regardless of display.

---

## Page 100 — INDEX

**US-100-1:** As a user opening the app, I want to see a home index page with the teletext logo, today's headline, and a list of all pages, so I can orient myself.

Acceptance criteria:
- Displays a MODE-7 mosaic logo "TELETEXT LIVES" in rows 2–7.
- Shows today's date and the headline of the hour from BBC top stories (headline text only).
- Lists all main pages: News 101 · Sport 200 · Weather 300 · Markets 400 · Quiz 104 · About 500 · Subtitles 888.
- All index entries are tappable/clickable and navigate to the target page.
- Header and fastext bar are present.

---

## Page 101 — NEWS HEADLINES

**US-101-1:** As a user, I want to see a numbered list of the latest ~12 headlines from BBC News, so I can scan current stories.

Acceptance criteria:
- Displays up to ~12 headlines from BBC Top Stories + World + Asia RSS feeds, newest first.
- Each headline shows a story number (e.g. "1.") and a "see 102" reference.
- If the list exceeds one screen, it auto-rotates through subpages 101/2, 101/3 every 8 seconds.
- HOLD freezes rotation; ◀ ▶ step manually.
- Data is sourced via the BBC RSS CORS proxy chain; cache TTL is 10 min.
- A `DATA <HH:MM>` or `DATA FROM CACHE <HH:MM>` footer is shown.

**US-101-2:** As a user, I want to tap a headline to read the full story, so I can get the detail without typing.

Acceptance criteria:
- Tapping a headline navigates to the corresponding subpage of p102.
- Typing `102` + the story number digit navigates to that story.

---

## Page 102 — NEWS STORY

**US-102-1:** As a user, I want to read the detail of one news story on a full page, so I can follow the story.

Acceptance criteria:
- Shows one story per screen: headline in double-height text, RSS description snippet, source, timestamp, and "Full story: bbc.com/…" link.
- Story is selected from the p101 cached feed — no extra fetch.
- Header shows subpage counter `102 <n>/<total>`.
- Auto-rotation is OFF by default; activates at 12-second idle interval if idle mode is enabled.
- ◀ ▶ or arrow keys step between stories.
- Story link is rendered as tappable/clickable text.
- BBC attribution is visible on the page.

---

## Page 104 — QUIZ

**US-104-1:** As a user, I want to answer teletext-style general-knowledge questions with hidden answers that I reveal myself.

Acceptance criteria:
- Shows 5 questions; answer text is hidden (black-on-black) until revealed.
- A per-question REVEAL button (and `V` key) reveals the answer for that question only.
- HOLD button / `H` key freezes the page.
- 3 question sets bundled; set selected by `dayOfMonth % 3`.
- No external API call; content is entirely from `data/sample-data.js`.

---

## Page 200 — SPORT

**US-200-1:** As a user, I want to see football headlines and a latest-scores block on one page.

Acceptance criteria:
- Displays football headlines from BBC Sport + Football RSS (via proxy chain).
- Displays a "LATEST SCORES" block sourced from: ESPN scoreboard (primary, experimental) → OpenLigaDB (fallback, Bundesliga only) → labelled SAMPLE DATA.
- When sample data is shown it is **always labelled on-screen "SAMPLE DATA — live scores unavailable"**. Sample data is never presented as live.
- An index line to p201 is visible.
- A "LIVE" tag is present on the page; it flashes (disabled under `prefers-reduced-motion`).
- Scores block refreshes every 5 minutes while the page is open; refresh timer is cleaned up on navigation.

---

## Page 201 — FOOTBALL SCORES

**US-201-1:** As a user, I want a full-page table of results and fixtures across the main leagues.

Acceptance criteria:
- Displays one league per subpage: ENG, ESP, ITA, GER, UCL, and IDN (Indonesia Liga 1) if data is available.
- Each row shows: team name, score, and status (FT / live minute / scheduled time).
- Subpages rotate every 10 seconds; HOLD and ◀ ▶ work.
- If ESPN scoreboard is unavailable, OpenLigaDB Bundesliga data is used for the GER subpage.
- If neither live source is available, sample data is shown with the on-screen label "SAMPLE DATA — live scores unavailable".

---

## Page 300 — WEATHER — INDONESIA

**US-300-1:** As a user, I want to see the current Jakarta weather and a 7-day outlook when I open the weather page.

Acceptance criteria:
- Jakarta subpage shows: temperature (°C), condition, feels-like, relative humidity, wind speed and direction.
- 7-day outlook table shows: day, weather code/condition, max/min temperature, precipitation probability.
- Data sourced from Open-Meteo forecast API (lat −6.2088, lon 106.8456, timezone `Asia/Jakarta`).
- Cache TTL is 30 minutes.
- Footer shows "Weather data by Open-Meteo.com" (CC BY 4.0 attribution).

**US-300-2:** As a user, I want rotating subpages for other Indonesian cities, so I can check weather across the country.

Acceptance criteria:
- Cities in rotation: Surabaya, Bandung, Medan, Yogyakarta, Semarang, Denpasar (Bali), Makassar, Palembang, Balikpapan.
- Subpages rotate every 8 seconds; HOLD and ◀ ▶ work.
- Each city shows the same current-conditions layout as Jakarta.
- Each city's data is cached separately with a 30-minute TTL.
- Mosaic weather icons (sun, cloud, rain) are displayed where possible.

---

## Page 301 — WEATHER — WORLD

**US-301-1:** As a user, I want a world cities weather grid showing current conditions and local time.

Acceptance criteria:
- Displays: Singapore, Kuala Lumpur, Bangkok, Tokyo, Sydney, London, New York, Dubai, Amsterdam, Seoul.
- Each city entry shows current temperature, condition, and local time.
- Two subpages (5 cities each), rotating every 8 seconds.
- HOLD and ◀ ▶ work.
- Data from Open-Meteo; city coordinates are fixed in config (not looked up at runtime).

---

## Page 302 — WEATHER — CITY SEARCH *(stretch goal)*

**US-302-1:** As a user, I want to search for any city and see its current weather.

Acceptance criteria (only implemented if task budget allows after all core pages pass):
- An on-screen prompt accepts a city name.
- City is looked up via Open-Meteo Geocoding API.
- Forecast is displayed in the same layout as p300.

---

## Page 400 — MARKETS / CURRENCY

**US-400-1:** As a user, I want to see exchange rates expressed as "1 unit of foreign currency → IDR", so I can quickly understand the value of money.

Acceptance criteria:
- Table shows, for each currency (USD, EUR, SGD, JPY, GBP, AUD, CNY, MYR, THB, KRW): `<CURRENCY> 1 = IDR <amount>`.
- Change vs yesterday is shown where the API provides time-series data (Frankfurter).
- Footer reads: "Reference rates — updated daily. Not trading prices."
- Primary source: Frankfurter v2 (`api.frankfurter.dev/v2/rates?base=IDR&quotes=…`).
- Fallback source: open.er-api.com (`/v6/latest/IDR`).
- If open.er-api is used, the page footer includes the required attribution: `Rates By Exchange Rate API` linking to `https://www.exchangerate-api.com`.
- Cache TTL is 6 hours; page refreshes the cache on open if stale.
- Optional: BTC/ETH row clearly labelled (not guaranteed to be present in all API responses).

---

## Page 500 — ABOUT / HELP

**US-500-1:** As a user, I want to understand what teletext was and how to use this app.

Acceptance criteria:
- Subpage 1: 3 short paragraphs on what teletext was, plus instructions on how to use the app (type a page number, fastext keys, HOLD, REVEAL, keyboard shortcuts).
- Subpage 2: full data-source credits — Open-Meteo (CC BY 4.0), BBC RSS (attribution + link policy), Frankfurter, ExchangeRate-API (attribution link), ESPN (unofficial source note), OpenLigaDB.
- Credits page includes: "Built with Kiro for Kiroween 2026" and MIT licence note.
- Keyboard shortcuts `R`, `G`, `Y`, `C` for fastext are documented here.
- No external API calls; entirely static content.

---

## Page 888 — SUBTITLES

**US-888-1:** As a user, I want to see a playful fake teletext subtitle page that affectionately references real teletext's accessibility role.

Acceptance criteria:
- Header reads: "SUBTITLES — ENGLISH 888".
- Displays lines from a bundled fake nature-documentary subtitle script, one line advancing every 4 seconds, looping.
- The script ends with one line acknowledging that teletext subtitles served deaf viewers — kept affectionate, not mocking.
- No external API calls; content is from `data/sample-data.js`.
