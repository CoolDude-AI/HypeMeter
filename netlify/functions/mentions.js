// netlify/functions/mentions.js
// Mentions with breadth: returns { TICKER: { count, domains } }

export const handler = async (event) => {
  try {
    const url = new URL(event.rawUrl);
    const tickers = (url.searchParams.get('tickers') || '')
      .split(',').map(s=>s.trim()).filter(Boolean);
    const windowMin = Math.max(15, parseInt(url.searchParams.get('window') || '60', 10));
    if (!tickers.length) return resp(400, { error: 'tickers required' });

    const out = {};
    for (const t of tickers) {
      let count = 0, domainSet = new Set();

      // ---- GDELT first ----
      try {
        const q = encodeURIComponent(`(${t}) AND (stock OR shares OR ticker OR company OR earnings OR price) sourcelang:english`);
        const gdelt = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=ArtList&format=json&maxrecords=100&timespan=${windowMin}m`;
        const r = await fetch(gdelt, { headers: { 'User-Agent': 'HypeMeter/1.0' } });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.articles)) {
            count += j.articles.length;
            for (const a of j.articles) {
              const d = a.domain || a.sourceDomain || hostname(a.url) || null;
              if (d) domainSet.add(d.toLowerCase());
            }
          }
        }
      } catch (_) {}

      // ---- Google News RSS fallback if still empty ----
      if (count === 0) {
        try {
          const since = Date.now() - windowMin*60*1000;
          const urlNews = `https://news.google.com/rss/search?q=${encodeURIComponent(t + ' stock')}&hl=en-US&gl=US&ceid=US:en`;
          const r = await fetch(urlNews, { headers: { 'User-Agent': 'HypeMeter/1.0' } });
          if (r.ok) {
            const xml = await r.text();
            const items = xml.split('<item>').slice(1);
            for (const it of items) {
              const m = it.match(/<pubDate>([^<]+)<\/pubDate>/i);
              const link = (it.match(/<link>([^<]+)<\/link>/i) || [])[1] || '';
              const ts = m ? Date.parse(m[1]) : NaN;
              if (isFinite(ts) && ts >= since) {
                count++;
                const d = hostname(link);
                if (d) domainSet.add(d.toLowerCase());
              }
            }
          }
        } catch (_) {}
      }

      out[t] = { count, domains: domainSet.size };
      // await new Promise(res => setTimeout(res, 40)); // polite pacing
    }

    return resp(200, out);
  } catch (e) {
    return resp(500, { error: String(e) });
  }
};

function hostname(u){
  try { return new URL(u).hostname.replace(/^www\./,''); } catch { return null; }
}

function resp(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}
