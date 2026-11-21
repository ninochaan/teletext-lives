/* TELETEXT LIVES — app.js
 * Kiroween 2026 — Category: Resurrection
 * Renderer core: segment model, helpers, header + clock, router, p100, page-not-found.
 * T2 — no input handling (T3), no live data (T4+).
 */

'use strict';

/* ═══════════════════════════════════════════════════════
   SECTION 1 — CONSTANTS
   ═══════════════════════════════════════════════════════ */

const COLS = 40;
const ROWS = 24;
const TIMEZONE = 'Asia/Jakarta';

/* Input state — declared early so all sections can reference it */
let _digitBuffer  = '';     // current partial 3-digit entry, e.g. '1' or '10'
let _subpageState = null;   // active subpage rotation state object

/* ═══════════════════════════════════════════════════════
   SECTION 2 — DATA LAYER
   ═══════════════════════════════════════════════════════
   Fetch helpers, localStorage cache, BBC CORS proxy chain,
   RSS parser, and source-level getFeed / getJSONCached.

   Public surface exposed as window.TTData:
     TTL              — per-source TTL constants (ms)
     fetchText(url)   — GET with 6 s timeout + 1 retry
     fetchJSON(url)   — same but JSON.parse'd
     cacheGet(url)    — read localStorage entry
     cacheSet(url, payload) — write localStorage entry
     cachedFetch(url, ttlMs, fetcher, onFresh?)
                      — stale-while-revalidate wrapper
     fetchBBCFeed(feedUrl) — proxy chain for BBC RSS
     parseRSS(xmlText)     — DOMParser → item array
     getFeed(feedUrl)      — BBC feed + 10-min cache
     getJSONCached(url, ttlMs) — direct-CORS JSON + cache
   ═══════════════════════════════════════════════════════ */

/* ── 2.1  TTL constants ──────────────────────────────── */

const TTL = {
  WEATHER:  30 * 60 * 1000,   //  30 minutes
  NEWS:     10 * 60 * 1000,   //  10 minutes
  CURRENCY:  6 * 60 * 60 * 1000, //  6 hours
  SCORES:    5 * 60 * 1000,   //   5 minutes
};

/* ── 2.2  Low-level fetch helpers ───────────────────── */

/**
 * Fetch a URL as text with an AbortController timeout and one retry.
 * Plain GET, no custom headers (avoids CORS preflight).
 * @param {string} url
 * @param {number} [timeoutMs=6000]
 * @returns {Promise<string>}
 */
async function fetchText(url, timeoutMs) {
  const ms = timeoutMs || 6000;

  async function attempt() {
    const ctrl = new AbortController();
    const timer = setTimeout(function() { ctrl.abort(); }, ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    return await attempt();
  } catch (e1) {
    // One retry after first failure
    try {
      return await attempt();
    } catch (e2) {
      throw e2;
    }
  }
}

/**
 * Fetch a URL and JSON.parse the response.
 * Same 6-second timeout and one retry as fetchText.
 * @param {string} url
 * @param {number} [timeoutMs=6000]
 * @returns {Promise<any>}
 */
async function fetchJSON(url, timeoutMs) {
  const text = await fetchText(url, timeoutMs);
  return JSON.parse(text);
}

/* ── 2.3  localStorage cache helpers ─────────────────── */

const _CACHE_PREFIX = 'ttlives_cache_';

/**
 * Read a cached entry for `url`.
 * Returns { fetchedAt, payload } or null if absent / corrupt.
 * @param {string} url
 * @returns {{ fetchedAt: number, payload: any }|null}
 */
function cacheGet(url) {
  try {
    const raw = localStorage.getItem(_CACHE_PREFIX + url);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Write a cache entry for `url`.
 * Stores { fetchedAt, payload }; fetchedAt = Date.now().
 * Silently swallows QuotaExceededError.
 * @param {string} url
 * @param {any}    payload
 */
function cacheSet(url, payload) {
  try {
    const entry = { fetchedAt: Date.now(), payload: payload };
    localStorage.setItem(_CACHE_PREFIX + url, JSON.stringify(entry));
  } catch (e) {
    // QuotaExceededError or private-browsing restriction — not fatal
  }
}

/* ── 2.4  Stale-while-revalidate cachedFetch ─────────── */

/**
 * Cache-first fetch with stale-while-revalidate semantics.
 *
 * Behaviour:
 *   - Cache hit within TTL  → return immediately, no network call.
 *   - Cache hit, stale      → return stale value immediately,
 *                             fire background refresh,
 *                             call onFresh(result) when done.
 *   - No cache              → await the fetch, return result.
 *
 * Always returns { data, fetchedAt, fromCache }.
 *
 * @param {string}   url
 * @param {number}   ttlMs
 * @param {function():Promise<any>} fetcher — async fn that returns the payload
 * @param {function({data,fetchedAt,fromCache}):void} [onFresh]
 * @returns {Promise<{data:any, fetchedAt:number, fromCache:boolean}>}
 */
async function cachedFetch(url, ttlMs, fetcher, onFresh) {
  const entry = cacheGet(url);
  const now   = Date.now();

  if (entry) {
    const age = now - entry.fetchedAt;

    if (age <= ttlMs) {
      // Fresh cache — return immediately
      return { data: entry.payload, fetchedAt: entry.fetchedAt, fromCache: true };
    }

    // Stale cache — return immediately and refresh in background
    const staleResult = { data: entry.payload, fetchedAt: entry.fetchedAt, fromCache: true };

    // Background refresh (don't await — fire and forget)
    (async function() {
      try {
        const freshPayload = await fetcher();
        cacheSet(url, freshPayload);
        if (onFresh) {
          onFresh({ data: freshPayload, fetchedAt: Date.now(), fromCache: false });
        }
      } catch (e) {
        // Background refresh failed — stale data remains
      }
    })();

    return staleResult;
  }

  // No cache — await fresh fetch
  const payload = await fetcher();
  cacheSet(url, payload);
  return { data: payload, fetchedAt: Date.now(), fromCache: false };
}

/* ── 2.5  BBC CORS proxy chain ────────────────────────── */

/**
 * Fetch a BBC RSS feed URL through the CORS proxy chain.
 * Tries each proxy in order with a 5-second timeout.
 * Throws if all proxies fail (caller falls back to cache / error page).
 *
 * Proxy order (from brief §6.3):
 *   1. allorigins /raw  → returns raw XML
 *   2. allorigins /get  → returns JSON; unwrap .contents
 *   3. corsproxy.io     → returns raw XML
 *
 * @param {string} feedUrl — the BBC feed URL to proxy
 * @returns {Promise<string>} — raw RSS XML text
 */
async function fetchBBCFeed(feedUrl) {
  const encoded = encodeURIComponent(feedUrl);
  const PROXY_TIMEOUT = 5000;

  // Proxy 1: allorigins raw — returns raw XML directly
  try {
    const url = 'https://api.allorigins.win/raw?url=' + encoded;
    const xml = await fetchText(url, PROXY_TIMEOUT);
    if (xml && xml.trim().startsWith('<')) {
      return xml;
    }
    throw new Error('allorigins raw: unexpected response');
  } catch (e1) {
    console.warn('[TTData] allorigins/raw failed:', e1.message);
  }

  // Proxy 2: allorigins get — returns JSON wrapper; unwrap .contents
  try {
    const url = 'https://api.allorigins.win/get?url=' + encoded;
    const json = await fetchJSON(url, PROXY_TIMEOUT);
    const contents = json && json.contents;
    if (contents && typeof contents === 'string' && contents.trim().startsWith('<')) {
      return contents;
    }
    throw new Error('allorigins get: .contents missing or not XML');
  } catch (e2) {
    console.warn('[TTData] allorigins/get failed:', e2.message);
  }

  // Proxy 3: corsproxy.io — returns raw XML
  try {
    const url = 'https://corsproxy.io/?url=' + encoded;
    const xml = await fetchText(url, PROXY_TIMEOUT);
    if (xml && xml.trim().startsWith('<')) {
      return xml;
    }
    throw new Error('corsproxy.io: unexpected response');
  } catch (e3) {
    console.warn('[TTData] corsproxy.io failed:', e3.message);
  }

  throw new Error('All BBC CORS proxies failed for: ' + feedUrl);
}

/* ── 2.6  RSS parser ──────────────────────────────────── */

/**
 * Strip HTML tags from a string, then collapse whitespace and trim.
 * @param {string} str
 * @returns {string}
 */
function _stripHtml(str) {
  if (!str) return '';
  // Use DOMParser to strip tags safely
  try {
    const doc = (new DOMParser()).parseFromString(
      '<body>' + str + '</body>', 'text/html'
    );
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  } catch (e) {
    // Fallback: regex strip
    return str.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }
}

/**
 * Parse BBC RSS XML text into an array of items.
 * Uses DOMParser with text/xml.
 * @param {string} xmlText
 * @returns {{ title:string, description:string, link:string, pubDate:string }[]}
 */
function parseRSS(xmlText) {
  let doc;
  try {
    doc = (new DOMParser()).parseFromString(xmlText, 'text/xml');
  } catch (e) {
    console.error('[TTData] parseRSS: DOMParser failed', e);
    return [];
  }

  // Check for parser errors
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    console.error('[TTData] parseRSS: XML parse error');
    return [];
  }

  const itemEls = Array.from(doc.querySelectorAll('item'));
  return itemEls.map(function(item) {
    function getText(tag) {
      const el = item.querySelector(tag);
      return el ? (el.textContent || '').trim() : '';
    }

    const rawTitle       = getText('title');
    const rawDescription = getText('description');
    const rawLink        = getText('link');
    const rawPubDate     = getText('pubDate');

    return {
      title:       _stripHtml(rawTitle).trim(),
      description: _stripHtml(rawDescription).trim(),
      link:        rawLink.trim(),
      pubDate:     rawPubDate.trim(),
    };
  });
}

/* ── 2.7  Source-level functions ─────────────────────── */

/**
 * Fetch and parse a BBC RSS feed via the proxy chain + 10-min cache.
 * Returns { data: item[], fetchedAt: number, fromCache: boolean }.
 *
 * On total failure (all proxies down, no cache): throws so the
 * caller can render an in-universe error page.
 *
 * @param {string} feedUrl
 * @param {function({data,fetchedAt,fromCache}):void} [onFresh]
 * @returns {Promise<{data: Array, fetchedAt: number, fromCache: boolean}>}
 */
async function getFeed(feedUrl, onFresh) {
  const cacheKey = 'rss:' + feedUrl;

  async function doFetch() {
    const xml   = await fetchBBCFeed(feedUrl);
    const items = parseRSS(xml);
    if (!items.length) throw new Error('Empty RSS feed: ' + feedUrl);
    return items;
  }

  try {
    return await cachedFetch(cacheKey, TTL.NEWS, doFetch, onFresh);
  } catch (networkErr) {
    // Network failed and no cache — re-throw for caller
    console.error('[TTData] getFeed failed:', networkErr.message);
    throw networkErr;
  }
}

/**
 * Fetch a direct-CORS JSON endpoint with caching.
 * Returns { data: any, fetchedAt: number, fromCache: boolean }.
 *
 * @param {string} url
 * @param {number} ttlMs
 * @param {function({data,fetchedAt,fromCache}):void} [onFresh]
 * @returns {Promise<{data:any, fetchedAt:number, fromCache:boolean}>}
 */
async function getJSONCached(url, ttlMs, onFresh) {
  async function doFetch() {
    return await fetchJSON(url);
  }

  return await cachedFetch(url, ttlMs, doFetch, onFresh);
}

/* ── 2.8  Direct-CORS RSS fetch (for NYT fallback) ───────── */

/**
 * Fetch an RSS feed that sends CORS headers directly (no proxy needed).
 * Uses the same fetchText helper with timeout + retry.
 * @param {string} feedUrl
 * @returns {Promise<{ title:string, description:string, link:string, pubDate:string }[]>}
 */
async function fetchDirectFeed(feedUrl) {
  const xml = await fetchText(feedUrl, 6000);
  const items = parseRSS(xml);
  if (!items.length) throw new Error('Empty direct feed: ' + feedUrl);
  return items;
}

/* ── 2.9  loadNews() — merged BBC+NYT news loader ───────── */

const NEWS_MERGED_KEY = 'news:merged';
const BBC_FEEDS = [
  'https://feeds.bbci.co.uk/news/rss.xml',
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://feeds.bbci.co.uk/news/world/asia/rss.xml',
];
const NYT_FEED = 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml';
const NEWS_BBC_GRACE_MS = 5000; // start NYT concurrently if no BBC items by then

/**
 * Merge, deduplicate by title, sort newest-first, cap to 12 items.
 * @param {Array[]} feedArrays — each element is an array of parsed items
 * @returns {Array}
 */
function _mergeNewsItems(feedArrays) {
  const all = [];
  for (const items of feedArrays) {
    for (const item of items) all.push(item);
  }

  // Deduplicate by normalised title (lower-case, strip punctuation)
  const seen = new Set();
  const deduped = [];
  for (const item of all) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  // Sort newest-first by pubDate (fall back to original order for unparseable dates)
  deduped.sort(function(a, b) {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    if (isNaN(ta) && isNaN(tb)) return 0;
    if (isNaN(ta)) return 1;
    if (isNaN(tb)) return -1;
    return tb - ta;
  });

  return deduped.slice(0, 12);
}

/**
 * Load news from BBC Top Stories + World + Asia feeds via proxy chain.
 * Falls back to NYT HomePage RSS (direct CORS) if all BBC proxies fail.
 * Caches the merged result under NEWS_MERGED_KEY with TTL.NEWS.
 *
 * Returns:
 *   { items, sourceName, fetchedAt, fromCache }
 * where sourceName is 'BBC NEWS' or 'NY TIMES'.
 *
 * @param {function({items,sourceName,fetchedAt,fromCache}):void} [onFresh]
 * @returns {Promise<{items:Array, sourceName:string, fetchedAt:number, fromCache:boolean}>}
 */
async function loadNews(onFresh) {
  // Check merged cache first
  const cached = cacheGet(NEWS_MERGED_KEY);
  const now    = Date.now();

  if (cached && (now - cached.fetchedAt) <= TTL.NEWS) {
    return {
      items:      cached.payload.items,
      sourceName: cached.payload.sourceName,
      fetchedAt:  cached.fetchedAt,
      fromCache:  true,
    };
  }

  // If stale cache exists, return stale immediately and refresh in background
  if (cached) {
    const stale = {
      items:      cached.payload.items,
      sourceName: cached.payload.sourceName,
      fetchedAt:  cached.fetchedAt,
      fromCache:  true,
    };

    (async function() {
      try {
        const fresh = await _fetchMergedNews();
        cacheSet(NEWS_MERGED_KEY, fresh);
        if (onFresh) onFresh({ ...fresh, fetchedAt: Date.now(), fromCache: false });
      } catch (e) {
        // Background refresh failed — keep stale
      }
    })();

    return stale;
  }

  // No cache — fetch now
  const result = await _fetchMergedNews();
  cacheSet(NEWS_MERGED_KEY, result);
  return { ...result, fetchedAt: Date.now(), fromCache: false };
}

/**
 * Internal: attempt BBC feeds in parallel, fall back to NYT.
 * Returns { items, sourceName }.
 */
async function _fetchMergedNews() {
  let anyBBC = false; // true once any BBC feed has produced items

  // Fetch all three BBC feeds in parallel; each goes through the proxy chain
  const feedPromises = BBC_FEEDS.map(async function(feedUrl) {
    const xml   = await fetchBBCFeed(feedUrl);
    const items = parseRSS(xml);
    if (!items.length) throw new Error('Empty feed: ' + feedUrl);
    anyBBC = true;
    return items;
  });

  // BBC result: waits for all feeds to settle, rejects if none produced items
  const bbcPromise = Promise.allSettled(feedPromises).then(function(results) {
    const bbcResults = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        bbcResults.push(r.value);
      } else {
        console.warn('[loadNews] BBC feed failed:', BBC_FEEDS[i], r.reason && r.reason.message);
      }
    }
    if (!bbcResults.length) throw new Error('All BBC feeds failed');
    return { items: _mergeNewsItems(bbcResults), sourceName: 'BBC NEWS' };
  });

  // NYT result: direct CORS feed
  function fetchNYT() {
    return fetchDirectFeed(NYT_FEED).then(function(nytItems) {
      const items = _mergeNewsItems([nytItems]);
      if (!items.length) throw new Error('Empty feed: ' + NYT_FEED);
      return { items: items, sourceName: 'NY TIMES' };
    });
  }

  // BBC preferred. If no BBC feed has items after the grace period, start NYT
  // concurrently; from then on the first successful source wins.
  return new Promise(function(resolve, reject) {
    let settled = false, bbcFailed = false, nytFailed = false, nytStarted = false;
    let timer = null;

    function win(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }
    function checkAllFailed() {
      if (settled || !bbcFailed || !nytFailed) return;
      settled = true;
      console.error('[loadNews] BBC and NYT both failed');
      reject(new Error('All news sources failed'));
    }
    function startNYT() {
      if (nytStarted || settled) return;
      nytStarted = true;
      console.warn('[loadNews] No BBC items yet; trying NYT fallback');
      fetchNYT().then(win, function(e) {
        console.error('[loadNews] NYT fallback failed:', e.message);
        nytFailed = true;
        checkAllFailed();
      });
    }

    bbcPromise.then(win, function() {
      bbcFailed = true;
      clearTimeout(timer);
      startNYT();
      checkAllFailed();
    });

    timer = setTimeout(function() {
      if (!anyBBC) startNYT();
    }, NEWS_BBC_GRACE_MS);
  });
}

/* ── 2.10  Public API ─────────────────────────────────────── */

window.TTData = {
  TTL:              TTL,
  fetchText:        fetchText,
  fetchJSON:        fetchJSON,
  cacheGet:         cacheGet,
  cacheSet:         cacheSet,
  cachedFetch:      cachedFetch,
  fetchBBCFeed:     fetchBBCFeed,
  fetchDirectFeed:  fetchDirectFeed,
  parseRSS:         parseRSS,
  getFeed:          getFeed,
  getJSONCached:    getJSONCached,
  loadNews:         loadNews,
};

/* ═══════════════════════════════════════════════════════
   SECTION 3 — TEXT UTILITIES
   ═══════════════════════════════════════════════════════ */

/**
 * Hard-cut text to maxLen, appending '…' if truncated.
 */
function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '\u2026';
}

/**
 * Wrap text on word boundaries, returning lines each ≤ maxLen chars.
 * @returns {string[]}
 */
function wrapWords(text, maxLen) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!word) continue;
    if (!current) {
      current = word.length > maxLen ? word.slice(0, maxLen) : word;
      if (word.length > maxLen) {
        lines.push(current);
        current = word.slice(maxLen);
      }
    } else if ((current + ' ' + word).length <= maxLen) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word.length > maxLen ? word.slice(0, maxLen) : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Pad string to exactly len with trailing spaces. */
function padRight(text, len) {
  const s = String(text);
  if (s.length >= len) return s.slice(0, len);
  return s + ' '.repeat(len - s.length);
}

/** Pad string to exactly len with leading spaces. */
function padLeft(text, len) {
  const s = String(text);
  if (s.length >= len) return s.slice(0, len);
  return ' '.repeat(len - s.length) + s;
}

/** Centre-align string within len, padding with spaces. */
function padCentre(text, len) {
  const s = String(text);
  if (s.length >= len) return s.slice(0, len);
  const total = len - s.length;
  const left  = Math.floor(total / 2);
  const right = total - left;
  return ' '.repeat(left) + s + ' '.repeat(right);
}

/* ═══════════════════════════════════════════════════════
   SECTION 3 — SEGMENT MODEL & ROW BUILDERS
   ═══════════════════════════════════════════════════════
   A "segment" is { t, fg, bg, flash? }:
     t     — text string (may span multiple columns)
     fg    — colour name, default 'white'
     bg    — colour name, default 'black'
     flash — boolean, default false
   
   A "row-spec" is an array of segments. The row builder
   pads to exactly COLS characters with black spaces.
   ═══════════════════════════════════════════════════════ */

/**
 * Create a segment descriptor.
 * @param {string} text
 * @param {string} [fg='white']
 * @param {string} [bg='black']
 * @param {{flash?:boolean}} [opts={}]
 */
function seg(text, fg, bg, opts) {
  return {
    t:     String(text || ''),
    fg:    fg  || 'white',
    bg:    bg  || 'black',
    flash: !!(opts && opts.flash),
  };
}

/**
 * Build a row-spec from segments, padding to exactly COLS chars.
 * Accepts individual segments or arrays of segments as arguments.
 * @param {...(Object|Object[])} segments
 * @returns {Object[]}
 */
function row() {
  const flat = [];
  for (const arg of arguments) {
    if (Array.isArray(arg)) flat.push(...arg);
    else if (arg) flat.push(arg);
  }

  let used = 0;
  for (const s of flat) used += s.t.length;

  if (used < COLS) {
    flat.push(seg(' '.repeat(COLS - used), 'black', 'black'));
  }
  return flat;
}

/** A blank row — 40 black spaces. */
function blankRow() {
  return [seg(' '.repeat(COLS), 'black', 'black')];
}

/**
 * Build a 2-element array for a double-height header block.
 * Returns [visibleRowSpec, spacerRowSpec].
 * The visible row-spec carries _dh=true; spacer carries _dhSpacer=true.
 * @param {string} text — up to COLS chars
 * @param {string} [fg='yellow']
 * @param {string} [bg='blue']
 * @returns {[Object[], Object[]]}
 */
function doubleHeight(text, fg, bg) {
  const padded = padRight(truncate(text, COLS), COLS);
  const fg_ = fg || 'yellow';
  const bg_ = bg || 'blue';

  const visRow = [seg(padded, fg_, bg_)];
  visRow._dh = true;

  const spacer = blankRow();
  spacer._dhSpacer = true;

  return [visRow, spacer];
}

/**
 * Convert string-art lines into row-specs using block character segments.
 *
 * @param {string[]} artLines — each character maps to a palette key
 * @param {Object}   palette  — { key: { t?, fg, bg } }
 *   't' defaults to '█' if omitted. ' ' always renders as black space.
 * @returns {Object[][]} — array of row-specs
 */
function mosaic(artLines, palette) {
  return artLines.map(line => {
    const segs = [];
    for (let i = 0; i < line.length && i < COLS; i++) {
      const ch = line[i];
      if (ch === ' ' || !(ch in palette)) {
        segs.push(seg(' ', 'black', 'black'));
      } else {
        const def = palette[ch];
        segs.push(seg(def.t || '\u2588', def.fg || 'white', def.bg || 'black'));
      }
    }
    const used = Math.min(line.length, COLS);
    if (used < COLS) segs.push(seg(' '.repeat(COLS - used), 'black', 'black'));
    return segs;
  });
}

