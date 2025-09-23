const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

// CORS configuration for Cloudflare frontend
app.use(cors({
  origin: [
    'https://your-cloudflare-domain.com',
    'https://hypemeter.pages.dev',
    'http://localhost:3000',
    'http://localhost:8000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GDELT mentions endpoint (no API key required)
app.get('/api/mentions', async (req, res) => {
  try {
    const { tickers, window = 60 } = req.query;
    
    if (!tickers) {
      return res.status(400).json({ error: 'Tickers parameter is required' });
    }

    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = {};

    // GDELT API endpoint for mentions in the last X minutes
    const now = new Date();
    const startTime = new Date(now.getTime() - (window * 60 * 1000));
    
    // Format dates for GDELT (YYYYMMDDHHMM format)
    const formatGDELTDate = (date) => {
      return date.getUTCFullYear().toString() +
             (date.getUTCMonth() + 1).toString().padStart(2, '0') +
             date.getUTCDate().toString().padStart(2, '0') +
             date.getUTCHours().toString().padStart(2, '0') +
             date.getUTCMinutes().toString().padStart(2, '0');
    };

    const startTimeFormatted = formatGDELTDate(startTime);
    const endTimeFormatted = formatGDELTDate(now);

    for (const ticker of tickerList) {
      try {
        // GDELT Global Knowledge Graph API
        const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${ticker}&mode=artlist&maxrecords=250&timespan=${startTimeFormatted}-${endTimeFormatted}&format=json`;
        
        const response = await fetch(gdeltUrl);
        const data = await response.json();
        
        results[ticker] = {
          mentions: data.articles ? data.articles.length : 0,
          window: parseInt(window),
          timestamp: now.toISOString()
        };
      } catch (error) {
        console.error(`Error fetching mentions for ${ticker}:`, error);
        results[ticker] = {
          mentions: 0,
          window: parseInt(window),
          timestamp: now.toISOString(),
          error: 'Failed to fetch mentions'
        };
      }
    }

    res.json(results);
  } catch (error) {
    console.error('Mentions API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Finnhub quotes endpoint (requires API key)
app.get('/api/quotes', async (req, res) => {
  try {
    const { tickers } = req.query;
    const finnhubApiKey = process.env.FINNHUB_API_KEY;

    if (!finnhubApiKey) {
      return res.status(500).json({ error: 'Finnhub API key not configured' });
    }

    if (!tickers) {
      return res.status(400).json({ error: 'Tickers parameter is required' });
    }

    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = {};

    for (const ticker of tickerList) {
      try {
        // Get current quote
        const quoteResponse = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubApiKey}`
        );
        const quoteData = await quoteResponse.json();

        // Get basic company info
        const profileResponse = await fetch(
          `https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${finnhubApiKey}`
        );
        const profileData = await profileResponse.json();

        if (quoteData.c && quoteData.pc) {
          const currentPrice = quoteData.c;
          const previousClose = quoteData.pc;
          const change = currentPrice - previousClose;
          const changePercent = (change / previousClose) * 100;

          results[ticker] = {
            symbol: ticker,
            name: profileData.name || ticker,
            currentPrice: currentPrice,
            previousClose: previousClose,
            change: change,
            changePercent: changePercent,
            volume: quoteData.v || 0,
            timestamp: new Date().toISOString()
          };
        } else {
          results[ticker] = {
            symbol: ticker,
            error: 'Invalid ticker or no data available'
          };
        }
      } catch (error) {
        console.error(`Error fetching quote for ${ticker}:`, error);
        results[ticker] = {
          symbol: ticker,
          error: 'Failed to fetch quote data'
        };
      }
    }

    res.json(results);
  } catch (error) {
    console.error('Quotes API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Combined hype score endpoint
app.get('/api/hype', async (req, res) => {
  try {
    const { tickers, window = 60 } = req.query;
    
    if (!tickers) {
      return res.status(400).json({ error: 'Tickers parameter is required' });
    }

    // Get mentions and quotes in parallel
    const [mentionsResponse, quotesResponse] = await Promise.all([
      fetch(`${req.protocol}://${req.get('host')}/api/mentions?tickers=${tickers}&window=${window}`),
      fetch(`${req.protocol}://${req.get('host')}/api/quotes?tickers=${tickers}`)
    ]);

    const mentions = await mentionsResponse.json();
    const quotes = await quotesResponse.json();

    const results = {};
    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());

    for (const ticker of tickerList) {
      const mentionData = mentions[ticker] || { mentions: 0 };
      const quoteData = quotes[ticker] || {};

      // Simple hype score calculation (0-100)
      // This is a basic implementation - you can enhance this algorithm
      let hypeScore = 0;
      
      if (mentionData.mentions > 0 && !mentionData.error && !quoteData.error) {
        // Base score from mentions (normalized)
        const mentionScore = Math.min(mentionData.mentions * 2, 50); // Cap at 50 points
        
        // Volume bonus (if available)
        const volumeBonus = quoteData.volume ? Math.min(quoteData.volume / 1000000 * 10, 25) : 0; // Cap at 25 points
        
        // Price movement bonus/penalty
        const priceMovement = quoteData.changePercent ? Math.abs(quoteData.changePercent) * 2.5 : 0; // Cap contributes to remaining 25 points
        
        hypeScore = Math.min(mentionScore + volumeBonus + priceMovement, 100);
      }

      results[ticker] = {
        symbol: ticker,
        hypeScore: Math.round(hypeScore),
        mentions: mentionData.mentions,
        price: quoteData.currentPrice,
        change: quoteData.change,
        changePercent: quoteData.changePercent,
        volume: quoteData.volume,
        timestamp: new Date().toISOString()
      };
    }

    res.json(results);
  } catch (error) {
    console.error('Hype API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Default route
app.get('/', (req, res) => {
  res.json({
    message: 'HypeMeter API',
    version: '1.0.0',
    endpoints: {
      mentions: '/api/mentions?tickers=NVDA,AAPL&window=60',
      quotes: '/api/quotes?tickers=NVDA,AAPL',
      hype: '/api/hype?tickers=NVDA,AAPL&window=60'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HypeMeter API server running on port ${PORT}`);
});
