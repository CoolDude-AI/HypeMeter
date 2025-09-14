# HypeMeter (Netlify demo)

This is a **deploy-ready** project that fetches:
- **Mentions** per ticker from **GDELT** (last 60 minutes) without an API key.
- **Quotes** and % change from **Finnhub** (requires `FINNHUB_API_KEY`).

## Deploy (2 minutes)

1. **Download this folder** and drag it into your Netlify dashboard ("Add new site" → "Deploy manually").  
2. Go to **Site Settings → Environment variables** and add:
   - `FINNHUB_API_KEY` = your key (free plan works for testing).
3. Click **Deploy** (or just trigger a redeploy).
4. Open `https://YOUR-SITE.netlify.app` — the board will refresh every 5 minutes.

## Endpoints
- Mentions (no key): `/.netlify/functions/mentions?tickers=NVDA,AAPL&window=60`
- Quotes (needs key): `/.netlify/functions/quotes?tickers=NVDA,AAPL`

## Notes
- The hype score is a simple normalized lift vs. your **local 30-day baseline** stored in `localStorage`. First visit uses current counts as baseline and adapts over time.
- You can change the SYMBOLS list in `index.html`.
- To add Reddit/X later, create a new function (e.g., `social.js`) and compute mentions there (keeps your keys/private logic off the client).

Enjoy!