/* ═══════════════════════════════════════════════════════
   SECTION 4 — DOM RENDERER
   ═══════════════════════════════════════════════════════
   renderPage(rowSpecs): builds 24 row divs from row-specs.
   All text via textContent — never innerHTML on data.
   Double-height rows are wrapped in a .dh-block div.
   ═══════════════════════════════════════════════════════ */

/** Build a <span> from a segment. */
function buildSpan(s) {
  const el = document.createElement('span');
  el.textContent = s.t;
  el.className = 'fg-' + s.fg + ' bg-' + s.bg;
  if (s.flash) el.classList.add('flash');
  return el;
}

/**
 * Build a row div from a row-spec.
 * Each character in each segment becomes a separate span
 * (so each span occupies exactly one column).
 * If the row-spec carries a _page property the div gets
 * data-page (and optionally data-sub) set, plus cursor:pointer,
 * making it a tap target for the delegated click handler.
 * @param {string} divClass — 'tt-row' or 'dh-row'
 */
function buildRowDiv(rowSpec, divClass) {
  const div = document.createElement('div');
  div.className = divClass;
  for (const s of rowSpec) {
    for (const ch of s.t) {
      div.appendChild(buildSpan({ t: ch, fg: s.fg, bg: s.bg, flash: s.flash }));
    }
  }
  if (rowSpec._page) {
    div.dataset.page = String(rowSpec._page);
    if (rowSpec._sub)  div.dataset.sub = String(rowSpec._sub);
    div.style.cursor = 'pointer';
  }
  return div;
}

/**
 * Render row-specs to the stage. Pads/truncates to ROWS.
 * @param {Object[][]} rowSpecs
 */
function renderPage(rowSpecs) {
  const stage = document.getElementById('stage');
  stage.innerHTML = '';

  const specs = rowSpecs.slice(0, ROWS);
  while (specs.length < ROWS) specs.push(blankRow());

  let i = 0;
  while (i < specs.length) {
    const spec = specs[i];

    if (spec._dh) {
      // Double-height: wrap in .dh-block (occupies 2 row heights visually)
      const block = document.createElement('div');
      block.className = 'dh-block';
      block.appendChild(buildRowDiv(spec, 'dh-row'));
      i++;
      // Consume the spacer spec that follows
      if (i < specs.length && specs[i]._dhSpacer) i++;
      stage.appendChild(block);
    } else if (spec._dhSpacer) {
      // Orphaned spacer — render blank
      stage.appendChild(buildRowDiv(blankRow(), 'tt-row'));
      i++;
    } else {
      stage.appendChild(buildRowDiv(spec, 'tt-row'));
      i++;
    }
  }
}

/* ═══════════════════════════════════════════════════════
   SECTION 5 — HEADER + TICKING CLOCK
   ═══════════════════════════════════════════════════════
   buildHeaderRow(pageNum, subLabel) returns one row-spec.
   The clock is wired after renderPage() by replacing the
   last 8 individual char-spans with a wrapper span that
   gets id="tt-clock", so _tickClock() only touches that node.
   ═══════════════════════════════════════════════════════ */

let _clockNode = null;

/** Jakarta time as HH:MM:SS */
function jakartaTimeString() {
  return new Date().toLocaleTimeString('en-GB', {
    timeZone: TIMEZONE,
    hour:     '2-digit',
    minute:   '2-digit',
    second:   '2-digit',
    hour12:   false,
  });
}

/** Jakarta date as "Wed 19 Nov" */
function jakartaDateString() {
  const now = new Date();
  const day = now.toLocaleDateString('en-GB', { timeZone: TIMEZONE, weekday: 'short' });
  const d   = now.toLocaleDateString('en-GB', { timeZone: TIMEZONE, day: 'numeric' });
  const mon = now.toLocaleDateString('en-GB', { timeZone: TIMEZONE, month: 'short' });
  return day + ' ' + d + ' ' + mon;
}

/**
 * Build the header row-spec (row 0).
 * Layout: "P100    TELETEXT LIVES   Wed 19 Nov  21:47:32"
 *         ←8 ch→  ←──14 ch──→     ←────18 ch──────────→
 *         Total = 8 + 14 + 18 = 40.
 *
 * The right block is split into date (10 ch) + 2 spaces + time (8 ch) = 20 ch,
 * but the rightWidth = 40-8-14 = 18, so we fit: "Wed 19 Nov  21:47:32" → trim to 18.
 * Actually: dateStr like "Sat 21 Nov" = 10 chars; "  " = 2; timeStr = 8 → total 20.
 * We use: left(8) + centre(14) + gap(2) + date(10) + gap(0) + time(8-2) = ...
 * Simplest: allocate fixed widths:
 *   left = 8, centre = 14, right = 18 → date in first 10, 2 spaces, time in last 8 — total 20.
 * But 8+14+20=42, too many. Use: left=7, centre=14, right=19.
 * "P100   " = 7, "TELETEXT LIVES" = 14, " Sat 21 Nov 21:47:32" = 19.
 * 7+14+19 = 40. ✓
 */
function buildHeaderRow(pageNum, subLabel) {
  const pageLabel = subLabel ? 'P' + pageNum + ' ' + subLabel : 'P' + pageNum;
  const dateStr   = jakartaDateString();  // e.g. "Sat 21 Nov" — 10 chars
  const timeStr   = jakartaTimeString(); // "21:47:32" — 8 chars

  // Fixed widths: left=10 (fits "P102 12/12"), centre=14, right=16 → 40 total
  const LEFT_W   = 10;
  const CENTRE_W = 14;
  const RIGHT_W  = COLS - LEFT_W - CENTRE_W; // 16

  const leftStr   = padRight(pageLabel, LEFT_W);    // "P100   "
  const centreStr = padRight('TELETEXT LIVES', CENTRE_W); // "TELETEXT LIVES"
  // Right = space + date + space + time = 1+10+1+8 = 20... trim to 19:
  // " " + dateStr(10) = 11, then space(1) = 12, then time(8) = 20 — 1 too many
  // Use: dateStr(10) + " " + time(8) = 19. No leading space.
  const rightDate = padRight(dateStr.slice(4), 6);   // "21 Nov" — weekday dropped to make room
  const rightTime = timeStr;                         // 8 chars
  const rightGap  = padRight('', RIGHT_W - 6 - 8);  // 2 chars

  return [
    seg(leftStr,   'white',  'black'),
    seg(centreStr, 'yellow', 'black'),
    seg(rightDate, 'white',  'black'),
    seg(rightGap,  'black',  'black'),
    seg(rightTime, 'white',  'black'),
  ];
  // rightDate(6) + rightGap(2) + rightTime(8) = 16 ✓
}

/**
 * After renderPage(), wire the clock: find the last 8 char-spans of row 0,
 * replace them with a single wrapper span <span id="tt-clock">.
 * That wrapper is updated every second by _tickClock().
 */
function wireClockNode() {
  const stage = document.getElementById('stage');
  const firstRow = stage.firstElementChild;
  if (!firstRow) return;

  const spans = Array.from(firstRow.querySelectorAll('span'));
  if (spans.length < 8) return;

  const timeLen    = 8; // "HH:MM:SS"
  const clockSpans = spans.slice(-timeLen);

  const wrapper = document.createElement('span');
  wrapper.id        = 'tt-clock';
  wrapper.className = 'fg-white bg-black';
  // Mimic the width of 8 character columns
  wrapper.style.cssText =
    'display:inline-flex;' +
    'width:calc(100%/40*8);' +
    'height:100%;' +
    'font-family:inherit;' +
    'font-size:inherit;' +
    'white-space:pre;' +
    'align-items:flex-start;';
  wrapper.textContent = jakartaTimeString();

  const parent = clockSpans[0].parentNode;
  parent.insertBefore(wrapper, clockSpans[0]);
  for (const s of clockSpans) parent.removeChild(s);

  _clockNode = wrapper;
}

/**
 * After renderPage(), wire the page-number display node: find the first 7
 * char-spans of row 0, replace them with <span id="tt-pagenum">.
 * Digit entry updates this node to show partial entry like "P1__".
 */
let _pagenumNode = null;

function wirePagenumNode() {
  const stage = document.getElementById('stage');
  const firstRow = stage.firstElementChild;
  if (!firstRow) return;

  const spans = Array.from(firstRow.querySelectorAll('span'));
  if (spans.length < 10) return;

  const pageSpans = spans.slice(0, 10);

  const wrapper = document.createElement('span');
  wrapper.id        = 'tt-pagenum';
  wrapper.className = 'fg-white bg-black';
  wrapper.style.cssText =
    'display:inline-flex;' +
    'width:calc(100%/40*10);' +
    'height:100%;' +
    'font-family:inherit;' +
    'font-size:inherit;' +
    'white-space:pre;' +
    'align-items:flex-start;';

  const parent = pageSpans[0].parentNode;
  parent.insertBefore(wrapper, pageSpans[0]);
  for (const s of pageSpans) parent.removeChild(s);

  _pagenumNode = wrapper;
  // Set initial text from built header
  updatePagenumDisplay();
}

/** Update the page number node text — called on render and during digit entry. */
function updatePagenumDisplay() {
  if (!_pagenumNode) return;
  const buf = _digitBuffer;
  let text;
  if (buf.length === 0) {
    // Show current page from hash
    const { page, sub } = parseHash();
    let label = sub ? 'P' + page + ' ' + sub : 'P' + page;
    if (hasSubpages()) {
      label = 'P' + _subpageState.pageNum + ' ' +
              (_subpageState.current + 1) + '/' + _subpageState.screens.length;
    }
    text = padRight(label, 10);
  } else {
    // Show partial entry: P1__, P10_
    const d1 = buf[0] || '_';
    const d2 = buf[1] || '_';
    const d3 = buf[2] || '_';
    text = padRight('P' + d1 + d2 + d3, 10);
  }
  _pagenumNode.textContent = text;
}

/** Update the clock text node — called every second. */
function tickClock() {
  if (_clockNode) _clockNode.textContent = jakartaTimeString();
}

setInterval(tickClock, 1000);

/* ═══════════════════════════════════════════════════════
   SECTION 6 — FASTEXT BAR BUILDER
   ═══════════════════════════════════════════════════════ */

/** Current fastext navigation targets — set whenever fasstextRow() is called. */
const _fasstextTargets = { red: 101, green: 200, yellow: 300, cyan: 400 };

/**
 * Build the fastext row (row 23).
 * Four 10-char blocks: Red, Green, Yellow, Cyan.
 * Also records the target page numbers in _fasstextTargets.
 * @param {{red?:number,green?:number,yellow?:number,cyan?:number,
 *          redLabel?:string,greenLabel?:string,yellowLabel?:string,cyanLabel?:string}} [overrides]
 * @returns {Object[]} row-spec
 */
function fasstextRow(overrides) {
  const def = {
    red:    101, redLabel:    'NEWS    ',
    green:  200, greenLabel:  'SPORT   ',
    yellow: 300, yellowLabel: 'WEATHER ',
    cyan:   400, cyanLabel:   'MARKETS ',
  };
  const opts = Object.assign({}, def, overrides || {});

  // Record targets for click/key handler
  _fasstextTargets.red    = opts.red;
  _fasstextTargets.green  = opts.green;
  _fasstextTargets.yellow = opts.yellow;
  _fasstextTargets.cyan   = opts.cyan;

  return row(
    seg(padRight('\u25A0 ' + opts.redLabel,    10), 'black', 'red'),
    seg(padRight('\u25A0 ' + opts.greenLabel,  10), 'black', 'green'),
    seg(padRight('\u25A0 ' + opts.yellowLabel, 10), 'black', 'yellow'),
    seg(padRight('\u25A0 ' + opts.cyanLabel,   10), 'black', 'cyan'),
  );
}

/* ═══════════════════════════════════════════════════════
   SECTION 7 — PAGE ASSEMBLER
   ═══════════════════════════════════════════════════════
   assemblePage(bodyRows, pageNum, subLabel):
     Prepends header row (row 0), renders all 24, wires clock.
   bodyRows should supply rows 1–23 (23 rows).
   ═══════════════════════════════════════════════════════ */

/**
 * Assemble and render a complete 24-row page.
 * @param {Object[][]} bodyRows — 23 row-specs (rows 1–23)
 * @param {string}     pageNum
 * @param {string}     [subLabel]
 */
function assemblePage(bodyRows, pageNum, subLabel) {
  const header = buildHeaderRow(pageNum, subLabel);
  renderPage([header].concat(bodyRows));
  wireClockNode();
  wirePagenumNode();
  wireFastextBlocks();
  wireDataPageLinks();
}

/* ═══════════════════════════════════════════════════════
   SECTION 8 — PER-PAGE TIMER MANAGEMENT
   ═══════════════════════════════════════════════════════ */

let _pageTimers = [];

function clearPageTimers() {
  for (const id of _pageTimers) {
    clearTimeout(id);
    clearInterval(id);
  }
  _pageTimers = [];

  // Reset subpage rotation state
  _subpageState = null;
  updateHoldButton();
}

function addPageInterval(fn, ms) {
  const id = setInterval(fn, ms);
  _pageTimers.push(id);
  return id;
}

function addPageTimeout(fn, ms) {
  const id = setTimeout(fn, ms);
  _pageTimers.push(id);
  return id;
}

/* ═══════════════════════════════════════════════════════
   SECTION 9 — PAGE REGISTRY
   ═══════════════════════════════════════════════════════ */

const PAGES = {};

/**
 * Register a page renderer.
 * @param {number|string} num
 * @param {function}      fn   — fn(ctx) → void
 */
function registerPage(num, fn) {
  PAGES[String(num)] = fn;
}

/* ═══════════════════════════════════════════════════════
   SECTION 10 — NEWS HELPER UTILITIES
   (shared by pages 100, 101, 102)
   ═══════════════════════════════════════════════════════ */

/**
 * Format a Jakarta-time HH:MM string from a timestamp (ms since epoch).
 * @param {number} ts
 * @returns {string}  e.g. "21:47"
 */
function jakartaHHMM(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', {
    timeZone: TIMEZONE,
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  });
}

/**
 * Build the data-footer row-spec for news pages.
 * Shows "DATA HH:MM" or "DATA FROM CACHE HH:MM  SOURCE" on a cyan band.
 * @param {number}  fetchedAt  — ms epoch timestamp
 * @param {boolean} fromCache
 * @param {string}  sourceName — 'BBC NEWS' or 'NY TIMES'
 * @returns {Object[]}  row-spec
 */
function newsFooterRow(fetchedAt, fromCache, sourceName) {
  const timeStr = jakartaHHMM(fetchedAt);
  const label   = fromCache
    ? 'DATA FROM CACHE ' + timeStr
    : 'DATA ' + timeStr;
  const right   = ' ' + (sourceName || '');
  const full    = padRight(label + right, COLS);
  return row(seg(full, 'black', 'cyan'));
}

/**
 * Build the in-universe loading screen for news pages.
 * Shows "searching…" text with a blinking cursor character.
 * @param {string} pageNum — '101' or '102'
 * @returns {Object[][]} body rows (1–23)
 */
function buildNewsLoadingBody(pageNum) {
  const rows = [];

  rows.push(blankRow());

  const [dh, sp] = doubleHeight(padCentre('NEWS SERVICE', COLS), 'white', 'blue');
  rows.push(dh);
  rows.push(sp);

  rows.push(blankRow());

  const searchLine = row(
    seg(padCentre('P' + pageNum + '  \u2026searching', COLS), 'yellow', 'black'),
  );
  rows.push(searchLine);

  /* Blinking cursor block */
  const cursorRow = row(
    seg(padCentre('\u2588', COLS), 'cyan', 'black'),
  );
  cursorRow._flash = true;
  rows.push(cursorRow);

  for (let i = 7; i <= 22; i++) rows.push(blankRow());

  rows.push(fasstextRow());

  return rows;
}

/**
 * Build the in-universe service-unavailable error page for news.
 * @param {string} pageNum — '101' or '102'
 * @returns {Object[][]} body rows (1–23)
 */
function buildNewsErrorBody(pageNum) {
  const rows = [];

  rows.push(blankRow());

  const [dh, sp] = doubleHeight(padCentre('NEWS SERVICE', COLS), 'white', 'blue');
  rows.push(dh);
  rows.push(sp);

  rows.push(blankRow());

  rows.push(row(seg(padCentre('SERVICE TEMPORARILY UNAVAILABLE', COLS), 'yellow', 'black')));
  rows.push(row(seg(padCentre('PLEASE TRY LATER', COLS), 'white', 'black')));

  rows.push(blankRow());

  rows.push(row(seg(padCentre('P' + pageNum + '  NO DATA AVAILABLE', COLS), 'cyan', 'black')));

  for (let i = 10; i <= 22; i++) rows.push(blankRow());

  /* Fastext with RETRY in red */
  rows.push(fasstextRow({
    red:      parseInt(pageNum, 10),
    redLabel: 'RETRY   ',
  }));

  return rows;
}

/* ═══════════════════════════════════════════════════════
   SECTION 11 — PAGE 100: INDEX (live headline)
   ═══════════════════════════════════════════════════════
   Body rows 1–23 (23 rows):
     Rows 1–3: TELETEXT mosaic art (cyan)
     Rows 4–6: LIVES mosaic art (yellow)
     Row  7: blank
     Row  8: date + category line
     Row  9: blank
     Row 10: "HEADLINE OF THE HOUR" label
     Row 11: live headline (or loading/error placeholder)
     Row 12: horizontal divider
     Row 13: index section heading
     Row 14: blank
     Rows 15–21: index entries (7 pages)
     Row 22: navigation hint
     Row 23: fastext bar
   ═══════════════════════════════════════════════════════ */

/**
 * Build the page 100 static body structure, with the headline row
 * replaced by the provided headline spec or a placeholder.
 * @param {Object[]} headlineRowSpec — row-spec for row 11
 * @returns {Object[][]}
 */
function buildPage100Body(headlineRowSpec) {
  const dateStr = jakartaDateString();
  const rows = [];

  /* ── Rows 1–6: MOSAIC BLOCK-LETTER MASTHEAD ──────────────────────────
   *
   * 3-row pixel font, 4 pixels wide + 1-col gap = 5 cols per letter.
   * TELETEXT = 8 letters × 5 = 40 cols (full width), cyan on black.
   * LIVES    = 5 letters × 5 = 25 cols, centred (8 left + 7 right), yellow on black.
   * ────────────────────────────────────────────────────────────────────*/

  const teletextArt = [
    '####.####.#....####.####.####.#..#.####.',
    '.#...###..#....###...#...###...##...#...',
    '.#...####.####.####..#...####.#..#..#...',
  ];

  const livesArt = [
    '........#....####.#..#.####.####........',
    '........#.....#....##..###...##.........',
    '........####.####...#..####.####........',
  ];

  const teletextRows = mosaic(teletextArt, { '#': { t: '\u2588', fg: 'cyan',   bg: 'black' } });
  const livesRows    = mosaic(livesArt,    { '#': { t: '\u2588', fg: 'yellow', bg: 'black' } });

  for (const r of teletextRows) rows.push(r); // rows 1–3
  for (const r of livesRows)    rows.push(r); // rows 4–6

  /* Row 7: blank */
  rows.push(blankRow());

  /* Row 8: date line */
  rows.push(row(
    seg(' \u25A0 ', 'yellow', 'black'),
    seg(padRight(dateStr, 14), 'cyan',  'black'),
    seg(padRight(' RESURRECTION CATEGORY', 23), 'white', 'black'),
  ));

  /* Row 9: blank */
  rows.push(blankRow());

  /* Row 10: "HEADLINE OF THE HOUR" label */
  rows.push(row(seg(padRight(' HEADLINE OF THE HOUR', COLS), 'black', 'yellow')));

  /* Row 11: live headline (or placeholder) */
  rows.push(headlineRowSpec || row(
    seg(' ', 'black', 'black'),
    seg(truncate('Loading latest headline...', COLS - 1), 'white', 'black'),
  ));

  /* Row 12: divider */
  rows.push(row(seg('\u2500'.repeat(COLS), 'blue', 'black')));

  /* Row 13: index section heading */
  rows.push(row(
    seg(padRight(' PAGE', 6), 'yellow', 'black'),
    seg(padRight('SECTION', 20), 'yellow', 'black'),
    seg(padRight('', 14), 'black', 'black'),
  ));

  /* Row 14: blank */
  rows.push(blankRow());

  /* Rows 15–21: index entries */
  const indexEntries = [
    { num: '101', name: 'NEWS HEADLINES',    colour: 'red'     },
    { num: '200', name: 'SPORT',             colour: 'green'   },
    { num: '300', name: 'WEATHER INDONESIA', colour: 'cyan'    },
    { num: '400', name: 'MARKETS CURRENCY',  colour: 'yellow'  },
    { num: '104', name: 'QUIZ',              colour: 'magenta' },
    { num: '500', name: 'ABOUT & HELP',      colour: 'white'   },
    { num: '888', name: 'SUBTITLES',         colour: 'white'   },
  ];

  for (const entry of indexEntries) {
    const r = row(
      seg('  ', 'black', 'black'),
      seg(padRight(entry.num, 4), 'yellow', 'black'),
      seg(padRight(entry.name, 24), entry.colour, 'black'),
      seg(' \u25B6', 'white', 'black'),
    );
    r._page = entry.num;
    rows.push(r);
  }

  /* Row 22: navigation hint */
  rows.push(row(seg(padCentre('TYPE A PAGE NUMBER TO NAVIGATE', COLS), 'black', 'cyan')));

  /* Row 23: fastext bar */
  rows.push(fasstextRow());

  return rows;
}

/**
 * Build the row-spec for the live headline band (row 11 of page 100).
 * Makes the entire row tappable to #102/1.
 */
function buildHeadlineRowSpec(headlineText) {
  const text = truncate(' ' + headlineText, COLS);
  const r = row(
    seg(padRight(text, COLS), 'white', 'black'),
  );
  r._page = '102';
  r._sub  = '1';
  return r;
}

registerPage(100, function(ctx) {
  /* Render the loading placeholder immediately */
  assemblePage(buildPage100Body(), '100');

  /* Then fetch live news and update row 11 in-place */
  loadNews(function onFresh(result) {
    _applyP100Headline(result);
  }).then(function(result) {
    _applyP100Headline(result);
  }).catch(function() {
    /* On total failure, patch row 11 with the error message */
    _patchP100HeadlineNode('NEWS UNAVAILABLE \u2014 SEE P101');
  });
});

/**
 * Apply a news result to p100: re-render the headline row (row 11)
 * via a lightweight DOM patch so the rest of the page (clock etc.) stays intact.
 */
function _applyP100Headline(result) {
  /* Only patch if we're still on page 100 */
  if (parseHash().page !== '100') return;

  const topItem = result && result.items && result.items[0];
  const text = topItem ? topItem.title : 'NEWS UNAVAILABLE \u2014 SEE P101';
  _patchP100HeadlineNode(text);
}

