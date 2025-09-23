const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

// CORS configuration for Cloudflare frontend
app.use(cors({
  origin: [
    'https://4718c399.hypemeter.pages.dev',
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

// GDELT mentions endpoint (simplified and more reliable)
app.get('/api/mentions', async (req, res) => {
  try {
    const { tickers, window = 60 } = req.query;
    
    if (!tickers) {
      return res.status(400).json({ error: 'Tickers parameter is required' });
    }

    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = {};

    for (const ticker of tickerList) {
      try {
        // Simplified GDELT query - more reliable
        const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${ticker}&mode=artlist&maxrecords=100&format=json`;
        
        console.log(`Fetching GDELT data for ${ticker}:`, gdeltUrl);
        
        const response = await fetch(gdeltUrl, {
          timeout: 10000, // 10 second timeout
          headers: {
            'User-Agent': 'HypeMeter/1.0'
          }
        });
        
        if (!response.ok) {
          throw new Error(`GDELT API returned ${response.status}`);
        }
        
        const data = await response.json();
        console.log(`GDELT response for ${ticker}:`, data);
        
        // Handle different response formats
        let mentions = 0;
        if (data && data.articles) {
          mentions = data.articles.length;
        } else if (Array.isArray(data)) {
          mentions = data.length;
        }
        
        results[ticker] = {
          mentions: mentions,
          window: parseInt(window),
          timestamp: new Date().toISOString()
        };
        
      } catch (error) {
        console.error(`Error fetching mentions for ${ticker}:`, error.message);
        // Fallback with simulated data for testing
        results[ticker] = {
          mentions: Math.floor(Math.random() * 50) + 1, // Random 1-50 for testing
          window: parseInt(window),
          timestamp: new Date().toISOString(),
          note: 'Simulated data - GDELT API unavailable'
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
        console.log(`Fetching quote for ${ticker}`);
        
        // Get current quote
        const quoteResponse = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubApiKey}`,
          { timeout: 10000 }
        );
        
        if (!quoteResponse.ok) {
          throw new Error(`Finnhub API returned ${quoteResponse.status}`);
        }
        
        const quoteData = await quoteResponse.json();
        console.log(`Quote data for ${ticker}:`, quoteData);

        // Get basic company info
        const profileResponse = await fetch(
          `https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${finnhubApiKey}`,
          { timeout: 10000 }
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

    console.log(`Fetching hype data for: ${tickers}`);

    // Get mentions and quotes in parallel
    const mentionsUrl = `${req.protocol}://${req.get('host')}/api/mentions?tickers=${tickers}&window=${window}`;
    const quotesUrl = `${req.protocol}://${req.get('host')}/api/quotes?tickers=${tickers}`;
    
    console.log('Fetching from:', { mentionsUrl, quotesUrl });

    const [mentionsResponse, quotesResponse] = await Promise.all([
      fetch(mentionsUrl).catch(err => {
        console.error('Mentions fetch error:', err);
        return { json: () => ({}) };
      }),
      fetch(quotesUrl).catch(err => {
        console.error('Quotes fetch error:', err);
        return { json: () => ({}) };
      })
    ]);

    const mentions = await mentionsResponse.json();
    const quotes = await quotesResponse.json();

    console.log('Mentions data:', mentions);
    console.log('Quotes data:', quotes);

    const results = {};
    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());

    for (const ticker of tickerList) {
      const mentionData = mentions[ticker] || { mentions: 0 };
      const quoteData = quotes[ticker] || {};

      // Enhanced hype score calculation (0-100)
      let hypeScore = 0;
      
      if (mentionData.mentions !== undefined && !mentionData.error && !quoteData.error) {
        // Base score from mentions (normalized to 0-60 points)
        const mentionScore = Math.min(mentionData.mentions * 1.2, 60);
        
        // Volume bonus (0-20 points)
        let volumeBonus = 0;
        if (quoteData.volume && quoteData.volume > 0) {
          volumeBonus = Math.min((quoteData.volume / 10000000) * 20, 20);
        }
        
        // Price movement bonus (0-20 points)
        let priceMovementBonus = 0;
        if (quoteData.changePercent !== undefined) {
          priceMovementBonus = Math.min(Math.abs(quoteData.changePercent) * 2, 20);
        }
        
        hypeScore = Math.min(mentionScore + volumeBonus + priceMovementBonus, 100);
      } else if (mentionData.mentions > 0) {
        // If we only have mentions data
        hypeScore = Math.min(mentionData.mentions * 2, 100);
      }

      results[ticker] = {
        symbol: ticker,
        hypeScore: Math.round(hypeScore),
        mentions: mentionData.mentions || 0,
        price: quoteData.currentPrice || null,
        change: quoteData.change || null,
        changePercent: quoteData.changePercent || null,
        volume: quoteData.volume || null,
        name: quoteData.name || ticker,
        timestamp: new Date().toISOString(),
        debug: {
          mentionData: mentionData,
          quoteData: quoteData
        }
      };
    }

    console.log('Final results:', results);
    res.json(results);
  } catch (error) {
    console.error('Hype API error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Default route
app.get('/', (req, res) => {
  res.json({
    message: 'HypeMeter API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      mentions: '/api/mentions?tickers=NVDA,AAPL&window=60',
      quotes: '/api/quotes?tickers=NVDA,AAPL',
      hype: '/api/hype?tickers=NVDA,AAPL&window=60'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HypeMeter API server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`Finnhub API Key configured: ${process.env.FINNHUB_API_KEY ? 'Yes' : 'No'}`);
});
