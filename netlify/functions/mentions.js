// netlify/functions/mentions.js
export const handler = async (event) => {
  try {
    const url = new URL(event.rawUrl);
    const tickers = (url.searchParams.get('tickers') || '')
      .split(',').map(s=>s.trim()).filter(Boolean);
    const windowMin = Math.max(15, parseInt(url.searchParams.get('window') || '60', 10));
    if (!tickers.length) return resp(400, { error: 'tickers required' });

    const out = {};
    for (const t of tickers) {
      // 1) GDELT
      const q = encodeURIComponent(`(${t}) AND (stock OR shares OR ticker OR company OR earnings OR price) sourcelang:english`);
      const gdelt = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=ArtList&format=json&maxrecords=100&timespan=${windowMin}m`;
      let count = 0;
      try {
        const r = await fetch(gdelt, { headers: { 'User-Agent': 'HypeMeter/1.0' } });
        if (r.ok) {
          const j = await r.json();
          count = Array.isArray(j.articles) ? j.articles.length : 0;
        }
      } catch {}

      // 2) Google News RSS fallback
      if (count === 0) {
        const since = Date.now() - windowMin * 60 * 1000;
        const gnews = `https://news.google.com/rss/search?q=${encodeURIComponent(t + ' stock')}&hl=en-US&gl=US&ceid=US:en`;
        try {
          const r = await fetch(gnews, { headers: { 'User-Agent': 'HypeMeter/1.0' } });
          if (r.ok) {
            const xml = await r.text();
            const items = xml.split('<item>').slice(1);
            let c = 0;
            for (const it of items) {
              const m = it.match(/<pubDate>([^<]+)<\/pubDate>/i);
              if (!m) continue;
              const ts = Date.parse(m[1]);
              if (isFinite(ts) && ts >= since) c++;
            }
            count = c;
          }
        } catch {}
      }

      out[t] = count;
      // await new Promise(r => setTimeout(r, 40)); // optional pacing
    }

    return resp(200, out);
  } catch (e) {
    return resp(500, { error: String(e) });
  }
};

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
