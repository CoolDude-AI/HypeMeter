// netlify/functions/quotes.js
// Robust Finnhub quotes with retry, pacing, and 30s in-memory cache.

let CACHE = { ts: 0, data: {} };              // survives warm invocations
const TTL_MS = 30_000;                        // cache for 30s
const PER_TICKER_DELAY_MS = 180;              // pace requests (avoid free-tier throttling)
const MAX_RETRIES = 3;

export const handler = async (event) => {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return resp(500, { error: "Missing FINNHUB_API_KEY" });

  try {
    const url = new URL(event.rawUrl);
    const tickers = (url.searchParams.get("tickers") || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    if (!tickers.length) return resp(400, { error: "tickers required" });

    // Serve fresh-enough cache to avoid flicker under rate limits
    const now = Date.now();
    if (now - CACHE.ts < TTL_MS) {
      // return only the subset requested
      const subset = {};
      for (const t of tickers) subset[t] = CACHE.data[t] || {};
      return resp(200, subset, true);
    }

    const out = {};
    for (const t of tickers) {
      out[t] = await fetchWithRetry(() =>
        fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(t)}&token=${key}`)
      );
      // normalize shape
      if (out[t]?.ok && out[t].json) {
        const j = out[t].json;
        out[t] = { price: j.c, chgPct: j.dp, volRel: 1 };
      } else {
        out[t] = {}; // on failure keep empty; UI will hold last value
      }
      await delay(PER_TICKER_DELAY_MS);
    }

    // update cache if at least one succeeded
    const anyGood = Object.values(out).some(v => Number.isFinite(v?.price) || Number.isFinite(v?.chgPct));
    if (anyGood) {
      CACHE = { ts: now, data: { ...CACHE.data, ...out } };
    }

    // return merged: prefer fresh, fall back to cache when empty
    const merged = {};
    for (const t of tickers) {
      merged[t] = (Object.keys(out[t]).length ? out[t] : (CACHE.data[t] || {}));
    }
    return resp(200, merged);
  } catch (e) {
    return resp(500, { error: String(e) });
  }
};

async function fetchWithRetry(fn) {
  let lastErr = null, json = null;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const r = await fn();
      if (r.ok) {
        json = await r.json();
        return { ok: true, json };
      }
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) { lastErr = e; }
    await delay(200 * (i + 1)); // backoff
  }
  return { ok: false, error: String(lastErr || "unknown") };
}

function delay(ms){ return new Promise(res => setTimeout(res, ms)); }

function resp(statusCode, body, cached=false){
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      // help browser/CDN cache briefly too
      "Cache-Control": cached ? "public, max-age=15" : "no-store"
    },
    body: JSON.stringify(body)
  };
}