/**
 * Find the existing row 11 div in the stage and replace its contents
 * with the new headline text. Row 11 is body row index 10 (0-indexed),
 * which is overall row 11 (header is row 0, so body rows start at stage child 1).
 * Row 11 (1-indexed visible rows) = stage child index 11.
 */
function _patchP100HeadlineNode(headlineText) {
  const stage = document.getElementById('stage');
  if (!stage) return;

  /* Row 11 means the 12th child of the stage (0-indexed = 11).
   * Header is child 0; body rows start at child 1.
   * Row 11 among all rows = child index 11. */
  const rows = stage.querySelectorAll('.tt-row');
  /* rows[0] = header (row 0), rows[11] = row 11 */
  const targetRow = rows[11];
  if (!targetRow) return;

  /* Clear and rebuild */
  while (targetRow.firstChild) targetRow.removeChild(targetRow.firstChild);

  const textVal = truncate(' ' + headlineText, COLS);
  const padded  = padRight(textVal, COLS);

  /* Make row tappable if we have a real headline */
  const hasData = !headlineText.startsWith('NEWS UNAVAILABLE');
  if (hasData) {
    targetRow.dataset.page = '102';
    targetRow.dataset.sub  = '1';
    targetRow.style.cursor = 'pointer';
  }

  for (const ch of padded) {
    const sp = document.createElement('span');
    sp.textContent = ch;
    sp.className   = 'fg-white bg-black';
    targetRow.appendChild(sp);
  }
}

/* ═══════════════════════════════════════════════════════
   SECTION 12 — PAGE 101: NEWS HEADLINES
   ═══════════════════════════════════════════════════════
   Body rows 1–23:
     Rows 1–2:  double-height "NEWS HEADLINES" on blue
     Row 3:     blank
     Rows 4–21: numbered headlines (story num cyan, text white)
                each row tappable to #102/<n>
     Row 22:    data footer (cache time + source)
     Row 23:    fastext bar

   Stories are split into subpages of up to 8 entries each,
   auto-rotating every 8 s.
   ═══════════════════════════════════════════════════════ */

/**
 * Build all subpage screens for page 101.
 * @param {{items:Array, sourceName:string, fetchedAt:number, fromCache:boolean}} newsResult
 * @returns {Object[][]} array of body-row arrays (one per subpage)
 */
function buildPage101Screens(newsResult) {
  const items      = newsResult.items;
  const sourceName = newsResult.sourceName;
  const fetchedAt  = newsResult.fetchedAt;
  const fromCache  = newsResult.fromCache;

  /* Available body rows for story entries: rows 4–21 = 18 rows.
     Each story uses either 1 or 2 rows (depending on headline length).
     We group stories into pages of at most 8 stories each. */
  const STORIES_PER_PAGE = 8;
  const screens = [];

  for (let start = 0; start < items.length; start += STORIES_PER_PAGE) {
    const slice = items.slice(start, start + STORIES_PER_PAGE);
    const bodyRows = [];

    /* Rows 1–2: double-height header */
    const [dh, sp] = doubleHeight(padCentre('NEWS HEADLINES', COLS), 'white', 'blue');
    bodyRows.push(dh);
    bodyRows.push(sp);

    /* Row 3: blank */
    bodyRows.push(blankRow());

    /* Rows 4–21: story list */
    for (let i = 0; i < slice.length; i++) {
      const storyNum  = start + i + 1; // 1-based global story number
      const item      = slice[i];
      /* Number label: " 1 " style (3 chars: space + num + space) */
      const numLabel  = padLeft(String(storyNum), 2) + ' '; // "  1 " → 3 chars
      const textWidth = COLS - numLabel.length;             // 37 chars
      /* Headline wrapped to textWidth, take first line only (space is tight) */
      const wrapped   = wrapWords(item.title, textWidth);
      const line1     = wrapped[0] || '';
      const line2     = wrapped[1] || '';

      const r1 = row(
        seg(numLabel, 'cyan', 'black'),
        seg(padRight(line1, textWidth), 'white', 'black'),
      );
      r1._page = '102';
      r1._sub  = String(storyNum);
      bodyRows.push(r1);

      /* Second wrap line, if any — same tappable target */
      if (line2) {
        const indent  = ' '.repeat(numLabel.length);
        const r2 = row(
          seg(indent, 'black', 'black'),
          seg(padRight(line2, textWidth), 'white', 'black'),
        );
        r2._page = '102';
        r2._sub  = String(storyNum);
        bodyRows.push(r2);
      }
    }

    /* Pad remaining body rows with blanks up to row 21 (body index 20) */
    while (bodyRows.length < 21) bodyRows.push(blankRow());

    /* Row 22: data footer */
    bodyRows.push(newsFooterRow(fetchedAt, fromCache, sourceName));

    /* Row 23: fastext bar */
    bodyRows.push(fasstextRow());

    screens.push(bodyRows);
  }

  return screens;
}

registerPage(101, function(ctx) {
  /* Show loading state immediately */
  assemblePage(buildNewsLoadingBody('101'), '101');

  loadNews(function onFresh(result) {
    /* Called if stale cache was served and fresh data just arrived */
    if (parseHash().page !== '101') return;
    _renderPage101(result);
  }).then(function(result) {
    _renderPage101(result);
  }).catch(function() {
    if (parseHash().page !== '101') return;
    assemblePage(buildNewsErrorBody('101'), '101');
  });
});

function _renderPage101(result) {
  if (parseHash().page !== '101') return;
  const screens = buildPage101Screens(result);
  if (!screens.length) {
    assemblePage(buildNewsErrorBody('101'), '101');
    return;
  }
  if (screens.length === 1) {
    assemblePage(screens[0], '101');
  } else {
    startSubpageRotation(screens, '101', { interval: 8 });
  }
}

/* ═══════════════════════════════════════════════════════
   SECTION 13 — PAGE 102: NEWS STORY
   ═══════════════════════════════════════════════════════
   Route: #102/<storyNumber>  (1-based, clamp to range)
   Body rows 1–23:
     Rows 1–2:  double-height headline (yellow on black)
     Row 3:     blank
     Rows 4–N:  description wrapped
     Rows N+1–: blank filler
     Row 19:    source name + story timestamp (cyan)
     Row 20:    blank
     Row 21:    "Full story: domain" link (real anchor)
     Row 22:    data footer
     Row 23:    fastext bar (with ◀ PREV / ▶ NEXT via subpage stepper)

   Auto-rotation is OFF. Prev/next handled by existing steppers.
   ═══════════════════════════════════════════════════════ */

/**
 * Extract the domain from a URL for display.
 * e.g. "https://www.bbc.co.uk/news/article-123" → "bbc.co.uk"
 * @param {string} url
 * @returns {string}
 */
function _domainFromUrl(url) {
  try {
    return (new URL(url)).hostname.replace(/^www\./, '');
  } catch (e) {
    return url.slice(0, 30);
  }
}

/**
 * Format a pubDate string into a short teletext-friendly timestamp.
 * e.g. "Mon, 21 Nov 2026 12:34:56 GMT" → "Mon 21 Nov 12:34"
 * @param {string} pubDate
 * @returns {string}
 */
function _formatPubDate(pubDate) {
  if (!pubDate) return '';
  try {
    const d   = new Date(pubDate);
    const day = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
    const dm  = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const hm  = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
    return day + ' ' + dm + ' ' + hm;
  } catch (e) {
    return pubDate.slice(0, 20);
  }
}

/**
 * Build the body rows for a single story on page 102.
 * @param {Object} item        — parsed RSS item
 * @param {number} storyNum    — 1-based story number
 * @param {number} totalStories
 * @param {{sourceName:string, fetchedAt:number, fromCache:boolean}} meta
 * @returns {Object[][]}
 */
function buildPage102Body(item, storyNum, totalStories, meta) {
  const rows = [];

  /* Rows 1–2: double-height headline */
  const hl = truncate(item.title || 'NO TITLE', COLS);
  const [dh, sp] = doubleHeight(hl, 'yellow', 'black');
  rows.push(dh);
  rows.push(sp);

  /* Row 3: blank */
  rows.push(blankRow());

  /* Rows 4–N: description wrapped */
  const descLines = wrapWords(item.description || '', COLS);
  /* Take up to 8 lines of description */
  const maxDescLines = 8;
  for (let i = 0; i < Math.min(descLines.length, maxDescLines); i++) {
    rows.push(row(seg(padRight(descLines[i], COLS), 'white', 'black')));
  }

  /* Pad to row 18 (body index 17) */
  while (rows.length < 17) rows.push(blankRow());

  /* Row 19: source + date */
  const srcStr  = padRight(meta.sourceName || '', 12);
  const dateStr = _formatPubDate(item.pubDate);
  const infoLine = srcStr + ' ' + truncate(dateStr, COLS - 13);
  rows.push(row(seg(padRight(infoLine, COLS), 'cyan', 'black')));

  /* Row 20: blank */
  rows.push(blankRow());

  /* Row 21: "Full story:" domain — will be wired as a real anchor after render */
  const domain   = _domainFromUrl(item.link || '');
  const linkText = padRight('Full story: ' + truncate(domain, COLS - 13), COLS);
  const linkRow  = row(seg(linkText, 'cyan', 'black'));
  /* Mark this row for anchor-wiring after assemblePage */
  linkRow._storyLink = item.link || '';
  rows.push(linkRow);

  /* Row 22: data footer */
  rows.push(newsFooterRow(meta.fetchedAt, meta.fromCache, meta.sourceName));

  /* Row 23: fastext bar — Prev/Next labels hint at subpage steppers */
  rows.push(fasstextRow({
    red:      101,
    redLabel: 'HEADLINES',
  }));

  return rows;
}

/**
 * Wire a real <a> anchor over the "Full story:" row of page 102.
 * Finds the .tt-row that maps to row 21 (body index 20 = overall child 21)
 * and replaces it with an anchor-wrapped version.
 * @param {string} href — full story URL
 */
function _wirePage102StoryLink(href) {
  if (!href) return;
  const stage = document.getElementById('stage');
  if (!stage) return;

  const rows = stage.querySelectorAll('.tt-row');
  /* Row 21 overall (0-indexed = 21) */
  const targetRow = rows[21];
  if (!targetRow) return;

  /* Wrap the row div in a styled anchor */
  const a = document.createElement('a');
  a.href   = href;
  a.target = '_blank';
  a.rel    = 'noopener noreferrer';
  a.style.cssText = 'display:block;text-decoration:none;cursor:pointer;';

  targetRow.parentNode.insertBefore(a, targetRow);
  a.appendChild(targetRow);
}

registerPage(102, function(ctx) {
  const sub = ctx && ctx.sub;

  /* Show loading state immediately */
  assemblePage(buildNewsLoadingBody('102'), '102');

  loadNews(function onFresh(result) {
    if (parseHash().page !== '102') return;
    _renderPage102(result, sub);
  }).then(function(result) {
    _renderPage102(result, sub);
  }).catch(function() {
    if (parseHash().page !== '102') return;
    assemblePage(buildNewsErrorBody('102'), '102');
  });
});

function _renderPage102(result, subParam) {
  if (parseHash().page !== '102') return;

  const items = result.items;
  if (!items || !items.length) {
    assemblePage(buildNewsErrorBody('102'), '102');
    return;
  }

  /* Determine story index (1-based, clamp to [1, items.length]) */
  let storyNum = parseInt(subParam, 10) || 1;
  storyNum = Math.max(1, Math.min(storyNum, items.length));

  /* Build all story screens for the subpage stepper (but don't auto-rotate) */
  const screens = [];
  const meta = {
    sourceName: result.sourceName,
    fetchedAt:  result.fetchedAt,
    fromCache:  result.fromCache,
  };
  for (let i = 0; i < items.length; i++) {
    screens.push(buildPage102Body(items[i], i + 1, items.length, meta));
  }

  /* Use startSubpageRotation framework with rotation disabled via HOLD,
     starting at the requested story (0-indexed). */
  /* We wire it as a custom subpage rotation: auto-advance OFF, manual only. */
  _startPage102Rotation(screens, storyNum - 1);
}

/**
 * Wire page 102 stories into the subpage stepper without auto-rotation.
 * @param {Object[][][]} screens — array of body-row arrays
 * @param {number}       startAt — 0-indexed starting story
 */
function _startPage102Rotation(screens, startAt) {
  /* Temporarily set a very long interval so the framework doesn't auto-advance,
     then immediately engage HOLD. */
  startSubpageRotation(screens, '102', { interval: 86400, startAt: startAt });

  /* Auto-rotation off on this page — engage HOLD */
  if (_subpageState) {
    _subpageState.hold = true;
    updateHoldButton();
  }

  /* Wire the story link anchor for the initial screen */
  _wireCurrentStoryLink(screens, startAt);
}

/**
 * Wire the story link anchor after rendering a given screen.
 * Called once per subpage render.
 */
function _wireCurrentStoryLink(screens, idx) {
  const bodyRows = screens[idx];
  if (!bodyRows) return;
  /* Find the row with _storyLink */
  for (const r of bodyRows) {
    if (r._storyLink) {
      _wirePage102StoryLink(r._storyLink);
      break;
    }
  }
}

/**
 * Override _renderSubpage to wire story links on page 102.
 * We monkey-patch the subpage state's onBeforeRender so the link
 * is always wired after each subpage switch.
 *
 * Since _renderSubpage is a plain function in this file, we intercept
 * it by patching the subpageState after startSubpageRotation on p102.
 *
 * Actually the cleaner approach: we override p102's step handling.
 * The stepSubpage() function calls _renderSubpage(next).
 * _renderSubpage calls assemblePage → wireClockNode → wireDataPageLinks.
 * After that, we need _wirePage102StoryLink to run.
 *
 * We do this by hooking into the existing _renderSubpage wrapper
 * via a p102-specific post-render hook stored in _subpageState.
 */
(function patchRenderSubpageForP102() {
  /* Called after each subpage render on p102. Stored on _subpageState. */
})();

/* Re-define renderSubpage to call a post-render hook if set. */
const _origRenderSubpage = _renderSubpage;
/* Note: _renderSubpage is a local function defined before this point.
   We cannot reassign it in strict mode if it was declared with function declaration.
   Instead, we store a callback on _subpageState and call it at the right moment.
   We override _startPage102Rotation to set this callback. */

/* Patch: after startSubpageRotation for p102, attach a post-render hook.
   We achieve this by overriding _startPage102Rotation to call
   a wrapper that patches _renderSubpage indirectly via requestAnimationFrame. */

/* The simplest reliable approach: check in wireDataPageLinks (which is a no-op)
   and instead we always call _wirePage102StoryLink inside _renderPage102.
   For subsequent prev/next presses, the step handler calls _renderSubpage(),
   which calls assemblePage(). After that call returns, the link row is in the DOM.
   We patch _subpageState with a postRender callback that _renderSubpage will invoke. */

/* Re-implement _renderSubpage as a wrapper that calls postRender if set. */
/* We can't re-declare a function-declaration, but we can shadow with var in sloppy.
   We're in 'use strict' mode — so we cannot var-shadow either.
   SOLUTION: store postRender on _subpageState; have the BOOT code patch assemblePage. */

/* ---- Cleanest approach in strict mode: attach postRender to _subpageState
        and call it from wireDataPageLinks, which is already called from assemblePage. ---- */

/* Override wireDataPageLinks (which is currently a no-op) to invoke
   _subpageState.postRender when set. This is the designated extension point. */
/* wireDataPageLinks is defined before assemblePage in the code.
   We'll redefine it as a var-assignment to a new function here. */

function renderPageNotFound(pageNum) {
  clearPageTimers();
  const rows = [];

  /* Row 1: blank */
  rows.push(blankRow());

  /* Rows 2–3: double-height "PAGE NOT FOUND" on red */
  const [dh, sp] = doubleHeight(padCentre('PAGE NOT FOUND', COLS), 'white', 'red');
  rows.push(dh);
  rows.push(sp);

  /* Row 4: blank */
  rows.push(blankRow());

  /* Row 5: requested page number */
  const msg5 = 'PAGE ' + String(pageNum) + ' DOES NOT EXIST';
  rows.push(row(seg(padCentre(msg5, COLS), 'yellow', 'black')));

  /* Row 6: blank */
  rows.push(blankRow());

  /* Row 7: for a list of all pages */
  rows.push(row(seg(padCentre('FOR A LIST OF ALL PAGES:', COLS), 'white', 'black')));

  /* Row 8: pointer */
  rows.push(row(seg(padCentre('\u25A0 SEE INDEX PAGE 100', COLS), 'cyan', 'black')));

  /* Rows 9–22: blank */
  for (let i = 9; i <= 22; i++) rows.push(blankRow());

  /* Row 23: fastext bar */
  rows.push(fasstextRow());

  assemblePage(rows, String(pageNum));
}

/* ═══════════════════════════════════════════════════════
   SECTION 12 — HASH ROUTER
   ═══════════════════════════════════════════════════════
   Hash formats:
     #100       → { page: '100', sub: null }
     #102/3     → { page: '102', sub: '3'  }
   Defaults to page 100 when hash is absent.
   ═══════════════════════════════════════════════════════ */

