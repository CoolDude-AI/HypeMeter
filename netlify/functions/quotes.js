// netlify/functions/quotes.js
const API = 'https://finnhub.io/api/v1';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY; // set in Netlify env
const FETCH_TIMEOUT_MS = 10_000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const cache = new Map(); // `${ticker}` -> { ts, data }

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

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

async function getQuote(t) {
  const url = `${API}/quote?symbol=${encodeURIComponent(t)}&token=${FINNHUB_KEY}`;
  const res = await withTimeout(url);
  if (!res.ok) throw new Error(`quote ${t} ${res.status}`);
  const j = await res.json().catch(() => ({}));
  return {
    c: num(j.c, NaN),  // current
    pc: num(j.pc, NaN),// prev close
    v: num(j.v, NaN),  // today volume
  };
}

async function getMetrics(t) {
  const url = `${API}/stock/metric?symbol=${encodeURIComponent(t)}&metric=all&token=${FINNHUB_KEY}`;
  const res = await withTimeout(url);
  if (!res.ok) throw new Error(`metric ${t} ${res.status}`);
  const j = await res.json().catch(() => ({}));
  const m = j?.metric || {};
  const avgVol =
    num(m['10DayAverageTradingVolume'], NaN) ||
    num(m['3MonthAverageTradingVolume'], NaN) ||
    num(m['52WeekAverageVolume'], NaN) ||
    NaN;
  return { avgVol };
}

const computeChgPct = (c, pc) =>
  (!Number.isFinite(c) || !Number.isFinite(pc) || pc === 0) ? 0 : ((c - pc) / pc) * 100;

const computeVolRel = (todayVol, avgVol) => {
  if (!Number.isFinite(todayVol) || todayVol <= 0) return 1;
  if (!Number.isFinite(avgVol) || avgVol <= 0) return 1;
  const r = todayVol / avgVol;
  return Math.max(0.3, Math.min(3, r)); // clamp
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return httpRes(200, { ok: true });

  try {
    if (!FINNHUB_KEY) {
      return httpRes(500, { error: 'Missing FINNHUB_API_KEY env var' });
    }

    const url = new URL(event.rawUrl);
    const tickersParam = url.searchParams.get('tickers') || '';
    const tickers = tickersParam.split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    if (tickers.length === 0) {
      return httpRes(400, { error: 'tickers required, e.g. ?tickers=NVDA,AAPL' });
    }

    const out = {};
    const now = Date.now();

    // tiny concurrency limiter (be kind to Finnhub)
    const MAX_CONCURRENT = 4;
    let i = 0;
    async function worker() {
      while (i < tickers.length) {
        const t = tickers[i++];
        try {
          const cached = cache.get(t);
          if (cached && now - cached.ts < 30_000) { // 30s cache
            out[t] = cached.data;
            continue;
          }

          const [q, m] = await Promise.allSettled([getQuote(t), getMetrics(t)]);
          const quote = q.status === 'fulfilled' ? q.value : { c: NaN, pc: NaN, v: NaN };
          const metrics = m.status === 'fulfilled' ? m.value : { avgVol: NaN };

          const chgPct = num(computeChgPct(quote.c, quote.pc), 0);
          const volRel = num(computeVolRel(quote.v, metrics.avgVol), 1);

          const data = { chgPct, volRel };
          out[t] = data;
          cache.set(t, { ts: now, data });
        } catch {
          out[t] = { chgPct: 0, volRel: 1 };
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, tickers.length) }, worker));
    return httpRes(200, out);
  } catch (err) {
    return httpRes(500, { error: 'quotes failed', detail: String(err?.message || err) });
  }
};
