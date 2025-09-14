// netlify/functions/mentions.js
const DEFAULT_WINDOW_MIN = 60; // 1h
const FETCH_TIMEOUT_MS = 10_000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Ticker -> Company name (expand as you add tickers)
const NAME_BY_TICKER = {
  NVDA: "NVIDIA", AAPL: "Apple", MSFT: "Microsoft", AMZN: "Amazon",
  GOOGL: "Alphabet", META: "Meta", TSLA: "Tesla", AMD: "AMD",
  PLTR: "Palantir", NFLX: "Netflix", COIN: "Coinbase", GME: "GameStop",
  AMC: "AMC", RIVN: "Rivian", SNAP: "Snap", UBER: "Uber",
  SPOT: "Spotify", SHOP: "Shopify", DIS: "Disney", NIO: "NIO"
};

// per-instance cache to soften API spikes
const cache = new Map(); // key: `${tickers}|${windowMin}` -> { ts, data }

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

function sumTimeline(json) {
  try {
    const arr = json?.timeline?.[0]?.data;
    if (!Array.isArray(arr)) return 0;
    return arr.reduce((acc, d) => acc + (Number(d?.value) || 0), 0);
  } catch {
    return 0;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return httpRes(200, { ok: true });

  try {
    const url = new URL(event.rawUrl);
    const tickersParam = url.searchParams.get('tickers') || '';
    const windowMin = Math.max(1, Math.min(1440, Number(url.searchParams.get('window')) || DEFAULT_WINDOW_MIN));

    const tickers = tickersParam.split(',')
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
    await Promise.all(tickers.map(async (t) => {
      try {
        const name = NAME_BY_TICKER[t] || t;
        // ticker OR "Company Name" OR $TICKER; English only to reduce noise
        const q = encodeURIComponent(`(${t} OR "${name}" OR "$${t}") AND sourcelang:english`);
        const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?format=json&mode=TimelineVol&timespan=${windowMin}m&query=${q}`;

        const res = await withTimeout(gdeltUrl);
        if (!res.ok) { results[t] = 0; return; }
        const json = await res.json().catch(() => ({}));
        const count = sumTimeline(json);
        results[t] = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
      } catch {
        results[t] = 0;
      }
    }));

    cache.set(key, { ts: now, data: results });
    return httpRes(200, results);
  } catch (err) {
    return httpRes(500, { error: 'mentions failed', detail: String(err?.message || err) });
  }
};