/** Parse location.hash → { page, sub } */
function parseHash() {
  const hash = (location.hash || '').replace(/^#/, '').trim();
  if (!hash) return { page: '100', sub: null };
  const parts = hash.split('/');
  return {
    page: parts[0] || '100',
    sub:  parts[1] || null,
  };
}

/**
 * Navigate: set the URL hash, which triggers route() via hashchange.
 */
function navigate(page, sub) {
  const hash = sub ? String(page) + '/' + String(sub) : String(page);
  if (location.hash === '#' + hash) {
    route();
  } else {
    location.hash = hash;
  }
}

/** Route handler — called on hashchange and on boot. */
function route() {
  clearPageTimers();
  const { page, sub } = parseHash();
  const renderer = PAGES[page];
  if (renderer) {
    renderer({ page: page, sub: sub });
  } else {
    renderPageNotFound(page);
  }
}

/* ═══════════════════════════════════════════════════════
   SECTION 13 — INPUT SYSTEM: DIGIT ENTRY (5.1)
   ═══════════════════════════════════════════════════════
   _digitBuffer: 0–3 chars. Typing any digit 0–9 starts
   entry. The header page indicator updates live.
   On 3rd digit: navigate instantly.
   Backspace removes last digit. Esc cancels entirely.
   "0" alone does nothing until a 2nd digit follows (the
   buffer starts with "0", completing on 3rd digit).
   ═══════════════════════════════════════════════════════ */

/** Push a digit character into the entry buffer. */
function digitInput(ch) {
  if (_digitBuffer.length >= 3) return; // already full (shouldn't happen)
  _digitBuffer += ch;
  updatePagenumDisplay();

  if (_digitBuffer.length === 3) {
    const page = _digitBuffer;
    _digitBuffer = '';
    navigate(page);
  }
}

/** Remove last digit from buffer (Backspace). */
function digitBackspace() {
  if (_digitBuffer.length === 0) return;
  _digitBuffer = _digitBuffer.slice(0, -1);
  updatePagenumDisplay();
}

/** Cancel digit entry (Esc). */
function digitCancel() {
  if (_digitBuffer.length === 0) return;
  _digitBuffer = '';
  updatePagenumDisplay();
}

/* ═══════════════════════════════════════════════════════
   SECTION 14 — INPUT SYSTEM: FASTEXT WIRING (5.2)
   ═══════════════════════════════════════════════════════
   wireFastextBlocks(): called after each assemblePage().
   Finds the last row div (fastext bar) and groups its 40
   spans into four 10-span blocks by bg colour class.
   Each block gets a click listener navigating to the
   corresponding target from _fasstextTargets.
   Also wires any [data-page] element in the stage.
   ═══════════════════════════════════════════════════════ */

function wireFastextBlocks() {
  const stage = document.getElementById('stage');
  const rows  = stage.querySelectorAll('.tt-row, .dh-block');
  if (!rows.length) return;
  const lastRow = rows[rows.length - 1];

  // Map each 10-char block to its colour and target
  const colourMap = [
    { colour: 'red',    spans: [0,  9]  },
    { colour: 'green',  spans: [10, 19] },
    { colour: 'yellow', spans: [20, 29] },
    { colour: 'cyan',   spans: [30, 39] },
  ];

  const allSpans = Array.from(lastRow.querySelectorAll('span'));
  if (allSpans.length < 40) return;

  colourMap.forEach(({ colour, spans: [start, end] }) => {
    const target = _fasstextTargets[colour];
    if (!target) return;

    // Wrap the 10 spans in a clickable div
    const block = document.createElement('span');
    block.className = 'fastext-block';
    block.dataset.fasstextColour = colour;
    block.style.cssText =
      'display:inline-flex;' +
      'height:100%;' +
      'cursor:pointer;' +
      'align-items:flex-start;';

    const firstSpan = allSpans[start];
    lastRow.insertBefore(block, firstSpan);
    for (let i = start; i <= end; i++) {
      block.appendChild(allSpans[i]);
    }

    block.addEventListener('click', function() {
      navigate(String(target));
    });
  });
}

/**
 * Wire a single delegated click handler on the stage for [data-page] navigation.
 * Called once at boot. Works for any element rendered at any time.
 */
function wireDataPageDelegation() {
  const stage = document.getElementById('stage');
  if (!stage) return;
  stage.addEventListener('click', function(e) {
    const target = e.target.closest('[data-page]');
    if (!target) return;
    const page = target.dataset.page;
    const sub  = target.dataset.sub || null;
    if (page) navigate(page, sub);
  });
}

/** @deprecated — delegation is now set up once at boot via wireDataPageDelegation(). */
function wireDataPageLinks() {
  // No-op: kept so assemblePage() calls it without error.
}

/* ═══════════════════════════════════════════════════════
   SECTION 15 — SUBPAGE ROTATION FRAMEWORK (5.3)
   ═══════════════════════════════════════════════════════
   Pages that have multiple screens call startSubpageRotation().
   The framework:
     - Renders the first (or specified) subpage immediately
     - Shows "n/total" in the header
     - Auto-rotates at interval (default 8 s)
     - HOLD (H key / HOLD button) freezes/unfreezes
     - Prev/Next (← → keys / ◀ ▶ buttons) step manually
       and pause auto-rotation for 30 s
     - Pauses when document is hidden (visibilitychange)
     - Cleans up all timers on navigation (clearPageTimers)
   ═══════════════════════════════════════════════════════ */

// _subpageState is declared at top of file (see Section 1 input state)

/** True when a subpage rotation is active. */
function hasSubpages() {
  return !!(_subpageState && _subpageState.screens.length > 1);
}

/** Render the nth subpage (0-indexed) of the current rotation. */
function _renderSubpage(n) {
  if (!_subpageState) return;
  const st = _subpageState;
  const screen = st.screens[n];
  const subLabel = (n + 1) + '/' + st.screens.length;
  st.current = n;
  assemblePage(screen, String(st.pageNum), subLabel);

  // Update URL hash without triggering a full route cycle
  const newHash = '#' + st.pageNum + '/' + (n + 1);
  if (location.hash !== newHash) {
    history.replaceState(null, '', newHash);
  }

  updateHoldButton();
}

/** Start subpage rotation for a multi-screen page. */
function startSubpageRotation(screens, pageNum, options) {
  const opts = options || {};
  const interval = (opts.interval || 8) * 1000;
  const startAt  = (opts.startAt  || 0);

  // Clear any previous rotation
  if (_subpageState && _subpageState.rotateIntervalId) {
    clearInterval(_subpageState.rotateIntervalId);
  }

  _subpageState = {
    screens:          screens,
    pageNum:          pageNum,
    interval:         interval,
    current:          startAt,
    hold:             false,
    pauseTimer:       null,
    rotateIntervalId: null,
  };

  _renderSubpage(startAt);
  _startRotateInterval();
}

function _startRotateInterval() {
  if (!_subpageState) return;
  if (_subpageState.rotateIntervalId) clearInterval(_subpageState.rotateIntervalId);

  const id = setInterval(function() {
    if (!_subpageState) return;
    if (_subpageState.hold) return;
    if (document.hidden) return;
    const next = (_subpageState.current + 1) % _subpageState.screens.length;
    _renderSubpage(next);
  }, _subpageState.interval);

  _subpageState.rotateIntervalId = id;
  _pageTimers.push(id); // ensure cleanup on navigation
}

/** Step subpage forward (+1) or backward (-1). Pauses auto-rotation for 30 s. */
function stepSubpage(dir) {
  if (!hasSubpages()) return;
  const st = _subpageState;
  const total = st.screens.length;
  const next  = ((st.current + dir) + total) % total;
  _renderSubpage(next);

  // Pause auto-rotation for 30 s (manual override)
  if (st.pauseTimer) {
    clearTimeout(st.pauseTimer);
    _pageTimers = _pageTimers.filter(id => id !== st.pauseTimer);
  }
  const wasHold = st.hold;
  st.hold = true; // temporarily hold during pause
  updateHoldButton();

  const tid = setTimeout(function() {
    if (_subpageState === st && !wasHold) {
      st.hold = false;
      updateHoldButton();
    }
    st.pauseTimer = null;
  }, 30000);
  st.pauseTimer = tid;
  _pageTimers.push(tid);
}

/** Toggle HOLD state. */
function toggleHold() {
  if (!hasSubpages()) return;
  _subpageState.hold = !_subpageState.hold;

  // If a manual pause timer is running, cancel it when user explicitly toggles
  if (_subpageState.pauseTimer) {
    clearTimeout(_subpageState.pauseTimer);
    _pageTimers = _pageTimers.filter(id => id !== _subpageState.pauseTimer);
    _subpageState.pauseTimer = null;
  }

  updateHoldButton();
}

/** Sync the HOLD button's visual state. */
function updateHoldButton() {
  const btn = document.querySelector('.kp-hold');
  if (!btn) return;
  if (_subpageState && _subpageState.hold) {
    btn.classList.add('hold-active');
    btn.textContent = 'HELD';
  } else {
    btn.classList.remove('hold-active');
    btn.textContent = 'HOLD';
  }
}

/** Pause rotation when tab is hidden; resume when visible. */
function _onVisibilityChange() {
  if (!_subpageState) return;
  if (document.hidden) {
    // Nothing to do — the interval checks document.hidden already.
  } else {
    // Tab became visible — just let the interval resume naturally.
  }
}

document.addEventListener('visibilitychange', _onVisibilityChange);

/* ═══════════════════════════════════════════════════════
   SECTION 16 — KEYBOARD + KEYPAD EVENT HANDLERS
   ═══════════════════════════════════════════════════════ */

/** Handle a key action string from keyboard or keypad button. */
function handleAction(action) {
  switch (action) {
    case 'home':
      _digitBuffer = '';
      updatePagenumDisplay();
      navigate('100');
      break;
    case 'back':
      digitBackspace();
      break;
    case 'hold':
      toggleHold();
      break;
    case 'prev':
      stepSubpage(-1);
      break;
    case 'next':
      stepSubpage(+1);
      break;
    case 'reveal':
      if (typeof _quizRevealNext === 'function') _quizRevealNext();
      break;
  }
}

/** Global keydown handler. */
function onKeydown(e) {
  // Don't intercept if focus is on an input/button (keypad taps fire their own click)
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  const key = e.key;

  // Digit entry: 0–9
  if (/^[0-9]$/.test(key)) {
    // Don't prevent default for buttons — let click fire naturally;
    // but for keyboard we handle it here.
    if (tag === 'BUTTON') return; // let button's click handle it
    e.preventDefault();
    digitInput(key);
    return;
  }

  // Backspace
  if (key === 'Backspace') {
    e.preventDefault();
    digitBackspace();
    return;
  }

  // Escape — cancel digit entry
  if (key === 'Escape') {
    e.preventDefault();
    digitCancel();
    return;
  }

  // HOLD — H key
  if (key === 'h' || key === 'H') {
    e.preventDefault();
    toggleHold();
    return;
  }

  // Subpage navigation — arrow keys
  if (key === 'ArrowLeft') {
    e.preventDefault();
    stepSubpage(-1);
    return;
  }
  if (key === 'ArrowRight') {
    e.preventDefault();
    stepSubpage(+1);
    return;
  }

  // Fastext keys — R/G/Y/C
  if (key === 'r' || key === 'R') { e.preventDefault(); navigate(String(_fasstextTargets.red));    return; }
  if (key === 'g' || key === 'G') { e.preventDefault(); navigate(String(_fasstextTargets.green));  return; }
  if (key === 'y' || key === 'Y') { e.preventDefault(); navigate(String(_fasstextTargets.yellow)); return; }
  if (key === 'c' || key === 'C') { e.preventDefault(); navigate(String(_fasstextTargets.cyan));   return; }

  // REVEAL key — V (quiz page p104)
  if (key === 'v' || key === 'V') {
    e.preventDefault();
    if (typeof _quizRevealNext === 'function') _quizRevealNext();
    return;
  }
}

document.addEventListener('keydown', onKeydown);

/** Wire on-screen keypad buttons. */
function wireKeypad() {
  const keypad = document.getElementById('keypad');
  if (!keypad) return;

  keypad.addEventListener('click', function(e) {
    const btn = e.target.closest('[data-digit],[data-action]');
    if (!btn) return;

    const digit  = btn.dataset.digit;
    const action = btn.dataset.action;

    if (digit !== undefined) {
      digitInput(digit);
    } else if (action) {
      handleAction(action);
    }
  });
}

/* ═══════════════════════════════════════════════════════
   SECTION 18 — WEATHER: WMO CODE MAPPING + MOSAIC ICONS
   ═══════════════════════════════════════════════════════
   wmoLabel(code)   → short text label (≤12 chars)
   wmoGroup(code)   → 'sun' | 'cloud' | 'fog' | 'drizzle'
                      | 'rain' | 'snow' | 'showers' | 'thunder'
   weatherIconRows(group, fg) → array of row-specs (mosaic art)
   ═══════════════════════════════════════════════════════ */

/**
 * Map a WMO weather interpretation code to a short teletext label.
 * WMO codes: https://open-meteo.com/en/docs#weathervariables
 * @param {number} code
 * @returns {string}
 */
function wmoLabel(code) {
  if (code === 0)                    return 'CLEAR';
  if (code === 1)                    return 'MAINLY CLEAR';
  if (code === 2)                    return 'PARTLY CLOUDY';
  if (code === 3)                    return 'OVERCAST';
  if (code === 45 || code === 48)    return 'FOG';
  if (code >= 51 && code <= 55)      return 'DRIZZLE';
  if (code >= 56 && code <= 57)      return 'FRZING DRIZZLE';
  if (code >= 61 && code <= 65)      return 'RAIN';
  if (code >= 66 && code <= 67)      return 'FRZING RAIN';
  if (code >= 71 && code <= 77)      return 'SNOW';
  if (code >= 80 && code <= 82)      return 'SHOWERS';
  if (code === 85 || code === 86)    return 'SNOW SHOWERS';
  if (code === 95)                   return 'THUNDER';
  if (code >= 96 && code <= 99)      return 'THUNDER+HAIL';
  return 'UNKNOWN';
}

/**
 * Map a WMO code to a named condition group for icon selection.
 * @param {number} code
 * @returns {string}
 */
function wmoGroup(code) {
  if (code === 0 || code === 1)      return 'sun';
  if (code === 2 || code === 3)      return 'cloud';
  if (code === 45 || code === 48)    return 'fog';
  if (code >= 51 && code <= 57)      return 'drizzle';
  if (code >= 61 && code <= 67)      return 'rain';
  if (code >= 71 && code <= 77)      return 'snow';
  if (code >= 80 && code <= 86)      return 'showers';
  if (code >= 95 && code <= 99)      return 'thunder';
  return 'cloud';
}

/*
 * Mosaic icons — 5 rows × 10 chars each, left-aligned.
 * Characters in the art string:
 *   '#' → filled block █ in the icon foreground colour
 *   '.' → space (black background)
 * Each icon is 10 chars wide × 5 rows tall.
 */
const _ICON_ART = {
  sun: [
    '.#...#..#.',
    '..#.###...',
    '#..###..##',
    '..#.###...',
    '.#...#..#.',
  ],
  cloud: [
    '..........',
    '..####....',
    '.######...',
    '.######...',
    '..........',
  ],
  fog: [
    '##########',
    '..........',
    '##########',
    '..........',
    '##########',
  ],
  drizzle: [
    '..####....',
    '.######...',
    '.######...',
    '..#.#.#...',
    '...#.#....',
  ],
  rain: [
    '..####....',
    '.######...',
    '.######...',
    '.#.#.#.#..',
    '..#.#.#...',
  ],
  snow: [
    '.#..#..#..',
    '#.#.#.#...',
    '.#.#.#.#..',
    '#.#.#.#...',
    '.#..#..#..',
  ],
  showers: [
    '..####....',
    '.######...',
    '.######...',
    '..##.##...',
    '.#.#.#.#..',
  ],
  thunder: [
    '..####....',
    '.######...',
    '.######...',
    '...##.....',
    '....##....',
  ],
};

/**
 * Build an array of 5 icon segment arrays (one per row) for the weather icon.
 * Each inner array is exactly 10 segments (one per character), NOT padded to COLS.
 * Use these segments in combination with other segments inside row().
 * @param {string} group    — from wmoGroup()
 * @param {string} [fg='cyan']
 * @returns {Object[][]}    — 5 arrays of 10 segments each
 */
function weatherIconRows(group, fg) {
  const art   = _ICON_ART[group] || _ICON_ART.cloud;
  const fgCol = fg || 'cyan';
  return art.map(function(line) {
    const segs = [];
    for (let i = 0; i < 10; i++) {
      const ch = line[i] || ' ';
      if (ch === '.' || ch === ' ') {
        segs.push(seg(' ', 'black', 'black'));
      } else {
        segs.push(seg('\u2588', fgCol, 'black'));
      }
    }
    return segs; // exactly 10 segments, no COLS padding
  });
}

/* ═══════════════════════════════════════════════════════
   SECTION 19 — WEATHER: CITY CONFIGS + OPEN-METEO FETCHER
   ═══════════════════════════════════════════════════════ */

/* ── 19.1  Open-Meteo API URL builder ──────────────────── */

/**
 * Build an Open-Meteo forecast URL for the given lat/lon/timezone.
 * Requests: current conditions + 7-day daily forecast.
 * @param {number} lat
 * @param {number} lon
 * @param {string} tz  — IANA timezone string
 * @returns {string}
 */
function _openMeteoUrl(lat, lon, tz) {
  const base = 'https://api.open-meteo.com/v1/forecast';
  const current = [
    'temperature_2m',
    'relative_humidity_2m',
    'apparent_temperature',
    'weather_code',
    'wind_speed_10m',
    'wind_direction_10m',
  ].join(',');
  const daily = [
    'weather_code',
    'temperature_2m_max',
    'temperature_2m_min',
    'precipitation_probability_max',
  ].join(',');
  return base +
    '?latitude='     + lat +
    '&longitude='    + lon +
    '&current='      + current +
    '&daily='        + daily +
    '&forecast_days=7' +
    '&timezone='     + encodeURIComponent(tz) +
    '&wind_speed_unit=kmh';
}

/**
 * Fetch and cache weather data for a single city.
 * @param {Object} city — { name, lat, lon, tz }
 * @param {function} [onFresh]
 * @returns {Promise<{data:Object, fetchedAt:number, fromCache:boolean}>}
 */
async function fetchCityWeather(city, onFresh) {
  const url = _openMeteoUrl(city.lat, city.lon, city.tz);
  return await getJSONCached(url, TTL.WEATHER, onFresh);
}

/* ── 19.2  Indonesian city list ────────────────────────── */

const INDONESIAN_CITIES = [
  { name: 'Jakarta',     lat: -6.2088, lon: 106.8456, tz: 'Asia/Jakarta'    },
  { name: 'Surabaya',    lat: -7.2492, lon: 112.7508, tz: 'Asia/Jakarta'    },
  { name: 'Bandung',     lat: -6.9175, lon: 107.6191, tz: 'Asia/Jakarta'    },
  { name: 'Medan',       lat:  3.5952, lon:  98.6722, tz: 'Asia/Jakarta'    },
  { name: 'Yogyakarta',  lat: -7.7956, lon: 110.3695, tz: 'Asia/Jakarta'    },
  { name: 'Semarang',    lat: -6.9932, lon: 110.4203, tz: 'Asia/Jakarta'    },
  { name: 'Denpasar',    lat: -8.6705, lon: 115.2126, tz: 'Asia/Makassar'   },
  { name: 'Makassar',    lat: -5.1477, lon: 119.4327, tz: 'Asia/Makassar'   },
  { name: 'Palembang',   lat: -2.9761, lon: 104.7754, tz: 'Asia/Jakarta'    },
  { name: 'Balikpapan',  lat: -1.2379, lon: 116.8529, tz: 'Asia/Makassar'   },
];

/* ── 19.3  World city list ─────────────────────────────── */

const WORLD_CITIES = [
  { name: 'Singapore',    lat:  1.3521, lon: 103.8198, tz: 'Asia/Singapore'  },
  { name: 'Kuala Lumpur', lat:  3.1390, lon: 101.6869, tz: 'Asia/Kuala_Lumpur' },
  { name: 'Bangkok',      lat: 13.7563, lon: 100.5018, tz: 'Asia/Bangkok'    },
  { name: 'Tokyo',        lat: 35.6762, lon: 139.6503, tz: 'Asia/Tokyo'      },
  { name: 'Sydney',       lat: -33.8688, lon: 151.2093, tz: 'Australia/Sydney' },
  { name: 'London',       lat: 51.5074, lon:  -0.1278, tz: 'Europe/London'   },
  { name: 'New York',     lat: 40.7128, lon: -74.0060, tz: 'America/New_York' },
  { name: 'Dubai',        lat: 25.2048, lon:  55.2708, tz: 'Asia/Dubai'      },
  { name: 'Amsterdam',    lat: 52.3676, lon:   4.9041, tz: 'Europe/Amsterdam' },
  { name: 'Seoul',        lat: 37.5665, lon: 126.9780, tz: 'Asia/Seoul'      },
];

/* ── 19.4  Wind direction helper ───────────────────────── */

/**
 * Convert degrees to a compass abbreviation.
 * @param {number} deg
 * @returns {string}  e.g. "NE", "SSW"
 */
function _windDir(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                'S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const idx = Math.round(((deg % 360) + 360) / 22.5) % 16;
  return dirs[idx];
}

/* ── 19.5  Local time helper ───────────────────────────── */

/**
 * Get current local time as "HH:MM" in a given timezone.
 * @param {string} tz  — IANA timezone
 * @returns {string}
 */
function _localTime(tz) {
  return new Date().toLocaleTimeString('en-GB', {
    timeZone: tz,
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  });
}

/* ── 19.6  Day-of-week label from ISO date string ──────── */

/**
 * Convert "2026-11-21" → "SAT" (3-char uppercase).
 * @param {string} dateStr
 * @returns {string}
 */
function _dayLabel(dateStr) {
  try {
    // Parse as UTC noon to avoid timezone shifts
    const d = new Date(dateStr + 'T12:00:00Z');
    return d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }).toUpperCase();
  } catch (e) {
    return '???';
  }
}

/* ── 19.7  Weather footer row builder ─────────────────── */

/**
 * Build the data footer row for weather pages.
 * "WEATHER DATA BY OPEN-METEO.COM   DATA HH:MM" or "DATA FROM CACHE HH:MM".
 * @param {number}  fetchedAt
 * @param {boolean} fromCache
 * @returns {Object[]}
 */
function weatherFooterRow(fetchedAt, fromCache) {
  const timeStr = jakartaHHMM(fetchedAt);
  const dataLabel = fromCache
    ? 'DATA FROM CACHE ' + timeStr
    : 'DATA ' + timeStr;
  // "OPEN-METEO.COM  " left, data label right; total 40
  const left   = 'OPEN-METEO.COM';
  const right  = dataLabel;
  const gap    = COLS - left.length - right.length;
  const gapStr = gap > 0 ? ' '.repeat(gap) : ' ';
  return row(
    seg(left,            'black', 'cyan'),
    seg(gapStr,          'black', 'cyan'),
    seg(right,           'black', 'cyan'),
  );
}

/* ── 19.8  Weather loading/error body builders ─────────── */

/**
 * Build the in-universe loading screen for weather pages.
 * @param {string} pageNum
 * @param {string} [pageName='WEATHER SERVICE']
 * @returns {Object[][]}
 */
function buildWeatherLoadingBody(pageNum, pageName) {
  const name = pageName || 'WEATHER SERVICE';
  const rows = [];

  rows.push(blankRow());

  const [dh, sp] = doubleHeight(padCentre(name, COLS), 'white', 'blue');
  rows.push(dh);
  rows.push(sp);

  rows.push(blankRow());

  rows.push(row(seg(padCentre('P' + pageNum + '  \u2026searching', COLS), 'yellow', 'black')));
  rows.push(row(seg(padCentre('\u2588', COLS), 'cyan', 'black')));

  for (let i = 7; i <= 22; i++) rows.push(blankRow());

  rows.push(fasstextRow({ yellow: parseInt(pageNum, 10) }));

  return rows;
}

/**
 * Build the in-universe error page for weather.
 * @param {string} pageNum
 * @returns {Object[][]}
 */
function buildWeatherErrorBody(pageNum) {
  const rows = [];

  rows.push(blankRow());

  const [dh, sp] = doubleHeight(padCentre('WEATHER SERVICE', COLS), 'white', 'blue');
  rows.push(dh);
  rows.push(sp);

  rows.push(blankRow());

  rows.push(row(seg(padCentre('SERVICE TEMPORARILY UNAVAILABLE', COLS), 'yellow', 'black')));
  rows.push(row(seg(padCentre('PLEASE TRY LATER', COLS), 'white', 'black')));

  rows.push(blankRow());

  rows.push(row(seg(padCentre('P' + pageNum + '  NO DATA AVAILABLE', COLS), 'cyan', 'black')));

  for (let i = 10; i <= 22; i++) rows.push(blankRow());

  rows.push(fasstextRow({
    red:      parseInt(pageNum, 10),
    redLabel: 'RETRY   ',
    yellow:   parseInt(pageNum, 10),
  }));

  return rows;
}

/* ═══════════════════════════════════════════════════════
   SECTION 20 — PAGE 300: WEATHER — INDONESIA
   ═══════════════════════════════════════════════════════
   Subpages:
     1   — Jakarta now: big temp, condition icon, 7-day table
     2–N — Each remaining Indonesian city: current + today max/min
   Auto-rotate every 8 s.
   ═══════════════════════════════════════════════════════ */

/**
 * Build the Jakarta "now" subpage body rows.
 * @param {Object} wx       — Open-Meteo API response
 * @param {number} fetchedAt
 * @param {boolean} fromCache
 * @returns {Object[][]}    — 23 body rows
 */
function buildJakartaNowBody(wx, fetchedAt, fromCache) {
  const rows = [];
  const cur  = wx.current;
  const dai  = wx.daily;

  // Extract current values
  const temp     = Math.round(cur.temperature_2m);
  const feels    = Math.round(cur.apparent_temperature);
  const humidity = Math.round(cur.relative_humidity_2m);
  const wind     = Math.round(cur.wind_speed_10m);
  const wdir     = _windDir(cur.wind_direction_10m);
  const code     = cur.weather_code;
  const label    = wmoLabel(code);
  const group    = wmoGroup(code);

  /* Row 1: blank */
  rows.push(blankRow());

  /* Rows 2–3: double-height "JAKARTA NOW" header */
  const [dh, sp] = doubleHeight(' JAKARTA NOW', 'yellow', 'blue');
  rows.push(dh);
  rows.push(sp);

  /* Row 4: blank */
  rows.push(blankRow());

  /* Rows 5–9: temperature (big) + icon side by side
     Left col (30 chars): temp + condition + feels/humidity/wind
     Right col (10 chars): 5-row mosaic icon */

  const iconRows = weatherIconRows(group, 'cyan');   // 5 × 10 chars
  const tempStr  = temp + '\u00B0C';                 // e.g. "28°C"
  const leftCols = COLS - 10;                        // 30

  // Row 5: temperature (large) + icon row 0
  rows.push(row(
    seg(padRight(tempStr, leftCols), 'cyan', 'black'),
    ...iconRows[0],
  ));

  // Row 6: condition label + icon row 1
  rows.push(row(
    seg(padRight(label, leftCols), 'white', 'black'),
    ...iconRows[1],
  ));

  // Row 7: feels-like + icon row 2
  rows.push(row(
    seg(padRight('Feels like ' + feels + '\u00B0C', leftCols), 'white', 'black'),
    ...iconRows[2],
  ));

  // Row 8: humidity + icon row 3
  rows.push(row(
    seg(padRight('Humidity ' + humidity + '%', leftCols), 'white', 'black'),
    ...iconRows[3],
  ));

  // Row 9: wind + icon row 4
  rows.push(row(
    seg(padRight('Wind ' + wind + ' km/h ' + wdir, leftCols), 'white', 'black'),
    ...iconRows[4],
  ));

  /* Row 10: blank */
  rows.push(blankRow());

  /* Row 11: 7-day table header */
  rows.push(row(
    seg(padRight('DAY ',  5), 'black', 'yellow'),
    seg(padRight('MAX',   5), 'black', 'yellow'),
    seg(padRight('MIN',   5), 'black', 'yellow'),
    seg(padRight('RAIN%', 6), 'black', 'yellow'),
    seg(padRight('COND',  COLS - 21), 'black', 'yellow'),
  ));

  /* Rows 12–18: 7 days */
  const dates    = dai.time || [];
  const maxTemps = dai.temperature_2m_max || [];
  const minTemps = dai.temperature_2m_min || [];
  const precip   = dai.precipitation_probability_max || [];
  const codes    = dai.weather_code || [];

  for (let i = 0; i < 7 && i < dates.length; i++) {
    const dayLbl  = i === 0 ? 'TODAY' : _dayLabel(dates[i]);
    const maxT    = Math.round(maxTemps[i]) + '\u00B0';
    const minT    = Math.round(minTemps[i]) + '\u00B0';
    const rain    = (precip[i] !== null && precip[i] !== undefined)
                    ? String(Math.round(precip[i])) + '%' : '---';
    const cond    = truncate(wmoLabel(codes[i]), COLS - 21);

    rows.push(row(
      seg(padRight(dayLbl, 5), 'cyan',   'black'),
      seg(padRight(maxT,   5), 'yellow', 'black'),
      seg(padRight(minT,   5), 'white',  'black'),
      seg(padRight(rain,   6), 'green',  'black'),
      seg(padRight(cond,   COLS - 21), 'white',  'black'),
    ));
  }

  /* Pad to row 20 (body index 19) */
  while (rows.length < 19) rows.push(blankRow());

  /* Row 20: blank */
  rows.push(blankRow());

  /* Row 21: "MORE CITIES" hint */
  rows.push(row(seg(padCentre('\u25B6 MORE INDONESIAN CITIES  SUBPAGES', COLS), 'cyan', 'black')));

  /* Row 22: weather footer */
  rows.push(weatherFooterRow(fetchedAt, fromCache));

  /* Row 23: fastext bar */
  rows.push(fasstextRow({ yellow: 300 }));

  return rows;
}

