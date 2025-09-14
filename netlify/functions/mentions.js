// netlify/functions/mentions.js
const DEFAULT_WINDOW_MIN = 60; // 1h
const FETCH_TIMEOUT_MS = 10_000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Expand as needed
const NAME_BY_TICKER = {
  NVDA: "NVIDIA", AAPL: "Apple", MSFT: "Microsoft", AMZN: "Amazon",
  GOOGL: "Alphabet", META: "Meta", TSLA: "Tesla", AMD: "AMD",
  PLTR: "Palantir", NFLX: "Netflix", COIN: "Coinbase", GME: "GameStop",
  AMC: "AMC", RIVN: "Rivian", SNAP: "Snap", UBER: "Uber",
  SPOT: "Spotify", SHOP: "Shopify", DIS: "Disney", NIO: "NIO"
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

// GDELT is quirky: use "24h" for day-sized windows, otherwise minutes.
function timespanParam(windowMin){
  if (windowMin % 60 === 0) return `${Math.max(1, windowMin/60)}h`;
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
  try {
    const arr = json?.timeline?.[0]?.data;
    if (!Array.isArray(arr)) return 0;
    return arr.reduce((acc, d) => acc + (Number(d?.value) || 0), 0);
  } catch {
    return 0;
  }
}

// FINAL fallback: count articles via ArtList mode (capped).
async function countViaArtList(query, span){
  // GDELT caps results; still better than hard zero.
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?format=json&mode=ArtList&maxrecords=250&timespan=${span}&query=${query}`;
  const j = await fetchJson(url);
  const arts = Array.isArray(j?.articles) ? j.articles.length : 0;
  return Number.isFinite(arts) ? arts : 0;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return httpRes(200, { ok: true });

  try {
    const url = new URL(event.rawUrl);
    const tickersParam = url.searchParams.get('tickers') || '';
    const windowMin = Math.max(1, Math.min(1440, Number(url.searchParams.get('window')) || DEFAULT_WINDOW_MIN));
    const dbg = url.searchParams.get('debug') === '1'; // optional: /mentions?...&debug=1

    const tickers = tickersParam
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    if (tickers.length === 0) {
      return httpRes(400, { error: 'tickers required, e.g. ?tickers=NVDA,AAPL' });
    }

    // simple 60s cache
    const key = `${tickers.join(',')}|${windowMin}`;
    const cached = cache.get(key);
    const now = Date.now();
    if (cached && now - cached.ts < 60_000) {
      return httpRes(200, cached.data);
    }

    const span = timespanParam(windowMin);
    const results = {};
    const diagnostics = dbg ? {} : undefined;

    const MAX_CONCURRENT = 4;
    let idx = 0;

    async function worker(){
      while (idx < tickers.length) {
        const t = tickers[idx++];
        const name = NAME_BY_TICKER[t] || t;

        // 1) Primary: TimelineVol with language filter
        const q1 = encodeURIComponent(`(${t} OR "${name}" OR "$${t}") AND sourcelang:english`);
        const url1 = `https://api.gdeltproject.org/api/v2/doc/doc?format=json&mode=TimelineVol&timespan=${span}&query=${q1}`;
        let j1 = await fetchJson(url1);
        let count = sumTimeline(j1);

        // 2) Fallback: same but without language filter
        if (!count) {
          const q2 = encodeURIComponent(`(${t} OR "${name}" OR "$${t}")`);
          const url2 = `https://api.gdeltproject.org/api/v2/doc/doc?format=json&mode=TimelineVol&timespan=${span}&query=${q2}`;
          const j2 = await fetchJson(url2);
          count = sumTimeline(j2);

          if (dbg) diagnostics[t] = { url1, timeline1: j1?.timeline?.[0]?.data?.length || 0, url2, timeline2: j2?.timeline?.[0]?.data?.length || 0 };
        }

        // 3) Final fallback: ArtList count (non-zero if there are any articles)
        if (!count) {
          const q3 = encodeURIComponent(`(${t} OR "${name}" OR "$${t}")`);
          count = await countViaArtList(q3, span);
          if (dbg) diagnostics[t] = { ...(diagnostics?.[t]||{}), usedArtList: true, artCount: count };
        }

        results[t] = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;

        // small spacing to be polite to GDELT
        await sleep(80);
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
