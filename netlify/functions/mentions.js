// netlify/functions/mentions.js
//
// Strong mentions endpoint:
// - GDELT (english) first, then Google News RSS fallback (no keys)
// - Counts total hits + unique source domains (breadth)
// - Caps per-domain contribution to reduce spam
// - 2-minute in-memory cache to stabilize results and avoid rate limits

let CACHE = { ts: 0, key: "", data: {} };
const TTL_MS = 2 * 60 * 1000;          // cache window
const PER_DOMAIN_CAP = 8;              // max articles counted per domain per window
const UA = "HypeMeter/1.0 (+https://thehypemeter.netlify.app)";

export const handler = async (event) => {
  try {
    const url = new URL(event.rawUrl);
    const tickers = (url.searchParams.get("tickers") || "")
      .split(",").map(s => s.trim()).filter(Boolean);
    const windowMin = Math.max(15, parseInt(url.searchParams.get("window") || "60", 10));

    if (!tickers.length) return resp(400, { error: "tickers required" });

    // serve cache if inputs match and cache is fresh
    const cacheKey = JSON.stringify({ tickers, windowMin });
    const now = Date.now();
    if (CACHE.key === cacheKey && now - CACHE.ts < TTL_MS) {
      return resp(200, CACHE.data, true);
    }

    const out = {};
    for (const t of tickers) {
      // Per-ticker counters
      let total = 0;
      const countsByDomain = new Map();

      // ---- 1) GDELT (english filter, last windowMin minutes) ----
      try {
        const q = encodeURIComponent(
          `(${t}) AND (stock OR shares OR ticker OR company OR earnings OR price) sourcelang:english`
        );
        const gdeltURL =
          `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}` +
          `&mode=ArtList&format=json&maxrecords=150&timespan=${windowMin}m`;
        const r = await fetch(gdeltURL, { headers: { "User-Agent": UA } });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.articles)) {
            for (const a of j.articles) {
              const d = normDomain(a.domain || a.sourceDomain || a.url);
              if (!d) continue;
              const used = countsByDomain.get(d) || 0;
              if (used < PER_DOMAIN_CAP) {
                countsByDomain.set(d, used + 1);
                total++;
              }
            }
          }
        }
      } catch { /* ignore and try fallback */ }

      // ---- 2) Google News RSS fallback (still within windowMin) ----
      if (total === 0) {
        try {
          const since = Date.now() - windowMin * 60 * 1000;
          const urlNews =
            `https://news.google.com/rss/search?q=${encodeURIComponent(t + " stock")}` +
            `&hl=en-US&gl=US&ceid=US:en`;
          const r = await fetch(urlNews, { headers: { "User-Agent": UA } });
          if (r.ok) {
            const xml = await r.text();
            const items = xml.split("<item>").slice(1);
            for (const it of items) {
              const m = it.match(/<pubDate>([^<]+)<\/pubDate>/i);
              const link = (it.match(/<link>([^<]+)<\/link>/i) || [])[1] || "";
              const ts = m ? Date.parse(m[1]) : NaN;
              if (!isFinite(ts) || ts < since) continue;
              const d = normDomain(link);
              if (!d) continue;
              const used = countsByDomain.get(d) || 0;
              if (used < PER_DOMAIN_CAP) {
                countsByDomain.set(d, used + 1);
                total++;
              }
            }
          }
        } catch { /* ignore */ }
      }

      out[t] = { count: total, domains: countsByDomain.size };
      // Optional: brief delay to be polite to upstreams
      // await new Promise(res => setTimeout(res, 40));
    }

    // update cache
    CACHE = { ts: now, key: cacheKey, data: out };
    return resp(200, out);

  } catch (e) {
    return resp(500, { error: String(e) });
  }
};

// ---- helpers ----
function normDomain(u) {
  try {
    const host = new URL(u.startsWith("http") ? u : `https://${u}`).hostname;
    return host.replace(/^www\./, "").toLowerCase();
  } catch { return null; }
}

function resp(statusCode, body, cached = false) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cached ? "public, max-age=30" : "no-store"
    },
    body: JSON.stringify(body)
  };
}