/**
 * Build a single Indonesian city subpage body rows.
 * Shows current temp, condition + icon, and today max/min.
 * @param {Object} city         — from INDONESIAN_CITIES
 * @param {Object} wx           — Open-Meteo response
 * @param {number} cityIndex    — 0-based index among non-Jakarta cities
 * @param {number} totalCities  — total number of non-Jakarta cities
 * @param {number} fetchedAt
 * @param {boolean} fromCache
 * @returns {Object[][]}
 */
function buildCitySubpageBody(city, wx, cityIndex, totalCities, fetchedAt, fromCache) {
  const rows = [];
  const cur  = wx.current;
  const dai  = wx.daily;

  const temp     = Math.round(cur.temperature_2m);
  const feels    = Math.round(cur.apparent_temperature);
  const humidity = Math.round(cur.relative_humidity_2m);
  const wind     = Math.round(cur.wind_speed_10m);
  const wdir     = _windDir(cur.wind_direction_10m);
  const code     = cur.weather_code;
  const label    = wmoLabel(code);
  const group    = wmoGroup(code);

  // Today's max/min from daily[0]
  const maxT    = dai.temperature_2m_max    && dai.temperature_2m_max[0]    != null
                  ? Math.round(dai.temperature_2m_max[0])    + '\u00B0C' : '---';
  const minT    = dai.temperature_2m_min    && dai.temperature_2m_min[0]    != null
                  ? Math.round(dai.temperature_2m_min[0])    + '\u00B0C' : '---';
  const rain    = dai.precipitation_probability_max && dai.precipitation_probability_max[0] != null
                  ? Math.round(dai.precipitation_probability_max[0]) + '%' : '---';

  /* Row 1: blank */
  rows.push(blankRow());

  /* Rows 2–3: double-height city name */
  const cityHeader = ' ' + city.name.toUpperCase() + ' — INDONESIA';
  const [dh, sp] = doubleHeight(truncate(cityHeader, COLS), 'yellow', 'blue');
  rows.push(dh);
  rows.push(sp);

  /* Row 4: blank */
  rows.push(blankRow());

  /* Rows 5–9: temp + icon */
  const iconRows = weatherIconRows(group, 'cyan');
  const leftCols = COLS - 10;

  rows.push(row(
    seg(padRight(temp + '\u00B0C', leftCols), 'cyan', 'black'),
    ...iconRows[0],
  ));
  rows.push(row(
    seg(padRight(label, leftCols), 'white', 'black'),
    ...iconRows[1],
  ));
  rows.push(row(
    seg(padRight('Feels like ' + feels + '\u00B0C', leftCols), 'white', 'black'),
    ...iconRows[2],
  ));
  rows.push(row(
    seg(padRight('Humidity ' + humidity + '%', leftCols), 'white', 'black'),
    ...iconRows[3],
  ));
  rows.push(row(
    seg(padRight('Wind ' + wind + ' km/h ' + wdir, leftCols), 'white', 'black'),
    ...iconRows[4],
  ));

  /* Row 10: blank */
  rows.push(blankRow());

  /* Row 11: today summary */
  rows.push(row(
    seg(padRight('TODAY', 8), 'black', 'yellow'),
    seg(padRight('MAX ' + maxT, 12), 'yellow', 'black'),
    seg(padRight('MIN ' + minT, 12), 'white',  'black'),
    seg(padRight('RAIN ' + rain, COLS - 32), 'green', 'black'),
  ));

  /* Rows 12–20: remaining 6 days */
  const dates    = (dai.time || []).slice(1, 7);
  const maxTemps = (dai.temperature_2m_max || []).slice(1, 7);
  const minTemps = (dai.temperature_2m_min || []).slice(1, 7);
  const precip   = (dai.precipitation_probability_max || []).slice(1, 7);
  const codes    = (dai.weather_code || []).slice(1, 7);

  for (let i = 0; i < dates.length && i < 6; i++) {
    const dayLbl = _dayLabel(dates[i]);
    const mx     = Math.round(maxTemps[i]) + '\u00B0';
    const mn     = Math.round(minTemps[i]) + '\u00B0';
    const rn     = precip[i] != null ? String(Math.round(precip[i])) + '%' : '---';
    const cnd    = truncate(wmoLabel(codes[i]), COLS - 21);

    rows.push(row(
      seg(padRight(dayLbl, 5), 'cyan',   'black'),
      seg(padRight(mx,     5), 'yellow', 'black'),
      seg(padRight(mn,     5), 'white',  'black'),
      seg(padRight(rn,     6), 'green',  'black'),
      seg(padRight(cnd,    COLS - 21), 'white', 'black'),
    ));
  }

  /* Pad to row 20 */
  while (rows.length < 19) rows.push(blankRow());
  rows.push(blankRow()); // row 20

  /* Row 21: local time */
  const localT = _localTime(city.tz);
  rows.push(row(seg(padCentre('LOCAL TIME ' + localT, COLS), 'cyan', 'black')));

  /* Row 22: weather footer */
  rows.push(weatherFooterRow(fetchedAt, fromCache));

  /* Row 23: fastext bar */
  rows.push(fasstextRow({ yellow: 300 }));

  return rows;
}

/**
 * Build a "city unavailable" subpage when a fetch fails and no cache.
 * @param {Object} city
 * @returns {Object[][]}
 */
function buildCityErrorBody(city) {
  const rows = [];

  rows.push(blankRow());

  const header = ' ' + city.name.toUpperCase() + ' — UNAVAILABLE';
  const [dh, sp] = doubleHeight(truncate(header, COLS), 'white', 'red');
  rows.push(dh);
  rows.push(sp);

  rows.push(blankRow());

  rows.push(row(seg(padCentre('DATA UNAVAILABLE', COLS), 'yellow', 'black')));
  rows.push(row(seg(padCentre('PLEASE TRY LATER', COLS), 'white', 'black')));

  for (let i = 7; i <= 22; i++) rows.push(blankRow());

  rows.push(fasstextRow({ yellow: 300 }));

  return rows;
}

registerPage(300, function(ctx) {
  /* Show loading state immediately */
  assemblePage(buildWeatherLoadingBody('300', 'WEATHER  INDONESIA'), '300');

  /* Fetch all Indonesian cities in parallel */
  const cityPromises = INDONESIAN_CITIES.map(function(city) {
    return fetchCityWeather(city);
  });

  Promise.allSettled(cityPromises).then(function(results) {
    if (parseHash().page !== '300') return;

    /* Build one screen per city */
    const screens = [];

    for (let i = 0; i < INDONESIAN_CITIES.length; i++) {
      const city = INDONESIAN_CITIES[i];
      const r    = results[i];

      if (r.status === 'fulfilled') {
        const { data, fetchedAt, fromCache } = r.value;
        if (i === 0) {
          // Jakarta: full "now" page
          screens.push(buildJakartaNowBody(data, fetchedAt, fromCache));
        } else {
          screens.push(buildCitySubpageBody(city, data, i - 1,
                        INDONESIAN_CITIES.length - 1, fetchedAt, fromCache));
        }
      } else {
        // City fetch failed and no cache
        console.warn('[p300] Weather unavailable for', city.name, r.reason && r.reason.message);
        if (i === 0) {
          // Jakarta failure
          screens.push(buildWeatherErrorBody('300'));
        } else {
          screens.push(buildCityErrorBody(city));
        }
      }
    }

    if (screens.length === 0) {
      assemblePage(buildWeatherErrorBody('300'), '300');
      return;
    }

    if (screens.length === 1) {
      assemblePage(screens[0], '300');
    } else {
      startSubpageRotation(screens, '300', { interval: 8 });
    }

    /* Background refresh: re-render on fresh data for Jakarta (screen 0) */
    fetchCityWeather(INDONESIAN_CITIES[0], function onFresh(fresh) {
      if (parseHash().page !== '300') return;
      if (_subpageState && _subpageState.pageNum === '300') {
        const newScreen = buildJakartaNowBody(fresh.data, fresh.fetchedAt, fresh.fromCache);
        _subpageState.screens[0] = newScreen;
        // Re-render current screen if it's Jakarta
        if (_subpageState.current === 0) {
          _renderSubpage(0);
        }
      }
    }).catch(function() { /* ignore */ });

  }).catch(function(err) {
    if (parseHash().page !== '300') return;
    console.error('[p300] Unexpected error:', err);
    assemblePage(buildWeatherErrorBody('300'), '300');
  });
});

/* ═══════════════════════════════════════════════════════
   SECTION 21 — PAGE 301: WEATHER — WORLD
   ═══════════════════════════════════════════════════════
   10 world cities split across 2 subpages (5 per screen).
   Each row: city name, temp, condition, local time.
   Auto-rotate every 8 s.
   ═══════════════════════════════════════════════════════ */

/**
 * Build a world weather screen body rows for a slice of cities.
 * @param {Object[]} cities   — slice of WORLD_CITIES (up to 5)
 * @param {Object[]} wxList   — matching Open-Meteo results (fulfilled)
 * @param {number}   screenIdx — 0 or 1
 * @param {number}   fetchedAt
 * @param {boolean}  fromCache
 * @returns {Object[][]}
 */
function buildWorldScreenBody(cities, wxList, screenIdx, fetchedAt, fromCache) {
  const rows = [];

  /* Row 1: blank */
  rows.push(blankRow());

  /* Rows 2–3: double-height header */
  const header = screenIdx === 0
    ? ' WORLD WEATHER  PART 1'
    : ' WORLD WEATHER  PART 2';
  const [dh, sp] = doubleHeight(truncate(header, COLS), 'white', 'blue');
  rows.push(dh);
  rows.push(sp);

  /* Row 4: blank */
  rows.push(blankRow());

  /* Row 5: column header */
  rows.push(row(
    seg(padRight('CITY',          14), 'black', 'yellow'),
    seg(padRight('TEMP',           6), 'black', 'yellow'),
    seg(padRight('CONDITION',     14), 'black', 'yellow'),
    seg(padRight('LOCAL',          6), 'black', 'yellow'),
  ));

  /* Rows 6–17: up to 5 cities, each using ~2 rows */
  for (let i = 0; i < cities.length; i++) {
    const city = cities[i];
    const wx   = wxList[i];

    if (!wx) {
      /* Data unavailable for this city */
      rows.push(row(
        seg(padRight(city.name, 14), 'white',  'black'),
        seg(padRight('---',      6), 'cyan',   'black'),
        seg(padRight('UNAVAIL', 14), 'yellow', 'black'),
        seg(padRight('--:--',    6), 'white',  'black'),
      ));
      rows.push(blankRow());
      continue;
    }

    const cur   = wx.current;
    const temp  = Math.round(cur.temperature_2m) + '\u00B0C';
    const code  = cur.weather_code;
    const cond  = truncate(wmoLabel(code), 14);
    const ltime = _localTime(city.tz);

    rows.push(row(
      seg(padRight(truncate(city.name, 14), 14), 'white',  'black'),
      seg(padRight(temp,                    6),  'cyan',   'black'),
      seg(padRight(cond,                   14),  'white',  'black'),
      seg(padRight(ltime,                   6),  'yellow', 'black'),
    ));
    rows.push(blankRow());
  }

  /* Pad to row 20 */
  while (rows.length < 19) rows.push(blankRow());
  rows.push(blankRow()); // row 20

  /* Row 21: "SEE P300 FOR INDONESIA" */
  rows.push(row(seg(padCentre('\u25B6 INDONESIA WEATHER SEE PAGE 300', COLS), 'cyan', 'black')));

  /* Row 22: weather footer */
  rows.push(weatherFooterRow(fetchedAt, fromCache));

  /* Row 23: fastext bar */
  rows.push(fasstextRow({ yellow: 300 }));

  return rows;
}

registerPage(301, function(ctx) {
  /* Show loading immediately */
  assemblePage(buildWeatherLoadingBody('301', 'WEATHER  WORLD'), '301');

  /* Fetch all world cities in parallel */
  const cityPromises = WORLD_CITIES.map(function(city) {
    return fetchCityWeather(city);
  });

  Promise.allSettled(cityPromises).then(function(results) {
    if (parseHash().page !== '301') return;

    /* Collect weather data, null for failures */
    const wxList = results.map(function(r) {
      if (r.status === 'fulfilled') return r.value.data;
      return null;
    });

    /* Determine overall fetchedAt / fromCache from first successful result */
    let fetchedAt = Date.now();
    let fromCache = false;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        fetchedAt = r.value.fetchedAt;
        fromCache = r.value.fromCache;
        break;
      }
    }

    /* Split into 2 screens of 5 cities each */
    const half  = Math.ceil(WORLD_CITIES.length / 2); // 5
    const slice1 = WORLD_CITIES.slice(0, half);
    const wx1    = wxList.slice(0, half);
    const slice2 = WORLD_CITIES.slice(half);
    const wx2    = wxList.slice(half);

    const screen1 = buildWorldScreenBody(slice1, wx1, 0, fetchedAt, fromCache);
    const screen2 = buildWorldScreenBody(slice2, wx2, 1, fetchedAt, fromCache);

    startSubpageRotation([screen1, screen2], '301', { interval: 8 });

  }).catch(function(err) {
    if (parseHash().page !== '301') return;
    console.error('[p301] Unexpected error:', err);
    assemblePage(buildWeatherErrorBody('301'), '301');
  });
});

/* ═══════════════════════════════════════════════════════
   SECTION 22 — PAGE 400: MARKETS / CURRENCY
   ═══════════════════════════════════════════════════════
   Data flow:
     fetchCurrency()      — Frankfurter v2 → v1 → open.er-api
                            → yesterday's localStorage cache.
                            Returns { rates, source, fetchedAt, fromCache }.
     fetchYesterdayRates() — Frankfurter v1 dated endpoint for
                            yesterday; used for ±change column.
                            Returns rates object or null on failure.
     buildPage400Body()   — 23 body rows: IDR table, optional
                            BTC/ETH row, footer with attribution.
   ═══════════════════════════════════════════════════════ */

/* ── 22.1  Currency API URLs ─────────────────────────── */

const FX_PAIRS = 'USD,EUR,SGD,JPY,GBP,AUD,CNY,MYR,THB,KRW';

const FX_URL_V2  = 'https://api.frankfurter.dev/v2/rates?base=IDR&quotes=' + FX_PAIRS;
const FX_URL_V1  = 'https://api.frankfurter.dev/v1/latest?base=IDR&symbols=' + FX_PAIRS;
const FX_URL_ER  = 'https://open.er-api.com/v6/latest/IDR';

/* Cache key for yesterday's rates (not part of the main URL cache) */
const FX_YESTERDAY_CACHE_KEY = 'fx:yesterday';

/* Source identifier constants */
const FX_SRC_V2    = 'FRANKFURTER';
const FX_SRC_V1    = 'FRANKFURTER';
const FX_SRC_ER    = 'EXCHANGERATE-API';
const FX_SRC_CACHE = 'CACHED';

/* ── 22.2  Normalise rate responses to a common shape ── */

/**
 * Normalise a Frankfurter v2 response to { rates: { USD: n, ... } }.
 * v2 shape: { base, date, rates: { USD: n, ... } }
 * @param {Object} data
 * @returns {{ rates: Object }|null}
 */
function _normFrankfurterV2(data) {
  if (data && data.rates && typeof data.rates === 'object') {
    return { rates: data.rates };
  }
  return null;
}

/**
 * Normalise a Frankfurter v1 response (identical shape to v2 for our purposes).
 * @param {Object} data
 * @returns {{ rates: Object }|null}
 */
function _normFrankfurterV1(data) {
  return _normFrankfurterV2(data);
}

/**
 * Normalise an open.er-api v6 response to { rates: { USD: n, ... } }.
 * Shape: { result: 'success', base_code: 'IDR', rates: { USD: n, ... } }
 * @param {Object} data
 * @returns {{ rates: Object }|null}
 */
function _normOpenER(data) {
  if (data && data.result === 'success' && data.rates && typeof data.rates === 'object') {
    return { rates: data.rates };
  }
  return null;
}

/* ── 22.3  fetchCurrency() — four-step fallback chain ── */

/**
 * Fetch current IDR exchange rates with a four-step fallback chain:
 *   1. Frankfurter v2 (direct CORS, cached 6 h)
 *   2. Frankfurter v1 (direct CORS, cached 6 h)
 *   3. open.er-api   (direct CORS, cached 6 h)
 *   4. Yesterday's cache (last good rates, any source)
 *
 * Returns:
 *   { rates, source, fetchedAt, fromCache, erAttribution }
 * where:
 *   rates         — { USD: n, EUR: n, ... }  (IDR per 1 foreign unit)
 *   source        — one of FX_SRC_* constants
 *   fetchedAt     — ms timestamp of the data
 *   fromCache     — true if served from localStorage
 *   erAttribution — true if open.er-api served the data
 *
 * Throws only if all four steps fail (no cache whatsoever).
 *
 * @param {function} [onFresh] — called if stale cache is served
 *                               and fresh data later arrives
 * @returns {Promise<{rates:Object, source:string, fetchedAt:number,
 *                    fromCache:boolean, erAttribution:boolean}>}
 */
async function fetchCurrency(onFresh) {
  /* Helper: attempt one step, return normalised result or null. */
  async function _attempt(url, normaliser) {
    try {
      const data = await fetchJSON(url, 8000);
      const norm = normaliser(data);
      if (norm && Object.keys(norm.rates).length > 0) return norm;
      return null;
    } catch (e) {
      return null;
    }
  }

  /* Stale-while-revalidate wrapper: use an internal cache key so we can
     carry the source label through the cache layer. */
  const FX_CACHE_KEY = 'fx:today';

  const cached = cacheGet(FX_CACHE_KEY);
  const now    = Date.now();

  if (cached && (now - cached.fetchedAt) <= TTL.CURRENCY) {
    // Fresh cache — return immediately
    const p = cached.payload;
    return {
      rates:          p.rates,
      source:         p.source,
      fetchedAt:      cached.fetchedAt,
      fromCache:      true,
      erAttribution:  p.source === FX_SRC_ER,
    };
  }

  /* ---- Try to fetch fresh data ---- */
  async function _fetchFresh() {
    // Step 1: Frankfurter v2
    let norm = await _attempt(FX_URL_V2, _normFrankfurterV2);
    if (norm) return { rates: norm.rates, source: FX_SRC_V2 };

    console.warn('[p400] Frankfurter v2 failed; trying v1');

    // Step 2: Frankfurter v1
    norm = await _attempt(FX_URL_V1, _normFrankfurterV1);
    if (norm) return { rates: norm.rates, source: FX_SRC_V1 };

    console.warn('[p400] Frankfurter v1 failed; trying open.er-api');

    // Step 3: open.er-api
    norm = await _attempt(FX_URL_ER, _normOpenER);
    if (norm) return { rates: norm.rates, source: FX_SRC_ER };

    console.warn('[p400] open.er-api failed; trying yesterday cache');

    // Step 4: yesterday's cache (any age)
    const yest = cacheGet(FX_YESTERDAY_CACHE_KEY);
    if (yest && yest.payload && yest.payload.rates) {
      return { rates: yest.payload.rates, source: FX_SRC_CACHE, fromYesterdayCache: true };
    }

    // Also check the main today cache regardless of age
    if (cached && cached.payload && cached.payload.rates) {
      return { rates: cached.payload.rates, source: FX_SRC_CACHE, fromYesterdayCache: true };
    }

    throw new Error('All currency sources failed and no cache available');
  }

  if (cached) {
    // Stale cache exists — return stale immediately, refresh in background
    const stalePayload = cached.payload;
    const staleResult = {
      rates:         stalePayload.rates,
      source:        stalePayload.source,
      fetchedAt:     cached.fetchedAt,
      fromCache:     true,
      erAttribution: stalePayload.source === FX_SRC_ER,
    };

    (async function() {
      try {
        const fresh = await _fetchFresh();
        if (!fresh.fromYesterdayCache) {
          cacheSet(FX_CACHE_KEY, { rates: fresh.rates, source: fresh.source });
          // Update yesterday cache for future fallback
          cacheSet(FX_YESTERDAY_CACHE_KEY, { rates: fresh.rates, source: fresh.source });
        }
        if (onFresh) {
          onFresh({
            rates:         fresh.rates,
            source:        fresh.source,
            fetchedAt:     Date.now(),
            fromCache:     false,
            erAttribution: fresh.source === FX_SRC_ER,
          });
        }
      } catch (e) {
        // Background refresh failed — stale data remains
      }
    })();

    return staleResult;
  }

  // No cache at all — await fresh fetch
  const fresh = await _fetchFresh();
  if (!fresh.fromYesterdayCache) {
    cacheSet(FX_CACHE_KEY, { rates: fresh.rates, source: fresh.source });
    cacheSet(FX_YESTERDAY_CACHE_KEY, { rates: fresh.rates, source: fresh.source });
  }
  return {
    rates:         fresh.rates,
    source:        fresh.source,
    fetchedAt:     Date.now(),
    fromCache:     false,
    erAttribution: fresh.source === FX_SRC_ER,
  };
}

