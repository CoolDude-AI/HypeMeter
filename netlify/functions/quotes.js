// netlify/functions/quotes.js
// Gets quote + change% per ticker from Finnhub. Requires FINNHUB_API_KEY env var.
// Example: /.netlify/functions/quotes?tickers=NVDA,AAPL
export const handler = async (event) => {
  const key = process.env.FINNHUB_API_KEY;
  if(!key) return resp(500, { error: 'Missing FINNHUB_API_KEY' });
  try {
    const url = new URL(event.rawUrl);
    const tickers = (url.searchParams.get('tickers') || '').split(',').map(s=>s.trim()).filter(Boolean);
    if(!tickers.length) return resp(400, { error: 'tickers required' });

    const out = {};
    // Finnhub: /quote returns { c: current, dp: change percent, pc: prev close, ... }
    // We'll also compute a crude rel volume if /stock/metric is needed in future.
    const base = 'https://finnhub.io/api/v1/quote';
    for(const t of tickers){
      try {
        const res = await fetch(`${base}?symbol=${encodeURIComponent(t)}&token=${key}`);
        if(!res.ok) { out[t] = {}; continue; }
        const j = await res.json();
        out[t] = { price: j.c, chgPct: j.dp, volRel: 1 };
      } catch(e){
        out[t] = {};
      }
    }
    return resp(200, out);
  } catch (e) {
    return resp(500, { error: String(e) });
  }
};

function resp(statusCode, body){
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}
