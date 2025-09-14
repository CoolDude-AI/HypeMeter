// netlify/functions/mentions.js
// Counts recent news mentions per ticker using GDELT (no key).
// Example: /.netlify/functions/mentions?tickers=NVDA,AAPL&window=60
export const handler = async (event) => {
  try {
    const url = new URL(event.rawUrl);
    const tickers = (url.searchParams.get('tickers') || '').split(',').map(s=>s.trim()).filter(Boolean);
    const windowMin = parseInt(url.searchParams.get('window') || '60', 10);
    if(!tickers.length) return resp(400, { error: 'tickers required' });

    // Query GDELT per ticker, limited to 60 minutes. We use mode=ArtList and maxrecords to cap.
    // Note: GDELT may rate limit; in production add caching.
    const counts = {};
    for(const t of tickers){
      const q = encodeURIComponent(`${t} stock OR ${t} shares OR ${t} company`);
      const gdelt = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=ArtList&maxrecords=75&format=json&timespan=${windowMin}m`;
      try {
        const res = await fetch(gdelt, { headers: { 'User-Agent': 'HypeMeter/1.0' }});
        if(!res.ok) { counts[t] = 0; continue; }
        const data = await res.json();
        counts[t] = Array.isArray(data.articles) ? data.articles.length : 0;
      } catch(e){
        counts[t] = 0;
      }
      // Small delay could be added here to be nicer to GDELT
    }
    return resp(200, counts);
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