/* ── 22.4  fetchYesterdayRates() — change-vs-yesterday ── */

/**
 * Fetch yesterday's IDR rates from Frankfurter v1 dated endpoint.
 * (Frankfurter v2 has no dated endpoint — it returns 404 for date-specific
 * requests.  v1 uses the path /<YYYY-MM-DD> and returns the same
 * { amount, base, date, rates: { USD: n, ... } } shape.)
 * Used to calculate +/- change for the table.
 * Returns the rates object or null if unavailable.
 *
 * @returns {Promise<Object|null>}
 */
async function fetchYesterdayRates() {
  /* Get yesterday's date in YYYY-MM-DD. Use UTC date to match Frankfurter's
     reference-rate convention (ECB daily reference rates, published ~16:00 CET). */
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  const dateStr = yyyy + '-' + mm + '-' + dd;

  /* v1 dated endpoint: https://api.frankfurter.dev/v1/<YYYY-MM-DD>?base=IDR&symbols=... */
  const url = 'https://api.frankfurter.dev/v1/' + dateStr +
              '?base=IDR&symbols=' + FX_PAIRS;

  const cached = cacheGet('fx:yest_ts:' + dateStr);
  if (cached && cached.payload && cached.payload.rates) {
    return cached.payload.rates;
  }

  try {
    const data = await fetchJSON(url, 8000);
    /* v1 shape is { amount, base, date, rates: { USD: n, ... } } —
       _normFrankfurterV1 handles this (same as _normFrankfurterV2). */
    const norm = _normFrankfurterV1(data);
    if (norm && Object.keys(norm.rates).length > 0) {
      // Cache yesterday's data for 24 hours — it won't change
      cacheSet('fx:yest_ts:' + dateStr, { rates: norm.rates });
      return norm.rates;
    }
    return null;
  } catch (e) {
    console.warn('[p400] fetchYesterdayRates failed:', e.message);
    return null;
  }
}

/* ── 22.5  Number formatting helpers ────────────────── */

/**
 * Format a number as Indonesian Rupiah style: 16,345.12 → "16,345"
 * For large IDR amounts we show integers with commas.
 * @param {number} n
 * @returns {string}
 */
function _fmtIDR(n) {
  if (n == null || isNaN(n)) return '---';
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Format a small decimal (like 0.000061) to 6 significant figures.
 * @param {number} n
 * @returns {string}
 */
function _fmtSmall(n) {
  if (n == null || isNaN(n)) return '---';
  if (n >= 1) return n.toFixed(4);
  // Use toPrecision for small numbers
  return n.toPrecision(4);
}

/**
 * Compute the IDR value for one unit of foreign currency.
 * The API gives rates as: 1 IDR = X foreign-currency units.
 * So to get "1 foreign = Y IDR": Y = 1 / rate.
 * @param {number} rate — foreign units per 1 IDR
 * @returns {number}
 */
function _idrPer1(rate) {
  if (!rate || rate === 0) return 0;
  return 1 / rate;
}

/**
 * Build the change string for a currency pair.
 * todayRate and yesterdayRate are both "foreign units per 1 IDR".
 * We display "1 foreign = Y IDR", so a rising IDR (rate increases)
 * means the foreign buys fewer IDR → negative change.
 * @param {number} todayRate
 * @param {number} yesterdayRate
 * @returns {string}  e.g. "+125" or "-48" or ""
 */
function _changeStr(todayRate, yesterdayRate) {
  if (!todayRate || !yesterdayRate) return '';
  const todayIDR     = _idrPer1(todayRate);
  const yesterdayIDR = _idrPer1(yesterdayRate);
  const diff         = Math.round(todayIDR - yesterdayIDR);
  if (diff === 0) return ' 0';        // exact zero change
  if (diff > 0)   return '+' + diff.toLocaleString('en-US');
  return String(diff.toLocaleString('en-US')); // negative already has minus
}

/* ── 22.6  Currency page loading/error body builders ── */

/**
 * Build the in-universe loading screen for page 400.
 * @returns {Object[][]}
 */
function buildCurrencyLoadingBody() {
  const rows = [];

  rows.push(blankRow());

  const [dh, sp] = doubleHeight(padCentre('MARKETS  CURRENCY', COLS), 'white', 'blue');
  rows.push(dh);
  rows.push(sp);

  rows.push(blankRow());

  rows.push(row(seg(padCentre('P400  \u2026searching', COLS), 'yellow', 'black')));
  rows.push(row(seg(padCentre('\u2588', COLS), 'cyan', 'black')));

  for (let i = 7; i <= 22; i++) rows.push(blankRow());

  rows.push(fasstextRow({ cyan: 400 }));

  return rows;
}

/**
 * Build the in-universe error page for page 400.
 * @returns {Object[][]}
 */
function buildCurrencyErrorBody() {
  const rows = [];

  rows.push(blankRow());

  const [dh, sp] = doubleHeight(padCentre('MARKETS  CURRENCY', COLS), 'white', 'blue');
  rows.push(dh);
  rows.push(sp);

  rows.push(blankRow());

  rows.push(row(seg(padCentre('SERVICE TEMPORARILY UNAVAILABLE', COLS), 'yellow', 'black')));
  rows.push(row(seg(padCentre('PLEASE TRY LATER', COLS), 'white', 'black')));

  rows.push(blankRow());

  rows.push(row(seg(padCentre('P400  NO DATA AVAILABLE', COLS), 'cyan', 'black')));

  for (let i = 10; i <= 22; i++) rows.push(blankRow());

  rows.push(fasstextRow({
    red:      400,
    redLabel: 'RETRY   ',
    cyan:     400,
  }));

  return rows;
}

/* ── 22.7  buildPage400Body() — the IDR exchange table ── */

/**
 * Build the 23 body rows for page 400.
 *
 * Layout (body rows 1–23):
 *   Row 1:     blank
 *   Rows 2–3:  double-height "MARKETS  CURRENCY" on blue
 *   Row 4:     column header (yellow on blue)
 *   Row 5:     blank separator
 *   Rows 6–15: one row per currency (USD…KRW), 10 pairs
 *   Row 16:    blank separator
 *   Row 17:    optional BTC/ETH row (if Frankfurter returned them)
 *   Row 18:    blank (or second BTC/ETH row if both present)
 *   Rows 19:   "Reference rates — updated daily. Not trading prices."
 *   Row 20:    blank
 *   Row 21:    source / attribution line
 *   Row 22:    data footer (DATA HH:MM / DATA FROM CACHE HH:MM)
 *   Row 23:    fastext bar
 *
 * @param {Object} currResult   — from fetchCurrency()
 * @param {Object|null} yesterdayRates — from fetchYesterdayRates(), or null
 * @returns {Object[][]}
 */
function buildPage400Body(currResult, yesterdayRates) {
  const { rates, source, fetchedAt, fromCache, erAttribution } = currResult;
  const rows = [];

  /* Row 1: blank */
  rows.push(blankRow());

  /* Rows 2–3: double-height header */
  const [dh, sp] = doubleHeight(' MARKETS  CURRENCY', 'yellow', 'blue');
  rows.push(dh);
  rows.push(sp);

  /* Row 4: column header
     Layout: "CURR  1 UNIT = IDR      CHANGE"
              5     16              9      = 30... let's use precise widths:
     CURR(4) + gap(2) + "1 UNIT = IDR"(12) + gap(2) + VALUE(10) + gap(1) + CHANGE(9) = 40 */
  const hasChange = !!yesterdayRates;
  if (hasChange) {
    rows.push(row(
      seg(padRight('CURR',      5), 'black', 'yellow'),
      seg(padRight('1 UNIT',    7), 'black', 'yellow'),
      seg(padRight('= IDR',     8), 'black', 'yellow'),
      seg(padRight('',          9), 'black', 'yellow'),  // value space
      seg(padRight('CHG IDR',  11), 'black', 'yellow'),
    ));
  } else {
    rows.push(row(
      seg(padRight('CURR',      6), 'black', 'yellow'),
      seg(padRight('1 UNIT = IDR', 20), 'black', 'yellow'),
      seg(padRight('',          14), 'black', 'yellow'),
    ));
  }

  /* Row 5: blank */
  rows.push(blankRow());

  /* ---- Currency pairs ---- */

  /* The 10 main pairs we display. The API base is IDR, so rates[USD] = units of USD per 1 IDR.
     To get "1 USD = X IDR" we compute 1 / rates[USD]. */
  const PAIRS = [
    { code: 'USD', name: 'US Dollar',        flag: 'USD' },
    { code: 'EUR', name: 'Euro',             flag: 'EUR' },
    { code: 'SGD', name: 'Singapore $',      flag: 'SGD' },
    { code: 'JPY', name: 'Japan Yen',        flag: 'JPY' },
    { code: 'GBP', name: 'Brit. Pound',      flag: 'GBP' },
    { code: 'AUD', name: 'Austral. $',       flag: 'AUD' },
    { code: 'CNY', name: 'China Yuan',       flag: 'CNY' },
    { code: 'MYR', name: 'Malaysia Ringg.',  flag: 'MYR' },
    { code: 'THB', name: 'Thai Baht',        flag: 'THB' },
    { code: 'KRW', name: 'Korea Won',        flag: 'KRW' },
  ];

  /* Rows 6–15: one per pair */
  for (const pair of PAIRS) {
    const rate      = rates[pair.code];
    const idrValue  = rate ? _idrPer1(rate) : null;
    const valueStr  = idrValue ? _fmtIDR(idrValue) : '---';

    if (hasChange) {
      const yRate   = yesterdayRates[pair.code];
      const chgStr  = (rate && yRate) ? _changeStr(rate, yRate) : ' \u2014';
      const chgColour = chgStr.startsWith('+') ? 'green' :
                        chgStr.startsWith('-') ? 'red'   : 'white';

      rows.push(row(
        seg(padRight(pair.code,  4), 'yellow', 'black'),
        seg(' ',                     'black',  'black'),
        seg(padRight(valueStr,  14), 'white',  'black'),
        seg(' ',                     'black',  'black'),
        seg(padRight(chgStr,    10), chgColour, 'black'),
        seg(' '.repeat(COLS - 4 - 1 - 14 - 1 - 10), 'black', 'black'),
      ));
    } else {
      rows.push(row(
        seg(padRight(pair.code,  5), 'yellow', 'black'),
        seg(padRight(valueStr,  COLS - 5), 'white', 'black'),
      ));
    }
  }

  /* Row 16: blank separator */
  rows.push(blankRow());

  /* ---- Optional BTC/ETH row ---- */
  /* Frankfurter v2 may return BTC/ETH. If they're in rates (rates base IDR),
     we display "1 BTC = USD X,XXX" — note BTC/ETH are in USD-equivalent via
     the cross-rate. Since base is IDR and Frankfurter gives rates[BTC] = BTC per 1 IDR,
     we need to convert to USD: btcInUSD = rates[USD] / rates[BTC] (IDR/USD × BTC/IDR = BTC/USD, inverted = USD/BTC). */
  const btcRate = rates['BTC'];
  const ethRate = rates['ETH'];
  const usdRate = rates['USD']; // USD per 1 IDR

  let cryptoRowsAdded = 0;

  if (btcRate && usdRate) {
    // 1 BTC in USD = (1/btcRate) / (1/usdRate) = usdRate / btcRate
    const btcUSD = usdRate / btcRate;
    const btcStr = btcUSD >= 1000
      ? Math.round(btcUSD).toLocaleString('en-US')
      : btcUSD.toFixed(2);

    rows.push(row(
      seg(padRight('BTC',  5), 'magenta', 'black'),
      seg(padRight('(CRYPTO)', 10), 'white', 'black'),
      seg(padRight('USD ' + btcStr, COLS - 15), 'cyan', 'black'),
    ));
    cryptoRowsAdded++;
  }

  if (ethRate && usdRate) {
    const ethUSD = usdRate / ethRate;
    const ethStr = ethUSD >= 1000
      ? Math.round(ethUSD).toLocaleString('en-US')
      : ethUSD.toFixed(2);

    rows.push(row(
      seg(padRight('ETH',  5), 'magenta', 'black'),
      seg(padRight('(CRYPTO)', 10), 'white', 'black'),
      seg(padRight('USD ' + ethStr, COLS - 15), 'cyan', 'black'),
    ));
    cryptoRowsAdded++;
  }

  /* Pad to reach row 18 (body index 17) */
  while (rows.length < 17) rows.push(blankRow());

  /* Row 19: "Reference rates" disclaimer */
  rows.push(row(seg(
    padRight('Reference rates \u2014 updated daily', COLS),
    'white', 'black'
  )));

  /* Row 20: "Not trading prices." */
  rows.push(row(seg(
    padRight('Not trading prices.', COLS),
    'white', 'black'
  )));

  /* Row 21: attribution / source */
  if (erAttribution) {
    /* open.er-api served the data: required attribution per their terms */
    const erRow = row(
      seg('Rates: ', 'cyan', 'black'),
      seg(padRight('Rates By Exchange Rate API', COLS - 7), 'cyan', 'black'),
    );
    /* Mark for post-render anchor-wiring (row overall index = 21) */
    erRow._erLink = 'https://www.exchangerate-api.com';
    rows.push(erRow);
  } else if (source === FX_SRC_CACHE) {
    rows.push(row(seg(padRight('Source: last cached rates', COLS), 'yellow', 'black')));
  } else {
    rows.push(row(seg(padRight('Rates: frankfurter.dev', COLS), 'cyan', 'black')));
  }

  /* Row 22: data footer */
  const timeStr  = jakartaHHMM(fetchedAt);
  const footerLabel = fromCache
    ? 'DATA FROM CACHE ' + timeStr
    : 'DATA ' + timeStr;
  const footerSrc  = erAttribution ? 'EXCH.RATE-API' : 'FRANKFURTER';
  const footerLeft = footerSrc;
  const footerRight = footerLabel;
  const fGap = COLS - footerLeft.length - footerRight.length;
  const fGapStr = fGap > 0 ? ' '.repeat(fGap) : ' ';

  rows.push(row(
    seg(footerLeft,  'black', 'cyan'),
    seg(fGapStr,     'black', 'cyan'),
    seg(footerRight, 'black', 'cyan'),
  ));

  /* Row 23: fastext bar */
  rows.push(fasstextRow({ cyan: 400 }));

  return rows;
}

/* ── 22.8  Page 400 registration ─────────────────────── */

/**
 * After assemblePage() on p400, wire a real <a> anchor over the
 * "Rates By Exchange Rate API" row (overall row 21) if erAttribution is true.
 * Follows the same pattern as _wirePage102StoryLink.
 * @param {Object[][]} bodyRows — the body rows built by buildPage400Body
 */
function _wireP400ERAttribLink(bodyRows) {
  /* Find the row that carries _erLink */
  for (const r of bodyRows) {
    if (r._erLink) {
      /* Row 21 overall = body row index 20 → stage child 21 */
      const stage = document.getElementById('stage');
      if (!stage) return;
      const rows = stage.querySelectorAll('.tt-row');
      const targetRow = rows[21];
      if (!targetRow) return;

      const a = document.createElement('a');
      a.href   = r._erLink;
      a.target = '_blank';
      a.rel    = 'noopener noreferrer';
      a.style.cssText = 'display:block;text-decoration:none;cursor:pointer;';
      targetRow.parentNode.insertBefore(a, targetRow);
      a.appendChild(targetRow);
      return;
    }
  }
}

registerPage(400, function(ctx) {
  /* Show loading state immediately */
  assemblePage(buildCurrencyLoadingBody(), '400');

  /* Helper: render page and wire ER attribution link if needed */
  function _render400(currResult, yesterdayRates) {
    const bodyRows = buildPage400Body(currResult, yesterdayRates);
    assemblePage(bodyRows, '400');
    _wireP400ERAttribLink(bodyRows);
  }

  /* Fetch current rates and yesterday's rates in parallel */
  Promise.all([
    fetchCurrency(function onFresh(currResult) {
      /* Called if stale cache served and fresh data arrived in background */
      if (parseHash().page !== '400') return;
      fetchYesterdayRates().then(function(yesterdayRates) {
        if (parseHash().page !== '400') return;
        _render400(currResult, yesterdayRates);
      }).catch(function() {
        if (parseHash().page !== '400') return;
        _render400(currResult, null);
      });
    }),
    fetchYesterdayRates(),
  ]).then(function(results) {
    if (parseHash().page !== '400') return;
    const currResult     = results[0];
    const yesterdayRates = results[1]; // may be null
    _render400(currResult, yesterdayRates);
  }).catch(function(err) {
    if (parseHash().page !== '400') return;
    console.error('[p400] Currency fetch failed:', err && err.message);
    assemblePage(buildCurrencyErrorBody(), '400');
  });
});

/* ── 22.9  p500 credits data — includes Exchange Rate API ── */
/*
 * T9 builds page 500 (About / Credits). The credits list is defined here
 * so the Exchange Rate API attribution is in the codebase regardless of
 * when T9 runs. T9 reads P500_CREDITS when building the credits subpage.
 *
 * Required attribution per open.er-api.com terms:
 *   <a href="https://www.exchangerate-api.com">Rates By Exchange Rate API</a>
 */
const P500_CREDITS = [
  {
    name:   'Open-Meteo',
    url:    'https://open-meteo.com',
    note:   'Weather data — CC BY 4.0',
  },
  {
    name:   'BBC News / Sport RSS',
    url:    'https://www.bbc.co.uk/news/10628494',
    note:   'News headlines — public RSS, attribution required',
  },
  {
    name:   'Frankfurter',
    url:    'https://www.frankfurter.dev',
    note:   'Currency rates — free, no key required',
  },
  {
    name:   'Rates By Exchange Rate API',
    url:    'https://www.exchangerate-api.com',
    note:   'Currency fallback — open access, no key required',
  },
  {
    name:   'ESPN (unofficial)',
    url:    'https://site.api.espn.com',
    note:   'Football scores — keyless in practice, unofficial',
  },
  {
    name:   'OpenLigaDB',
    url:    'https://www.openligadb.de',
    note:   'Bundesliga fallback — open API',
  },
];

/* ═══════════════════════════════════════════════════════
   SECTION 23 — SPORT DATA LAYER
   ═══════════════════════════════════════════════════════
   loadSport()      — merged BBC Sport + Football RSS, 10-min cache
   loadScores()     — ESPN → OpenLigaDB → labelled SAMPLE, 5-min cache
   _parseESPN()     — normalise ESPN scoreboard response
   _parseOpenLiga() — normalise OpenLigaDB response (Bundesliga)
   ═══════════════════════════════════════════════════════ */

/* ── 23.1  Sport RSS feeds ────────────────────────────── */

const SPORT_FEEDS = [
  'https://feeds.bbci.co.uk/sport/rss.xml',
  'https://feeds.bbci.co.uk/sport/football/rss.xml',
];
const SPORT_MERGED_KEY = 'sport:merged';

/**
 * Load BBC Sport + Football RSS headlines via proxy chain, merged and
 * deduplicated, cached under SPORT_MERGED_KEY with TTL.NEWS (10 min).
 *
 * Returns { items, fetchedAt, fromCache }.
 *
 * @param {function} [onFresh]
 * @returns {Promise<{items:Array, fetchedAt:number, fromCache:boolean}>}
 */
async function loadSport(onFresh) {
  const cached = cacheGet(SPORT_MERGED_KEY);
  const now    = Date.now();

  if (cached && (now - cached.fetchedAt) <= TTL.NEWS) {
    return {
      items:     cached.payload.items,
      fetchedAt: cached.fetchedAt,
      fromCache: true,
    };
  }

  if (cached) {
    // Stale — return immediately, refresh in background
    const stale = {
      items:     cached.payload.items,
      fetchedAt: cached.fetchedAt,
      fromCache: true,
    };
    (async function() {
      try {
        const fresh = await _fetchMergedSport();
        cacheSet(SPORT_MERGED_KEY, fresh);
        if (onFresh) onFresh({ ...fresh, fetchedAt: Date.now(), fromCache: false });
      } catch (e) { /* keep stale */ }
    })();
    return stale;
  }

  const result = await _fetchMergedSport();
  cacheSet(SPORT_MERGED_KEY, result);
  return { ...result, fetchedAt: Date.now(), fromCache: false };
}

/**
 * Internal: fetch both sport feeds in parallel via proxy chain, merge results.
 * Returns { items }.
 */
async function _fetchMergedSport() {
  const feedPromises = SPORT_FEEDS.map(async function(url) {
    const xml   = await fetchBBCFeed(url);
    const items = parseRSS(xml);
    if (!items.length) throw new Error('Empty sport feed: ' + url);
    return items;
  });

  const results = await Promise.allSettled(feedPromises);
  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const item of r.value) all.push(item);
    }
  }

  if (!all.length) throw new Error('All sport RSS feeds failed');

  // Deduplicate by normalised title, keep order (newest-first from BBC)
  const seen = new Set();
  const deduped = [];
  for (const item of all) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  // Sort newest-first
  deduped.sort(function(a, b) {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    if (isNaN(ta) && isNaN(tb)) return 0;
    if (isNaN(ta)) return 1;
    if (isNaN(tb)) return -1;
    return tb - ta;
  });

  return { items: deduped.slice(0, 12) };
}

/* ── 23.2  Scores: ESPN → OpenLigaDB → SAMPLE ────────── */

const ESPN_SCORES_URL    = 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard';
const OPENLIGA_URL       = 'https://www.openligadb.de/api/getmatchdata/bl1';
const SCORES_CACHE_KEY   = 'scores:espn';
const OPENLIGA_CACHE_KEY = 'scores:openliga';

/**
 * Normalised match object: { home, away, score, status, league }
 *   status: 'FT' | 'HT' | '67\'' | '20:00' | 'PP' etc.
 *   league: 'ENG' | 'ESP' | 'ITA' | 'GER' | 'UCL' | 'IDN' | …
 */

/**
 * Parse an ESPN scoreboard JSON response.
 * Returns an object { leagues: { ENG: [...], ESP: [...], ... }, usable: bool }.
 * @param {Object} data  — raw ESPN JSON
 * @returns {{ leagues: Object, usable: boolean }}
 */
