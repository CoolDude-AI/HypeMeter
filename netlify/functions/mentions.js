// netlify/functions/mentions.js
const DEFAULT_WINDOW_MIN = 60; // 1h
const FETCH_TIMEOUT_MS = 10_000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Primary names
const NAME_BY_TICKER = {
  NVDA: "NVIDIA", AAPL: "Apple", MSFT: "Microsoft", AMZN: "Amazon",
  GOOGL: "Alphabet", META: "Meta", TSLA: "Tesla", AMD: "AMD",
  PLTR: "Palantir", NFLX: "Netflix", COIN: "Coinbase", GME: "GameStop",
  AMC: "AMC", RIVN: "Rivian", SNAP: "Snap", UBER: "Uber",
  SPOT: "Spotify", SHOP: "Shopify", DIS: "Disney", NIO: "NIO"
};

// Extra aliases to boost recall on 1H (add more as you like)
const ALIASES = {
  GOOGL: ["Google"],
  META: ["Facebook", "FB"],
  TSLA: ["Tesla Motors"],
  NVDA: ["Nvidia"], // lowercase v common
  AAPL: ["Apple Inc"],
  MSFT: ["Microsoft Corp", "MS"],
  AMZN: ["Amazon.com"],
  AMD:  ["Advanced Micro Devices"],
  PLTR: ["Palantir Technologies"],
  NFLX: ["Netflix Inc"],
  COIN: ["Coinbase Global"],
  UBER: ["Uber Technologies"],
  SHOP: ["Shopify Inc"],
  DIS:  ["Walt Disney", "Disney"],
  SPOT: ["Spotify Technology"]
};

const cache = new Map(); // key -> { ts, data }

function httpRes(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(bodyObj),
  };
}

const withTimeout = (url, opts = {}, ms = FETCH_TIMEOUT_MS) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function timespanParam(windowMin){
  if (windowMin % 60 === 0) return `${Math.max(1, windowMin/60)}h`; // 24h etc.
  return `${windowMin}m`;
}

async function fetchJson(url, attempt = 1){
  try {
    const res = await withTimeout(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json().catch(()=> ({}));
  } catch (e) {
    if (attempt < 3) {
      await sleep(300 * attempt);
      return fetchJson(url, attempt + 1);
    }
    return {};
  }
}

function sumTimeline(json) {
  const arr = json?.timeline?.[0]?.data;
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((acc, d) => acc + (Number(d?.value) || 0), 0);
}

// FINAL fallback: count articles via ArtList (lower bound; capped by API)
async function countViaArtList(query, span){
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?format=json&mode=ArtList&maxrecords=250&timespan=${span}&query=${query}`;
  const j = await fetchJson(url);
  const n = Array.isArray(j?.articles) ? j.articles.length : 0;
  return Number.isFinite(n) ? n : 0;
}

// Build query differently for short vs long windows
function buildQueries(t, windowMin) {
  const name = NAME_BY_TICKER[t] || t;
  const extras = ALIASES[t] || [];
  const commonVariants = [
    `"${name}"`,
    `"${name} Inc"`,
    `"${name} Corp"`,
  ].concat(extras.map(s => `"${s}"`));

  // Base term set
  const base = `(${[t, `$${t}`].map(s=>s).concat(commonVariants).join(' OR ')})`;

  // WIDE for short windows (≤ 90m): no language filter, more recall
  const isShort = windowMin <= 90;

  const qStrict = `${base} AND sourcelang:english`;
  const qWide = base; // no language filter

  // We’ll try STRICT first for long windows, WIDE first for short windows
  return isShort
    ? { primary: encodeURIComponent(qWide), fallback: encodeURIComponent(qStrict) }
    : { primary: encodeURIComponent(qStrict), fallback: encodeURIComponent(qWide) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return httpRes(200, { ok: true });

  try {
    const url = new URL(event.rawUrl);
    const tickersParam = url.searchParams.get('tickers') || '';
    const windowMin = Math.max(1, Math.min(1440, Number(url.searchParams.get('window')) || DEFAULT_WINDOW_MIN));
    const span = timespanParam(windowMin);
    const dbg = url.searchParams.get('debug') === '1';

    const tickers = tickersParam
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    if (tickers.length === 0) {
      return httpRes(400, { error: 'tickers required, e.g. ?tickers=NVDA,AAPL' });
    }

    // 60s cache
    const key = `${tickers.join(',')}|${windowMin}`;
    const cached = cache.get(key);
    const now = Date.now();
    if (cached && now - cached.ts < 60_000) {
      return httpRes(200, cached.data);
    }

    const results = {};
    const diagnostics = dbg ? {} : undefined;

    const MAX_CONCURRENT = 4;
    let idx = 0;

    async function worker(){
      while (idx < tickers.length) {
        const t = tickers[idx++];
        const { primary, fallback } = buildQueries(t, windowMin);

        // 1) Primary (depends on window size as above)
        const url1 = `https://api.gdeltproject.org/api/v2/doc/doc?format=json&mode=TimelineVol&timespan=${span}&query=${primary}`;
        let j1 = await fetchJson(url1);
        let count = sumTimeline(j1);

        // 2) Fallback (swap strict/wide)
        if (!count) {
          const url2 = `https://api.gdeltproject.org/api/v2/doc/doc?format=json&mode=TimelineVol&timespan=${span}&query=${fallback}`;
          const j2 = await fetchJson(url2);
          count = sumTimeline(j2);
          if (dbg) diagnostics[t] = { timelinePrimary: j1?.timeline?.[0]?.data?.length||0, timelineFallback: j2?.timeline?.[0]?.data?.length||0 };
        }

        // 3) Final fallback: ArtList count
        if (!count) {
          const url3 = `https://api.gdeltproject.org/api/v2/doc/doc?format=json&mode=ArtList&maxrecords=250&timespan=${span}&query=${primary}`;
          count = await countViaArtList(primary, span);
          if (dbg) diagnostics[t] = { ...(diagnostics?.[t]||{}), usedArtList: true, artCount: count };
        }

        results[t] = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
        await sleep(80); // be polite
      }
    }

    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, tickers.length) }, worker));
    const payload = diagnostics ? { results, diagnostics } : results;

    cache.set(key, { ts: now, data: payload });
    return httpRes(200, payload);
  } catch (err) {
    return httpRes(500, { error: 'mentions failed', detail: String(err?.message || err) });
  }
};
