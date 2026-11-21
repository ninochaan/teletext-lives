# Tasks — TELETEXT LIVES

Build task list from brief section 7.2. Execute top to bottom — one task per Kiro prompt.

---

- [x] **T0 — Repo scaffold**  
  Create the files from brief §6.5: `index.html`, `styles.css`, `app.js`, `data/sample-data.js`, `assets/` placeholder, MIT `LICENSE`, `README.md` skeleton. Check `.gitignore` does not exclude `.kiro/`.  
  **Done when:** Repo pushes clean; GitHub detects MIT licence in the About sidebar; `git status` confirms `.kiro/` is tracked.  
  *Est. ~80 credits*

- [x] **T1 — Steering + spec files**  
  Generate all 6 Kiro artefacts listed in §7.1 from this brief: `steering/product.md`, `steering/tech.md`, `steering/structure.md`, `specs/teletext-lives/requirements.md`, `specs/teletext-lives/design.md`, `specs/teletext-lives/tasks.md`.  
  **Done when:** All 6 files exist and are consistent with the brief.  
  *Est. ~150 credits*

- [x] **T2 — Stage + renderer core**  
  Build the 40×24 grid stage, palette CSS classes, double-height technique, mosaic helper, header rows with ticking clock, hash router, and the "page not found" screen.  
  **Done when:** `#100` shows a static index mock; clock ticks every second in `Asia/Jakarta` time; navigating to an unknown page shows the classic error screen.  
  *Est. ~450 credits*

- [x] **T3 — Input system**  
  Implement keyboard 3-digit entry, the on-screen numeric keypad, fastext bar (R/G/Y/C keyboard shortcuts), HOLD button/key, and ◀ ▶ subpage steppers.  
  **Done when:** Can navigate mock pages by typing digits on the keyboard, tapping the on-screen keypad, and pressing fastext keys; HOLD freezes a rotating page.  
  *Est. ~300 credits*

- [x] **T4 — Data layer**  
  Build the fetch helper (6 s timeout, one retry, localStorage cache + TTLs), the RSS parser (`DOMParser` / `text/xml`), and the full BBC CORS proxy chain (allorigins raw → allorigins get → corsproxy.io → cache → error page).  
  **Done when:** BBC headlines and Open-Meteo JSON arrive in the browser and are verified in the console; BBC data is cached; proxy fallbacks are triggered and logged when a proxy is blocked in devtools.  
  *Est. ~350 credits*

- [x] **T5 — Pages 100 + 101 + 102 (index, headlines, story)**  
  Wire pages 100, 101, and 102 to live BBC RSS data. Implement subpage rotation on 101 (8 s) and subpage navigation on 102. Add the p100 mosaic logo.  
  **Done when:** Headlines on p101 are real and current; tapping a headline opens the correct story on p102; `102`+digit keyboard navigation works; story page shows double-height headline, BBC snippet, and attribution link.  
  *Est. ~450 credits*

- [x] **T6 — Pages 300 + 301 (weather)**  
  Wire p300 and p301 to Open-Meteo. Jakarta default on p300, Indonesian city rotation (8 s subpages), world cities grid on p301 (2 subpages, 8 s). Add mosaic weather icons (sun, cloud, rain). Add Open-Meteo attribution footer.  
  **Done when:** Real Jakarta forecast is displayed; city subpage rotation works; HOLD freezes it; p301 world grid shows current conditions with local times.  
  *Est. ~400 credits*

- [x] **T7 — Page 400 (markets / currency)**  
  Wire p400 to Frankfurter v2, with fallback chain to Frankfurter v1 then open.er-api. Display the IDR table (`1 USD = IDR …`), change vs yesterday where available. Add "Reference rates — updated daily. Not trading prices." footer and open.er-api attribution.  
  **Done when:** Real IDR table is displayed; blocking Frankfurter in devtools falls back to open.er-api cleanly and the attribution link appears; cache TTL is 6 h.  
  *Est. ~250 credits*

- [x] **T8 — Pages 200 + 201 (sport)**  
  Wire p200 to BBC Sport + Football RSS (via proxy) for headlines, plus the ESPN scoreboard attempt for the LATEST SCORES block. Wire p201 league subpages. Implement OpenLigaDB fallback for Bundesliga. If neither ESPN nor OpenLigaDB is available, show labelled SAMPLE DATA.  
  **Done when:** Sport headlines on p200 are live; scores block shows live ESPN data **or** is clearly labelled "SAMPLE DATA — live scores unavailable"; p201 league subpages rotate every 10 s; scores refresh every 5 min.  
  *Est. ~350 credits*

- [x] **T9 — Pages 104, 888, 500 (quiz, subtitles, about)**  
  Implement p104 quiz with per-question REVEAL (black-on-black hidden answers, `V` key / REVEAL button reveals), day-of-month question-set selection. Implement p888 subtitle ticker (bundled script, 4 s per line, looping). Implement p500 two-subpage about/credits page.  
  **Done when:** All three pages render correctly; REVEAL shows and hides individual answers; subtitle lines advance every 4 s; p500 credits list all data sources with correct attribution links.  
  *Est. ~250 credits*

- [x] **T10 — Fallback + polish pass**  
  Verify offline behaviour (devtools offline: every page renders with cache or labelled sample). Check cache-miss error pages. Confirm `prefers-reduced-motion` disables flash and CRT. Mobile layout check (portrait, on-screen keypad). Add favicon.  
  **Done when:** With devtools set to Offline, every page (100–888) still renders something honest — no blank stage anywhere.  
  *Est. ~300 credits*

- [ ] **T11 — Deploy**  
  Enable GitHub Pages. Finish `README.md` (live URL, screenshots of index + weather + markets, data-source credits, how to run locally). Run final `git status` to audit `/.kiro` is present and not gitignored. Test the live URL on a phone and verify `…/#300` deep link works from a fresh browser tab.  
  **Done when:** Live URL loads on a phone; `…/#300` deep links to the weather page; repo audit is clean; `/.kiro` is visible in the public GitHub repo.  
  *Est. ~120 credits*

---

**Estimated total: ~3,450 credits. Reserve for fixes / judge-proofing: ~550 credits.**

## Credit discipline (from brief §7.3)

1. One task per prompt — paste the task from this file, do not combine tasks.
2. Keep the free-tier 50 monthly credits untouched until the 4,000 hackathon credits land.
3. Prefer spec/task execution over long debug chat; for a bug, state: file + symptom + expected behaviour in one message.
4. After each task: test locally over `http://localhost` (never `file://`), tick the task above, commit.
5. If a task burns > 1.5× its estimate, simplify by invoking the cut order: **302 search → sound → Bedstead font → quiz subpages**. Core pages 100/101/102/200/300/400 are never cut.