function _parseESPN(data) {
  /* ESPN shape:
     { leagues: [ { abbreviation, name, events: [ { competitions: [ { ... } ] } ] } ] }
     or events at the top level in some API variants.
     The all/scoreboard endpoint groups by league in `leagues`. */
  const leagues = {};

  if (!data) return { leagues, usable: false };

  /* Top-level events (some ESPN endpoints) */
  const topEvents = Array.isArray(data.events) ? data.events : [];

  /* Per-league events */
  const leagueGroups = Array.isArray(data.leagues) ? data.leagues : [];

  /* Map ESPN league abbreviations → our keys */
  const ESPN_LEAGUE_MAP = {
    'ENG.1':  'ENG', 'EPL':     'ENG',
    'ESP.1':  'ESP', 'ESP.LIGA': 'ESP',
    'ITA.1':  'ITA',
    'GER.1':  'GER', 'GER.BUND': 'GER',
    'UEFA.CHAMPIONS': 'UCL', 'UEFACL': 'UCL',
    'IDN.1':  'IDN', 'IDN':     'IDN',
  };

  function _statusStr(comp) {
    if (!comp) return '---';
    const st = comp.status;
    if (!st) return '---';
    const type = st.type;
    if (!type) return '---';
    const state = (type.state || '').toLowerCase();
    if (state === 'post') return 'FT';
    if (state === 'in') {
      const disp = st.displayClock || '';
      if (disp.toLowerCase() === 'ht') return 'HT';
      return disp || (st.period === 2 ? '45\'' : '0\'');
    }
    // pre (scheduled)
    if (st.type && st.type.shortDetail) {
      const detail = st.type.shortDetail;
      // e.g. "21 Nov, 20:00" → extract time
      const timeMatch = detail.match(/(\d{1,2}:\d{2})/);
      if (timeMatch) return timeMatch[1];
    }
    return '---';
  }

  function _parseCompetition(comp, leagueKey) {
    if (!comp) return null;
    const teams = comp.competitors || [];
    let home = null;
    let away = null;
    for (const t of teams) {
      const teamObj = t.team || {};
      const name = teamObj.shortDisplayName || teamObj.displayName || teamObj.name || '???';
      const score = t.score != null ? String(t.score) : '-';
      if (t.homeAway === 'home') home = { name, score };
      else                        away = { name, score };
    }
    if (!home || !away) return null;

    const status = _statusStr(comp);
    const scoreStr = (status === '---' || status.includes(':'))
      ? '--'
      : (home.score + '-' + away.score);

    return {
      home:   truncate(home.name, 15),
      away:   truncate(away.name, 15),
      score:  scoreStr,
      status: status,
      league: leagueKey || '???',
    };
  }

  /* Process per-league groups */
  for (const lg of leagueGroups) {
    const abbr   = (lg.abbreviation || lg.slug || '').toUpperCase();
    const lgKey  = ESPN_LEAGUE_MAP[abbr] || null;
    if (!lgKey) continue;

    const events = lg.events || [];
    if (!leagues[lgKey]) leagues[lgKey] = [];

    for (const ev of events) {
      const comps = ev.competitions || [];
      for (const comp of comps) {
        const match = _parseCompetition(comp, lgKey);
        if (match) leagues[lgKey].push(match);
      }
    }
  }

  /* Process top-level events (fallback) */
  for (const ev of topEvents) {
    const lgData = ev.league || {};
    const abbr   = (lgData.abbreviation || lgData.slug || '').toUpperCase();
    const lgKey  = ESPN_LEAGUE_MAP[abbr] || null;
    if (!lgKey) continue;
    if (!leagues[lgKey]) leagues[lgKey] = [];
    const comps = ev.competitions || [];
    for (const comp of comps) {
      const match = _parseCompetition(comp, lgKey);
      if (match) leagues[lgKey].push(match);
    }
  }

  const usable = Object.keys(leagues).some(k => leagues[k].length > 0);
  return { leagues, usable };
}

/**
 * Parse an OpenLigaDB getmatchdata response (Bundesliga).
 * Returns array of normalised match objects with league='GER'.
 * @param {Array} data
 * @returns {Object[]}
 */
function _parseOpenLiga(data) {
  if (!Array.isArray(data)) return [];

  return data.map(function(m) {
    const home  = truncate((m.team1 && m.team1.shortName) || (m.team1 && m.team1.teamName) || '???', 15);
    const away  = truncate((m.team2 && m.team2.shortName) || (m.team2 && m.team2.teamName) || '???', 15);

    // Determine score from matchResults (resultTypeID 2 = final, 1 = halfTime)
    const results = m.matchResults || [];
    let finalResult = null;
    let htResult    = null;
    for (const r of results) {
      if (r.resultTypeID === 2) finalResult = r;
      if (r.resultTypeID === 1) htResult = r;
    }

    let score  = '--';
    let status = '---';

    if (m.matchIsFinished) {
      status = 'FT';
      if (finalResult) {
        score = finalResult.pointsTeam1 + '-' + finalResult.pointsTeam2;
      } else if (htResult) {
        score = htResult.pointsTeam1 + '-' + htResult.pointsTeam2;
      }
    } else if (m.matchDateTimeUTC) {
      // Scheduled
      try {
        const d = new Date(m.matchDateTimeUTC);
        status = d.toLocaleTimeString('en-GB', {
          hour:   '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'UTC',
        });
      } catch (e) {
        status = '---';
      }
    }

    return { home, away, score, status, league: 'GER' };
  }).filter(function(m) { return m.home !== '???'; });
}

/* ── 23.3  loadScores() — ESPN → OpenLigaDB → SAMPLE ─── */

/**
 * Load football scores.
 * Attempts:
 *   1. ESPN scoreboard (all leagues) — direct CORS, 5-min cache
 *   2. OpenLigaDB (Bundesliga only)  — direct CORS, 5-min cache
 *   3. Labelled SAMPLE DATA
 *
 * Returns:
 *   { leagues: { ENG: [...], ESP: [...], ITA: [...], GER: [...], UCL: [...], IDN?: [...] },
 *     source: 'ESPN' | 'OPENLIGA' | 'SAMPLE',
 *     fetchedAt: number,
 *     fromCache: boolean }
 *
 * Never throws — SAMPLE is the guaranteed fallback.
 *
 * @param {function} [onFresh]
 * @returns {Promise<Object>}
 */
async function loadScores(onFresh) {
  /* Check ESPN cache first */
  const espnCached = cacheGet(SCORES_CACHE_KEY);
  const now = Date.now();

  if (espnCached && (now - espnCached.fetchedAt) <= TTL.SCORES) {
    return _scoresFromESPNCache(espnCached, true);
  }

  /* Stale ESPN cache — return stale and refresh in background */
  if (espnCached) {
    const stale = _scoresFromESPNCache(espnCached, true);
    (async function() {
      try {
        const fresh = await _fetchESPNScores();
        if (fresh.usable) {
          cacheSet(SCORES_CACHE_KEY, fresh);
          if (onFresh) onFresh(_scoresFromESPNCache({ fetchedAt: Date.now(), payload: fresh }, false));
        }
      } catch (e) { /* keep stale */ }
    })();
    return stale;
  }

  /* No ESPN cache — try fetching */
  try {
    const espnData = await _fetchESPNScores();
    if (espnData.usable) {
      cacheSet(SCORES_CACHE_KEY, espnData);
      if (onFresh) onFresh(_scoresFromESPNCache({ fetchedAt: Date.now(), payload: espnData }, false));
      return _scoresFromESPNCache({ fetchedAt: Date.now(), payload: espnData }, false);
    }
    console.warn('[loadScores] ESPN returned no usable data; trying OpenLigaDB');
  } catch (e) {
    console.warn('[loadScores] ESPN failed:', e.message);
  }

  /* OpenLigaDB fallback (Bundesliga only) */
  try {
    const olCached = cacheGet(OPENLIGA_CACHE_KEY);
    if (olCached && (now - olCached.fetchedAt) <= TTL.SCORES) {
      return _scoresFromOpenLiga(olCached.payload, olCached.fetchedAt, true);
    }

    const olData = await fetchJSON(OPENLIGA_URL, 8000);
    const matches = _parseOpenLiga(olData);
    if (matches.length > 0) {
      cacheSet(OPENLIGA_CACHE_KEY, matches);
      return _scoresFromOpenLiga(matches, Date.now(), false);
    }
    console.warn('[loadScores] OpenLigaDB returned no usable data; using SAMPLE');
  } catch (e) {
    console.warn('[loadScores] OpenLigaDB failed:', e.message);
  }

  /* SAMPLE fallback */
  return _scoresFromSample();
}

/** Build a scores result object from a cached ESPN payload. */
function _scoresFromESPNCache(cacheEntry, fromCache) {
  const payload = cacheEntry.payload;
  const parsed  = _parseESPN(payload.raw || payload);
  return {
    leagues:   parsed.leagues,
    source:    'ESPN',
    fetchedAt: cacheEntry.fetchedAt,
    fromCache: fromCache,
  };
}

/** Build a scores result object from OpenLigaDB data. */
function _scoresFromOpenLiga(matches, fetchedAt, fromCache) {
  return {
    leagues:   { GER: matches },
    source:    'OPENLIGA',
    fetchedAt: fetchedAt,
    fromCache: fromCache,
  };
}

/** Build a scores result object from SAMPLE_DATA. */
function _scoresFromSample() {
  const samples = window.SAMPLE_DATA && window.SAMPLE_DATA.footballSamples;
  const leagues = {};
  if (samples) {
    for (const key of Object.keys(samples)) {
      leagues[key] = (samples[key].matches || []).map(function(m) {
        return { home: m.home, away: m.away, score: m.score, status: m.status, league: key };
      });
    }
  }
  return {
    leagues:   leagues,
    source:    'SAMPLE',
    fetchedAt: Date.now(),
    fromCache: false,
  };
}

/** Fetch raw ESPN scoreboard JSON. Returns { raw, usable }. */
async function _fetchESPNScores() {
  const data   = await fetchJSON(ESPN_SCORES_URL, 8000);
  const parsed = _parseESPN(data);
  return { raw: data, usable: parsed.usable };
}

/* ═══════════════════════════════════════════════════════
   SECTION 24 — SPORT RENDERING HELPERS
   ═══════════════════════════════════════════════════════ */

/* ── 24.1  Sport loading/error body builders ──────────── */

/**
 * Build the in-universe loading screen for sport pages.
 * @param {string} pageNum
 * @returns {Object[][]}
 */
function buildSportLoadingBody(pageNum) {
  const rows = [];
  rows.push(blankRow());
  const [dh, sp] = doubleHeight(padCentre('SPORT SERVICE', COLS), 'white', 'blue');
  rows.push(dh);
  rows.push(sp);
  rows.push(blankRow());
  rows.push(row(seg(padCentre('P' + pageNum + '  \u2026searching', COLS), 'yellow', 'black')));
  rows.push(row(seg(padCentre('\u2588', COLS), 'cyan', 'black')));
  for (let i = 7; i <= 22; i++) rows.push(blankRow());
  rows.push(fasstextRow({ green: parseInt(pageNum, 10) }));
  return rows;
}

/**
 * Build the in-universe error page for sport.
 * @param {string} pageNum
 * @returns {Object[][]}
 */
function buildSportErrorBody(pageNum) {
  const rows = [];
  rows.push(blankRow());
  const [dh, sp] = doubleHeight(padCentre('SPORT SERVICE', COLS), 'white', 'blue');
  rows.push(dh);
  rows.push(sp);
  rows.push(blankRow());
  rows.push(row(seg(padCentre('SERVICE TEMPORARILY UNAVAILABLE', COLS), 'yellow', 'black')));
  rows.push(row(seg(padCentre('PLEASE TRY LATER', COLS), 'white', 'black')));
  rows.push(blankRow());
  rows.push(row(seg(padCentre('P' + pageNum + '  NO DATA AVAILABLE', COLS), 'cyan', 'black')));
  for (let i = 10; i <= 22; i++) rows.push(blankRow());
  rows.push(fasstextRow({
    red:      parseInt(pageNum, 10),
    redLabel: 'RETRY   ',
    green:    parseInt(pageNum, 10),
  }));
  return rows;
}

/* ── 24.2  Sport footer row ───────────────────────────── */

/**
 * Build data footer for sport pages.
 * @param {number}  fetchedAt
 * @param {boolean} fromCache
 * @param {string}  source  — 'ESPN' | 'OPENLIGA' | 'SAMPLE'
 * @returns {Object[]}
 */
function sportFooterRow(fetchedAt, fromCache, source) {
  const timeStr = jakartaHHMM(fetchedAt);
  const dataLabel = fromCache
    ? 'DATA FROM CACHE ' + timeStr
    : 'DATA ' + timeStr;
  const srcLabel = source === 'SAMPLE' ? 'SAMPLE DATA' :
                   source === 'OPENLIGA' ? 'OPENLIGADB' : 'ESPN';
  const full = padRight(dataLabel + '  ' + srcLabel, COLS);
  return row(seg(full, 'black', 'cyan'));
}

/* ── 24.3  Match score row builder ────────────────────── */

/**
 * Build a single match row for the scores table.
 * Layout: HOME(14) SCORE(5) AWAY(14) STATUS(7) = 40
 * @param {Object} match  — { home, away, score, status }
 * @param {boolean} isSample
 * @returns {Object[]}
 */
function buildMatchRow(match, isSample) {
  const homeStr   = padRight(truncate(match.home  || '', 14), 14);
  const awayStr   = padRight(truncate(match.away  || '', 14), 14);
  const scoreStr  = padCentre(match.score  || '--', 5);
  const statusStr = padLeft(truncate(match.status || '', 7), 7);

  /* Colour the status: FT=white, HT=cyan, in-play=green, scheduled=yellow */
  const st = (match.status || '').toUpperCase();
  const statusFg = st === 'FT'  ? 'white'  :
                   st === 'HT'  ? 'cyan'   :
                   st === 'PP'  ? 'yellow' :
                   /^\d+\'/.test(st) ? 'green' :
                   /^\d{1,2}:\d{2}$/.test(st) ? 'yellow' : 'white';

  return row(
    seg(homeStr,   isSample ? 'white' : 'white',  'black'),
    seg(scoreStr,  isSample ? 'white' : 'cyan',   'black'),
    seg(awayStr,   isSample ? 'white' : 'white',  'black'),
    seg(statusStr, isSample ? 'white' : statusFg, 'black'),
  );
}

/* ═══════════════════════════════════════════════════════
   SECTION 25 — PAGE 200: SPORT
   ═══════════════════════════════════════════════════════
   Body rows 1–23:
     Rows 1–2:  double-height "SPORT" on blue
     Row 3:     blank
     Rows 4–13: numbered sport headlines (up to 8 stories)
     Row 14:    blank
     Row 15:    "LATEST SCORES" header band + LIVE tag
     Rows 16–19: up to 3 score rows (compact, first league)
     Row 20:    "MORE SCORES PAGE 201" pointer
     Row 21:    blank
     Row 22:    data footer (news fetch time / cache)
     Row 23:    fastext bar
   ═══════════════════════════════════════════════════════ */

/**
 * Build the LATEST SCORES block rows (rows 15–19 of p200 body).
 * Shows up to 3 matches from the first available league.
 * @param {Object} scoresResult  — from loadScores()
 * @returns {Object[][]}  up to 5 rows: header + 3 match rows + spacer
 */
function buildScoresBlock(scoresResult) {
  const isSample = scoresResult.source === 'SAMPLE';

  /* Pick first non-empty league (prefer ENG, then first available) */
  const preferOrder = ['ENG', 'UCL', 'ESP', 'GER', 'ITA', 'IDN'];
  let matches = [];
  let leagueKey = '';
  for (const key of preferOrder) {
    if (scoresResult.leagues[key] && scoresResult.leagues[key].length > 0) {
      matches  = scoresResult.leagues[key];
      leagueKey = key;
      break;
    }
  }

  /* Fallback: first league in object */
  if (!matches.length) {
    const keys = Object.keys(scoresResult.leagues);
    if (keys.length) {
      leagueKey = keys[0];
      matches   = scoresResult.leagues[keys[0]];
    }
  }

  const rows = [];

  /* "LATEST SCORES" header */
  if (isSample) {
    /* SAMPLE label replaces the LIVE tag */
    rows.push(row(
      seg(padRight('\u25A0 LATEST SCORES', 30), 'black', 'green'),
      seg(padRight('SAMPLE', 10), 'black', 'yellow'),
    ));
  } else {
    /* "LIVE" tag: flashing red if prefers-reduced-motion not set */
    rows.push(row(
      seg(padRight('\u25A0 LATEST SCORES', 30), 'black', 'green'),
      seg(padRight(' LIVE ', 6), 'white', 'red', { flash: true }),
      seg(padRight('', 4), 'black', 'green'),
    ));
  }

  /* Up to 3 match rows */
  const show = matches.slice(0, 3);
  for (const match of show) {
    rows.push(buildMatchRow(match, isSample));
  }

  /* Pad to 4 match rows if fewer available */
  while (rows.length < 4) rows.push(blankRow());

  return rows;
}

/**
 * Build all body rows for page 200.
 * @param {{items:Array, fetchedAt:number, fromCache:boolean}} sportResult
 * @param {Object} scoresResult
 * @returns {Object[][]}
 */
function buildPage200Body(sportResult, scoresResult) {
  const rows = [];
  const items     = sportResult.items || [];
  const fetchedAt = sportResult.fetchedAt;
  const fromCache = sportResult.fromCache;

  /* Row 1: blank */
  rows.push(blankRow());

  /* Rows 2–3: double-height "SPORT" header on blue */
  const [dh, sp] = doubleHeight(' SPORT  BBC SPORT RSS', 'white', 'blue');
  rows.push(dh);
  rows.push(sp);

  /* Row 4: blank */
  rows.push(blankRow());

  /* Rows 5–13: sport headlines (up to 8 stories, 1 row each) */
  const STORIES_PER_PAGE = 8;
  const storiesToShow = items.slice(0, STORIES_PER_PAGE);
  for (let i = 0; i < storiesToShow.length; i++) {
    const item = storiesToShow[i];
    const num  = padLeft(String(i + 1), 2) + ' ';
    const textW = COLS - num.length;
    const r = row(
      seg(num, 'cyan', 'black'),
      seg(padRight(truncate(item.title, textW), textW), 'white', 'black'),
    );
    /* Not tapping through to p102 (sport stories ≠ news stories), just display */
    rows.push(r);
  }

  /* No headlines: in-universe unavailable block in the headline rows */
  if (storiesToShow.length === 0) {
    rows.push(row(seg(padCentre('SPORT HEADLINES UNAVAILABLE', COLS), 'white', 'red')));
    rows.push(blankRow());
    rows.push(row(seg(padCentre('THE SPORTS WIRE IS OFF AIR', COLS), 'yellow', 'black')));
    rows.push(row(seg(padCentre('PLEASE TRY LATER', COLS), 'yellow', 'black')));
    rows.push(blankRow());
    rows.push(row(seg(padCentre('SCORES ARE SHOWN BELOW', COLS), 'cyan', 'black')));
    rows.push(row(seg(padCentre('MORE RESULTS ON PAGE 201', COLS), 'cyan', 'black')));
  }

  /* Pad to reach row 13 (body index 12) */
  while (rows.length < 12) rows.push(blankRow());

  /* Row 13: "MORE SPORT SCORES PAGE 201" pointer */
  rows.push(row(
    seg(padRight('\u25B6 FOOTBALL SCORES: TYPE 201', COLS), 'cyan', 'black'),
  ));

  /* Row 14: blank */
  rows.push(blankRow());

  /* Rows 15–18: LATEST SCORES block (header + up to 3 matches) */
  const scoresBlock = buildScoresBlock(scoresResult);
  for (const r of scoresBlock) rows.push(r);

  /* Row 19: "SAMPLE DATA" label row if from sample */
  if (scoresResult.source === 'SAMPLE') {
    rows.push(row(seg(
      padCentre('SAMPLE DATA \u2014 live scores unavailable', COLS),
      'yellow', 'black'
    )));
  } else {
    rows.push(blankRow());
  }

  /* Pad to row 21 */
  while (rows.length < 20) rows.push(blankRow());

  /* Row 21: blank */
  rows.push(blankRow());

  /* Row 22: data footer (sport RSS timestamp) */
  if (items.length === 0) {
    rows.push(row(seg(padRight('NO SPORT HEADLINES AVAILABLE', COLS), 'black', 'cyan')));
  } else {
    rows.push(newsFooterRow(fetchedAt, fromCache, 'BBC SPORT'));
  }

  /* Row 23: fastext bar — green active = 200 (we're on it), 201 in yellow */
  rows.push(fasstextRow({
    green:  200,
    yellow: 201,
    yellowLabel: '201     ',
  }));

  return rows;
}

/* ── 25.1  Page 200 registration ──────────────────────── */

registerPage(200, function(ctx) {
  /* Show loading state immediately */
  assemblePage(buildSportLoadingBody('200'), '200');

  /* Load sport RSS and scores in parallel */
  let sportResult  = null;
  let scoresResult = null;

  function _tryRender200() {
    if (!sportResult || !scoresResult) return;
    if (parseHash().page !== '200') return;
    const body = buildPage200Body(sportResult, scoresResult);
    assemblePage(body, '200');

    /* Start 5-min scores refresh timer */
    addPageInterval(function() {
      if (parseHash().page !== '200') return;
      loadScores(function onFresh(fresh) {
        if (parseHash().page !== '200') return;
        scoresResult = fresh;
        const body2 = buildPage200Body(sportResult, scoresResult);
        assemblePage(body2, '200');
      }).then(function(fresh) {
        if (parseHash().page !== '200') return;
        scoresResult = fresh;
        const body2 = buildPage200Body(sportResult, scoresResult);
        assemblePage(body2, '200');
      }).catch(function() { /* keep existing */ });
    }, TTL.SCORES);
  }

  /* Fetch sport RSS */
  loadSport(function onFreshSport(fresh) {
    if (parseHash().page !== '200') return;
    sportResult = fresh;
    _tryRender200();
  }).then(function(result) {
    sportResult = result;
    _tryRender200();
  }).catch(function() {
    if (parseHash().page !== '200') return;
    // Use empty items on RSS failure
    sportResult = { items: [], fetchedAt: Date.now(), fromCache: false };
    _tryRender200();
  });

  /* Fetch scores */
  loadScores(function onFreshScores(fresh) {
    if (parseHash().page !== '200') return;
    scoresResult = fresh;
    _tryRender200();
  }).then(function(result) {
    scoresResult = result;
    _tryRender200();
  }).catch(function() {
    if (parseHash().page !== '200') return;
    scoresResult = _scoresFromSample();
    _tryRender200();
  });
});

/* ═══════════════════════════════════════════════════════
   SECTION 26 — PAGE 201: FOOTBALL SCORES
   ═══════════════════════════════════════════════════════
   One subpage per available league (ENG/ESP/ITA/GER/UCL + IDN if present).
   Each subpage: full-page results table for that league.
   Auto-rotate every 10 s.
   Scores refresh every 5 min; rotation screens are updated in-place.
   ═══════════════════════════════════════════════════════ */

/* League display names and colour */
const LEAGUE_META = {
  ENG: { name: 'PREMIER LEAGUE',      fg: 'cyan'    },
  ESP: { name: 'LA LIGA',             fg: 'yellow'  },
  ITA: { name: 'SERIE A',             fg: 'green'   },
  GER: { name: 'BUNDESLIGA',          fg: 'white'   },
  UCL: { name: 'CHAMPIONS LEAGUE',    fg: 'cyan'    },
  IDN: { name: 'INDONESIA LIGA 1',    fg: 'green'   },
};

/* Canonical league order for subpages */
const LEAGUE_ORDER = ['ENG', 'ESP', 'ITA', 'GER', 'UCL', 'IDN'];

/**
 * Build a single league subpage body rows for page 201.
 * @param {string}   leagueKey
 * @param {Object[]} matches      — array of normalised match objects
 * @param {boolean}  isSample
 * @param {number}   fetchedAt
 * @param {boolean}  fromCache
 * @returns {Object[][]}
 */
function buildLeagueSubpageBody(leagueKey, matches, isSample, fetchedAt, fromCache) {
  const rows = [];
  const meta  = LEAGUE_META[leagueKey] || { name: leagueKey, fg: 'white' };
  const title = ' ' + meta.name;

  /* Row 1: blank */
  rows.push(blankRow());

  /* Rows 2–3: double-height league name on blue */
  const [dh, sp] = doubleHeight(truncate(title, COLS), meta.fg, 'blue');
  rows.push(dh);
  rows.push(sp);

  /* Row 4: column header */
  rows.push(row(
    seg(padRight('HOME',   14), 'black', 'yellow'),
    seg(padCentre('SCORE', 5), 'black', 'yellow'),
    seg(padRight('AWAY',   14), 'black', 'yellow'),
    seg(padLeft('STATUS',  7), 'black', 'yellow'),
  ));

  /* Row 5: blank */
  rows.push(blankRow());

  /* Rows 6–19: match rows (up to 14 matches) */
  const MAX_MATCHES = 14;
  const show = matches.slice(0, MAX_MATCHES);
  for (const match of show) {
    rows.push(buildMatchRow(match, isSample));
  }

  /* Pad to row 19 (body index 18) */
  while (rows.length < 18) rows.push(blankRow());

  /* Row 20: blank */
  rows.push(blankRow());

  /* Row 21: SAMPLE notice or source hint */
  if (isSample) {
    rows.push(row(seg(
      padCentre('SAMPLE DATA \u2014 live scores unavailable', COLS),
      'yellow', 'black'
    )));
  } else {
    rows.push(row(seg(
      padCentre('\u25B6 SPORT HEADLINES SEE P200', COLS),
      'cyan', 'black'
    )));
  }

  /* Row 22: data footer */
  const source = isSample ? 'SAMPLE' : (leagueKey === 'GER' ? 'OPENLIGA' : 'ESPN');
  rows.push(sportFooterRow(fetchedAt, fromCache, source));

  /* Row 23: fastext bar */
  rows.push(fasstextRow({
    green:      200,
    greenLabel: 'SPORT   ',
  }));

  return rows;
}

/**
 * Build all subpage screens for page 201 from a scores result.
 * Returns array of body-row arrays (one per league with data).
 * @param {Object} scoresResult
 * @returns {{ key: string, screen: Object[][] }[]}
 */
function buildPage201Screens(scoresResult) {
  const isSample  = scoresResult.source === 'SAMPLE';
  const fetchedAt = scoresResult.fetchedAt;
  const fromCache = scoresResult.fromCache;
  const screens   = [];

  for (const key of LEAGUE_ORDER) {
    const matches = scoresResult.leagues[key];
    if (!matches || !matches.length) continue;

    // Also populate name for SAMPLE leagues from sample-data
    const sampleMeta = window.SAMPLE_DATA && window.SAMPLE_DATA.footballSamples
                       && window.SAMPLE_DATA.footballSamples[key];
    if (!LEAGUE_META[key] && sampleMeta) {
      LEAGUE_META[key] = { name: sampleMeta.name, fg: 'white' };
    }

    screens.push({
      key:    key,
      screen: buildLeagueSubpageBody(key, matches, isSample, fetchedAt, fromCache),
    });
  }

  return screens;
}

/* ── 26.1  Page 201 registration ──────────────────────── */

registerPage(201, function(ctx) {
  /* Show loading state immediately */
  assemblePage(buildSportLoadingBody('201'), '201');

  /* Load scores (will use ESPN cache if still fresh from p200 visit) */
  loadScores(function onFreshScores(fresh) {
    if (parseHash().page !== '201') return;
    _renderPage201(fresh);
  }).then(function(result) {
    _renderPage201(result);
  }).catch(function() {
    if (parseHash().page !== '201') return;
    _renderPage201(_scoresFromSample());
  });
});

/**
 * Render p201 from a scores result. Sets up rotation and 5-min refresh timer.
 * @param {Object} scoresResult
 */
function _renderPage201(scoresResult) {
  if (parseHash().page !== '201') return;

  const built = buildPage201Screens(scoresResult);

  if (!built.length) {
    /* No data at all — show SAMPLE */
    const sampleResult = _scoresFromSample();
    const sampleBuilt  = buildPage201Screens(sampleResult);
    if (sampleBuilt.length) {
      _startPage201Rotation(sampleBuilt);
    } else {
      assemblePage(buildSportErrorBody('201'), '201');
    }
    return;
  }

  _startPage201Rotation(built);
}

/**
 * Wire subpage rotation for p201 and set the 5-min scores refresh timer.
 * @param {{ key: string, screen: Object[][] }[]} built
 */
function _startPage201Rotation(built) {
  const screens = built.map(function(b) { return b.screen; });

  startSubpageRotation(screens, '201', { interval: 10 });

  /* 5-min refresh: reload scores and rebuild screens in-place */
  addPageInterval(function() {
    if (parseHash().page !== '201') return;
    loadScores(function onFresh(fresh) {
      if (parseHash().page !== '201') return;
      _refreshPage201Screens(fresh, built.map(function(b) { return b.key; }));
    }).then(function(fresh) {
      if (parseHash().page !== '201') return;
      _refreshPage201Screens(fresh, built.map(function(b) { return b.key; }));
    }).catch(function() { /* keep existing screens */ });
  }, TTL.SCORES);
}

/**
 * Update the rotation screens in-place after a scores refresh.
 * @param {Object} scoresResult
 * @param {string[]} currentKeys  — league keys in current screen order
 */
function _refreshPage201Screens(scoresResult, currentKeys) {
  if (!_subpageState || _subpageState.pageNum !== '201') return;

  const rebuilt = buildPage201Screens(scoresResult);
  const keyMap  = {};
  for (const b of rebuilt) keyMap[b.key] = b.screen;

  /* Update matching screens in-place, preserving order */
  for (let i = 0; i < currentKeys.length; i++) {
    const key = currentKeys[i];
    if (keyMap[key]) {
      _subpageState.screens[i] = keyMap[key];
    }
  }

  /* Re-render current screen with fresh data */
  _renderSubpage(_subpageState.current);
}

/* ═══════════════════════════════════════════════════════
   SECTION 27 — PAGE 104: QUIZ
   ═══════════════════════════════════════════════════════
   5 general-knowledge questions from bundled quiz sets.
   Sets are rotated by (dayOfMonth % 3) from SAMPLE_DATA.quizSets.
   Answers render as black-on-black (concealed) until revealed
   individually with the REVEAL button / V key.
   HOLD freezes the page (via the standard HOLD mechanism).
   ═══════════════════════════════════════════════════════ */

/**
 * Global: current quiz reveal state.
 * { revealed: Set<number> } — indices of revealed questions (0–4).
 * Reset each time page 104 is opened.
 */
let _quizRevealState = null;

/**
 * Callback set by renderPage104 — called by V key / REVEAL button.
 * Reveals the next unrevealed answer, then re-renders the quiz body.
 * @type {function|null}
 */
let _quizRevealNext = null;

/**
 * Pick the quiz set for today.
 * Uses day-of-month in Jakarta time, mod 3.
 * @returns {{ q: string, a: string }[]}
 */
function _pickQuizSet() {
  const sets = window.SAMPLE_DATA && window.SAMPLE_DATA.quizSets;
  if (!sets || !sets.length) return [];
  const day = parseInt(
    new Date().toLocaleDateString('en-GB', { timeZone: TIMEZONE, day: 'numeric' }),
    10,
  );
  return sets[day % sets.length] || sets[0];
}

/**
 * Build the page 104 body rows for the given quiz set and reveal state.
 * @param {{ q:string, a:string }[]} questions
 * @param {Set<number>} revealed  — set of revealed question indices
 * @returns {Object[][]} body rows (1–23)
 */
function buildPage104Body(questions, revealed) {
  const rows = [];

  /* Row 1: blank */
  rows.push(blankRow());

  /* Rows 2–3: double-height title */
  const [dh, sp] = doubleHeight(' TELETEXT QUIZ', 'yellow', 'blue');
  rows.push(dh);
  rows.push(sp);

  /* Row 4: set selector hint */
  const day = parseInt(
    new Date().toLocaleDateString('en-GB', { timeZone: TIMEZONE, day: 'numeric' }),
    10,
  );
  const setNum = (day % 3) + 1;
  rows.push(row(
    seg(padRight(' QUESTION SET ' + setNum + ' OF 3', 24), 'cyan', 'black'),
    seg(padRight('V=REVEAL  H=HOLD', COLS - 24), 'white', 'black'),
  ));

  /* Row 5: divider */
  rows.push(row(seg('\u2500'.repeat(COLS), 'blue', 'black')));

  /* Rows 6–21: five questions, each taking 3 rows:
     Row A: "Q1 " + question text (cyan)
     Row B: "    " + answer (black-on-black until revealed; white-on-black when revealed)
     Row C: blank separator
  */
  const revealedCount = revealed.size;

  for (let i = 0; i < 5 && i < questions.length; i++) {
    const q = questions[i];
    const isRevealed = revealed.has(i);

    /* Question row */
    const qLabel = 'Q' + (i + 1) + ' ';
    const qText  = truncate(q.q, COLS - qLabel.length);
    rows.push(row(
      seg(qLabel, 'magenta', 'black'),
      seg(padRight(qText, COLS - qLabel.length), 'cyan', 'black'),
    ));

    /* Answer row: black-on-black = concealed; white-on-black = revealed */
    const aPrefix = '   ';
    const aText   = truncate(q.a, COLS - aPrefix.length);
    if (isRevealed) {
      rows.push(row(
        seg(aPrefix, 'black', 'black'),
        seg(padRight(aText, COLS - aPrefix.length), 'white', 'black'),
      ));
    } else {
      /* Concealed: answer text exists but fg === bg === black */
      rows.push(row(
        seg(aPrefix, 'black', 'black'),
        seg(padRight(aText, COLS - aPrefix.length), 'black', 'black'),
      ));
    }

    /* Separator row */
    rows.push(blankRow());
  }

  /* Pad rows to reach row 22 (body index 21) */
  while (rows.length < 21) rows.push(blankRow());

  /* Row 22: status hint */
  const totalRevealed = revealedCount;
  const remaining     = Math.max(0, questions.length - totalRevealed);
  let hintText;
  if (remaining === 0) {
    hintText = padCentre('ALL ANSWERS REVEALED', COLS);
  } else {
    hintText = padCentre(
      'PRESS V OR REVEAL \u2014 ' + remaining + ' ANSWER' + (remaining === 1 ? '' : 'S') + ' HIDDEN',
      COLS,
    );
  }
  rows.push(row(seg(hintText, 'black', 'cyan')));

  /* Row 23: fastext bar */
  rows.push(fasstextRow({
    red:      101,
    green:    200,
    yellow:   300,
    cyan:     104,
    cyanLabel: 'QUIZ    ',
  }));

  return rows;
}

registerPage(104, function(ctx) {
  /* Reset reveal state on every page open */
  _quizRevealState = { revealed: new Set() };
  const questions  = _pickQuizSet();

  /* Initial render — all answers concealed */
  assemblePage(buildPage104Body(questions, _quizRevealState.revealed), '104');

  /* Wire the reveal callback */
  _quizRevealNext = function() {
    if (parseHash().page !== '104') return;

    /* Find the first unrevealed question index */
    for (let i = 0; i < questions.length; i++) {
      if (!_quizRevealState.revealed.has(i)) {
        _quizRevealState.revealed.add(i);

        /* Re-render the page body in-place */
        const newBody = buildPage104Body(questions, _quizRevealState.revealed);
        assemblePage(newBody, '104');

        /* Flash the REVEAL button to give feedback */
        const btn = document.querySelector('.kp-reveal');
        if (btn) {
          btn.classList.add('reveal-active');
          setTimeout(function() { btn.classList.remove('reveal-active'); }, 300);
        }
        return;
      }
    }
    /* All revealed — no-op (or could reset) */
  };
});

/* ═══════════════════════════════════════════════════════
   SECTION 28 — PAGE 888: SUBTITLES
   ═══════════════════════════════════════════════════════
   Fake "live subtitled broadcast" of an imaginary nature
   documentary. Straight-faced header "SUBTITLES — ENGLISH 888".
   Lines from SAMPLE_DATA.subtitleScript advance every 4 s and loop.
   Ends with one accessibility line about teletext.
   ═══════════════════════════════════════════════════════ */

/**
 * Build page 888 body rows for a given start index in the script.
 * Shows up to 10 subtitle lines (rows 10–19), with the most recent
 * line at the bottom.
 * @param {string[]} script    — the full subtitle script
 * @param {number}   lineIndex — index of the latest line to display (inclusive)
 * @returns {Object[][]} body rows (1–23)
 */
function buildPage888Body(script, lineIndex) {
  const rows = [];

  /* Row 1: blank */
  rows.push(blankRow());

  /* Rows 2–3: double-height header */
  const [dh, sp] = doubleHeight(' SUBTITLES \u2014 ENGLISH 888', 'white', 'blue');
  rows.push(dh);
  rows.push(sp);

  /* Row 4: "LIVE" indicator bar */
  rows.push(row(
    seg(padRight(' \u25A0 LIVE BROADCAST', 20), 'black', 'red'),
    seg(padRight(' BBC ONE   21:00', COLS - 20), 'white', 'black'),
  ));

  /* Row 5: divider */
  rows.push(row(seg('\u2500'.repeat(COLS), 'cyan', 'black')));

  /* Rows 6–9: blank (buffer above subtitles) */
  for (let i = 0; i < 4; i++) rows.push(blankRow());

  /* Rows 10–19: up to 10 subtitle lines (most-recent at bottom).
     Collect the window of lines ending at lineIndex. */
  const DISPLAY_LINES = 10;
  const windowStart = Math.max(0, lineIndex - DISPLAY_LINES + 1);
  const windowLines = [];
  for (let i = windowStart; i <= lineIndex && i < script.length; i++) {
    windowLines.push(script[i]);
  }

  /* Pad top to fill 10 rows */
  while (windowLines.length < DISPLAY_LINES) windowLines.unshift('');

  for (let i = 0; i < DISPLAY_LINES; i++) {
    const line = windowLines[i] || '';
    const isLatest = (i === DISPLAY_LINES - 1) && line !== '';

    /* Wrap long lines to 38 chars (1-char margin each side) */
    if (line.length === 0) {
      rows.push(blankRow());
    } else {
      const wrapped = wrapWords(line, 38);
      /* Show only the first wrapped line in this row slot */
      const display = wrapped[0] || '';
      const centred = padCentre(display, COLS);
      rows.push(row(
        seg(centred, isLatest ? 'white' : 'cyan', 'black'),
      ));
    }
  }

  /* Row 20: blank */
  rows.push(blankRow());

  /* Row 21: documentary name */
  rows.push(row(seg(padCentre('\u2022 ISLANDS OF THE ARCHIPELAGO \u2022', COLS), 'yellow', 'black')));

  /* Row 22: blank */
  rows.push(blankRow());

  /* Row 23: fastext bar */
  rows.push(fasstextRow());

  return rows;
}

registerPage(888, function(ctx) {
  const script = (window.SAMPLE_DATA && window.SAMPLE_DATA.subtitleScript) || [
    'No subtitle script loaded.',
  ];

  /* Start at line 0 */
  let currentLine = 0;

  assemblePage(buildPage888Body(script, currentLine), '888');

  /* Advance one line every 4 seconds, looping */
  addPageInterval(function() {
    if (parseHash().page !== '888') return;
    currentLine = (currentLine + 1) % script.length;
    assemblePage(buildPage888Body(script, currentLine), '888');
  }, 4000);
});

/* ═══════════════════════════════════════════════════════
   SECTION 29 — PAGE 500: ABOUT / HELP
   ═══════════════════════════════════════════════════════
   2 subpages:
     Subpage 1 — About + How to use
     Subpage 2 — Credits / data-source licences
   Static content, no API calls.
   ═══════════════════════════════════════════════════════ */

/**
 * Build page 500 subpage 1: About + How to use.
 * @returns {Object[][]} body rows (1–23)
 */
function buildPage500AboutBody() {
  const rows = [];

  /* Row 1: blank */
  rows.push(blankRow());

  /* Rows 2–3: double-height title */
  const [dh, sp] = doubleHeight(' ABOUT TELETEXT LIVES', 'yellow', 'blue');
  rows.push(dh);
  rows.push(sp);

  /* Row 4: blank */
  rows.push(blankRow());

  /* Rows 5–10: what teletext was (3 short paragraphs) */
  const aboutLines = [
    { text: 'WHAT WAS TELETEXT?', fg: 'cyan' },
    { text: 'Between the 1970s and 2012, millions of people got', fg: 'white' },
    { text: 'their news, weather and sport from teletext \u2014', fg: 'white' },
    { text: 'chunky coloured text broadcast inside a TV signal.', fg: 'white' },
  ];
  for (const l of aboutLines) {
    rows.push(row(seg(' ' + padRight(l.text, COLS - 1), l.fg, 'black')));
  }

  rows.push(blankRow());

  const teleLines = [
    { text: 'Ceefax (BBC) and ORF TELETEXT were the web before', fg: 'white' },
    { text: 'the web: instant, free, brutally simple, and loved.', fg: 'white' },
    { text: 'You typed a 3-digit page number on your remote.', fg: 'white' },
  ];
  for (const l of teleLines) {
    rows.push(row(seg(' ' + padRight(l.text, COLS - 1), l.fg, 'black')));
  }

  rows.push(blankRow());

  const liveLines = [
    { text: 'TELETEXT LIVES resurrects that experience with', fg: 'white' },
    { text: 'live 2026 data: real weather, real headlines,', fg: 'white' },
    { text: 'real exchange rates. The dead medium lives again.', fg: 'white' },
  ];
  for (const l of liveLines) {
    rows.push(row(seg(' ' + padRight(l.text, COLS - 1), l.fg, 'black')));
  }

  rows.push(blankRow());

  /* Row 17: how to use heading */
  rows.push(row(seg(padRight(' HOW TO USE', COLS), 'black', 'cyan')));

  /* Rows 18–21: usage instructions */
  const howLines = [
    ' Type 3 digits to go to any page  (e.g. 300)',
    ' R=NEWS  G=SPORT  Y=WEATHER  C=MARKETS',
    ' H=HOLD  \u25C4=PREV  \u25BA=NEXT  V=REVEAL (quiz)',
    ' Page 500/2 \u25BA for data credits',
  ];
  for (const l of howLines) {
    rows.push(row(seg(padRight(l, COLS), 'white', 'black')));
  }

  /* Row 22: blank */
  rows.push(blankRow());

  /* Row 23: fastext with NEXT subpage hint */
  rows.push(fasstextRow({
    cyan:      500,
    cyanLabel: 'CREDITS ',
  }));

  return rows;
}

/**
 * Build page 500 subpage 2: Credits and licences.
 * @returns {Object[][]} body rows (1–23)
 */
function buildPage500CreditsBody() {
  const rows = [];

  /* Row 1: blank */
  rows.push(blankRow());

  /* Rows 2–3: double-height title */
  const [dh, sp] = doubleHeight(' CREDITS & LICENCES', 'yellow', 'blue');
  rows.push(dh);
  rows.push(sp);

  /* Row 4: blank */
  rows.push(blankRow());

  /* Rows 5–20: credits list */
  const credits = [
    { label: 'WEATHER DATA', fg: 'cyan' },
    { label: ' Open-Meteo \u2014 open-meteo.com', fg: 'white' },
    { label: ' Licence: CC BY 4.0 (non-commercial use)', fg: 'white' },
    { label: '', fg: 'black' },
    { label: 'NEWS HEADLINES', fg: 'cyan' },
    { label: ' BBC News RSS \u2014 feeds.bbci.co.uk', fg: 'white' },
    { label: ' Used with attribution; headlines only', fg: 'white' },
    { label: '', fg: 'black' },
    { label: 'EXCHANGE RATES', fg: 'cyan' },
    { label: ' Frankfurter \u2014 frankfurter.dev (primary)', fg: 'white' },
    { label: ' ExchangeRate-API \u2014 exchangerate-api.com', fg: 'white' },
    { label: ' Rates By Exchange Rate API (fallback)', fg: 'white' },
    { label: '', fg: 'black' },
    { label: 'SPORT SCORES', fg: 'cyan' },
    { label: ' ESPN scoreboard (experimental/unofficial)', fg: 'white' },
    { label: ' OpenLigaDB \u2014 openligadb.de (Bundesliga)', fg: 'white' },
  ];

  for (const c of credits) {
    if (rows.length >= 20) break;
    rows.push(row(seg(padRight(c.label, COLS), c.fg, 'black')));
  }

  /* Pad to row 20 */
  while (rows.length < 19) rows.push(blankRow());

  /* Row 21: "Built with Kiro" */
  rows.push(row(seg(padRight(' Built with Kiro \u2014 Kiroween 2026', COLS), 'magenta', 'black')));

  /* Row 22: MIT licence note */
  rows.push(row(seg(padRight(' MIT Licence \u2014 github.com/ninochaan', COLS), 'white', 'black')));

  /* Row 23: fastext bar */
  rows.push(fasstextRow({
    cyan:      500,
    cyanLabel: 'ABOUT   ',
  }));

  return rows;
}

registerPage(500, function(ctx) {
  const sub = ctx && ctx.sub ? parseInt(ctx.sub, 10) : 1;

  /* 2 static subpages; large interval so user reads at their own pace */
  const screens = [
    buildPage500AboutBody(),
    buildPage500CreditsBody(),
  ];

  /* Start on the requested subpage (1-indexed → 0-indexed) */
  const startAt = Math.max(0, Math.min(sub - 1, screens.length - 1));
  startSubpageRotation(screens, '500', { interval: 30, startAt: startAt });
});

/* ═══════════════════════════════════════════════════════
   SECTION 17 — BOOT
   ═══════════════════════════════════════════════════════ */

window.addEventListener('hashchange', route);

wireKeypad();
wireDataPageDelegation();

/* Navigate to 100 if no hash on first load */
if (!location.hash || location.hash === '#') {
  location.hash = '100';
} else {
  route();
}
