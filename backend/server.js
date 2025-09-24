const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const app = express();

// Simplified hype calculator without complex historical tracking for now
class SimpleHypeCalculator {
  constructor() {
    this.cache = new Map();
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  }

  getFromCache(key) {
    const item = this.cache.get(key);
    if (item && Date.now() - item.timestamp < this.CACHE_TTL) {
      return item.data;
    }
    this.cache.delete(key);
    return null;
  }

  setCache(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  async getRedditMentions(tickerList, window) {
    const results = {};
    const subreddits = ['wallstreetbets', 'stocks', 'investing'];
    
    for (const ticker of tickerList) {
      try {
        let totalMentions = 0;
        const timeFilter = Math.floor((Date.now() - (window * 60 * 1000)) / 1000);
        
        for (const subreddit of subreddits) {
          try {
            const redditUrl = `https://www.reddit.com/r/${subreddit}/search.json?q=${ticker}&restrict_sr=1&sort=new&limit=50&t=hour`;
            
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            
            const response = await fetch(redditUrl, {
              signal: controller.signal,
              headers: {
                'User-Agent': 'HypeMeter:v2.5 (by /u/stocktracker)'
              }
            });
            
            clearTimeout(timeout);
            
            if (!response.ok) continue;
            
            const data = await response.json();
            
            if (data && data.data && data.data.children) {
              const recentPosts = data.data.children.filter(post => {
                return post.data.created_utc > timeFilter;
              });
              
              let subredditMentions = 0;
              recentPosts.forEach(post => {
                const title = (post.data.title || '').toUpperCase();
                const text = (post.data.selftext || '').toUpperCase();
                
                const tickerPatterns = [
                  new RegExp(`\\b${ticker}\\b`, 'g'),
                  new RegExp(`\\$${ticker}\\b`, 'g')
                ];
                
                tickerPatterns.forEach(pattern => {
                  const titleMatches = (title.match(pattern) || []).length;
                  const textMatches = (text.match(pattern) || []).length;
                  subredditMentions += titleMatches + textMatches;
                });
              });
              
              totalMentions += subredditMentions;
            }
          } catch (subredditError) {
            console.error(`Error searching r/${subreddit} for ${ticker}:`, subredditError.message);
          }
        }
        
        results[ticker] = {
          mentions: totalMentions,
          window: parseInt(window),
          timestamp: new Date().toISOString(),
          source: 'reddit'
        };
        
      } catch (error) {
        console.error(`Reddit mentions error for ${ticker}:`, error.message);
        results[ticker] = {
          mentions: 0,
          window: parseInt(window),
          timestamp: new Date().toISOString(),
          source: 'unavailable',
          error: 'Reddit API failed'
        };
      }
    }
    
    return results;
  }

  calculateHypeScore(mentions, volume, priceChangePercent) {
    let hypeScore = 0;
    
    // Base score from mentions (0-60 points)
    hypeScore = Math.min(mentions * 2, 60);
    
    // Volume bonus (0-20 points)
    if (volume && volume > 0) {
      const volumeScore = Math.min(Math.log(volume / 1000000 + 1) * 15, 20);
      hypeScore += volumeScore;
    }
    
    // Price movement bonus (0-20 points)
    if (priceChangePercent !== undefined && priceChangePercent !== null) {
      const priceScore = Math.min(Math.abs(priceChangePercent) * 2.5, 20);
      hypeScore += priceScore;
    }
    
    return Math.min(Math.round(hypeScore), 100);
  }
}

const hypeCalc = new SimpleHypeCalculator();

// CORS configuration
app.use(cors({
  origin: [
    'https://hypemeter.ai',
    'https://www.hypemeter.ai',
    'https://cooldude-ai.github.io',
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
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    cache_size: hypeCalc.cache.size
  });
});

// Keep-alive endpoint
app.get('/keepalive', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Reddit mentions endpoint
app.get('/api/mentions', async (req, res) => {
  try {
    const { tickers, window = 60 } = req.query;
    
    if (!tickers) {
      return res.status(400).json({ error: 'Tickers parameter is required' });
    }

    const cacheKey = `mentions_${tickers}_${window}`;
    const cached = hypeCalc.getFromCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = await hypeCalc.getRedditMentions(tickerList, window);

    hypeCalc.setCache(cacheKey, results);
    res.json(results);
    
  } catch (error) {
    console.error('Reddit mentions API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Quotes endpoint
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

    const cacheKey = `quotes_${tickers}`;
    const cached = hypeCalc.getFromCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = {};

    const promises = tickerList.map(async (ticker) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        
        const quoteResponse = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubApiKey}`,
          { signal: controller.signal }
        );
        
        clearTimeout(timeout);
        
        if (!quoteResponse.ok) throw new Error(`Finnhub error: ${quoteResponse.status}`);
        
        const quoteData = await quoteResponse.json();

        if (quoteData.c && quoteData.pc) {
          const currentPrice = quoteData.c;
          const previousClose = quoteData.pc;
          const change = currentPrice - previousClose;
          const changePercent = (change / previousClose) * 100;

          return {
            ticker,
            data: {
              symbol: ticker,
              name: ticker,
              currentPrice: currentPrice,
              previousClose: previousClose,
              change: change,
              changePercent: changePercent,
              volume: quoteData.v || 0,
              timestamp: new Date().toISOString()
            }
          };
        } else {
          throw new Error('Invalid data from Finnhub');
        }
      } catch (error) {
        console.error(`Quote error for ${ticker}:`, error.message);
        return {
          ticker,
          data: {
            symbol: ticker,
            error: 'Failed to fetch quote data'
          }
        };
      }
    });

    const responses = await Promise.all(promises);
    responses.forEach(({ ticker, data }) => {
      results[ticker] = data;
    });

    hypeCalc.setCache(cacheKey, results);
    res.json(results);
    
  } catch (error) {
    console.error('Quotes API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Hype scores endpoint
app.get('/api/hype', async (req, res) => {
  try {
    const { tickers, window = 60 } = req.query;
    
    if (!tickers) {
      return res.status(400).json({ error: 'Tickers parameter is required' });
    }

    const cacheKey = `hype_${tickers}_${window}`;
    const cached = hypeCalc.getFromCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const [mentionsResponse, quotesResponse] = await Promise.all([
      fetch(`${req.protocol}://${req.get('host')}/api/mentions?tickers=${tickers}&window=${window}`)
        .then(r => r.json())
        .catch(() => ({})),
      fetch(`${req.protocol}://${req.get('host')}/api/quotes?tickers=${tickers}`)
        .then(r => r.json())
        .catch(() => ({}))
    ]);

    const results = {};
    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());

    for (const ticker of tickerList) {
      const mentionData = mentionsResponse[ticker] || { mentions: 0 };
      const quoteData = quotesResponse[ticker] || {};

      const hypeScore = hypeCalc.calculateHypeScore(
        mentionData.mentions || 0,
        quoteData.volume || 0,
        quoteData.changePercent
      );

      results[ticker] = {
        symbol: ticker,
        hypeScore: hypeScore,
        mentions: mentionData.mentions || 0,
        price: quoteData.currentPrice || null,
        change: quoteData.change || null,
        changePercent: quoteData.changePercent || null,
        volume: quoteData.volume || null,
        name: quoteData.name || ticker,
        timestamp: new Date().toISOString()
      };
    }

    hypeCalc.setCache(cacheKey, results);
    res.json(results);
    
  } catch (error) {
    console.error('Hype API error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Default route
app.get('/', (req, res) => {
  res.json({
    message: 'HypeMeter.ai - Reddit Social Media Hype Tracking',
    version: '2.5.0',
    status: 'running',
    data_source: 'Reddit (r/wallstreetbets, r/stocks, r/investing)',
    cache_size: hypeCalc.cache.size,
    endpoints: {
      health: '/health',
      keepalive: '/keepalive',
      mentions: '/api/mentions?tickers=NVDA,AAPL&window=60',
      quotes: '/api/quotes?tickers=NVDA,AAPL',
      hype: '/api/hype?tickers=NVDA,AAPL&window=60'
    }
  });
});

// Self-ping to prevent cold starts
if (process.env.NODE_ENV === 'production') {
  setInterval(async () => {
    try {
      const url = process.env.RENDER_EXTERNAL_URL || 'https://hypemeter.onrender.com';
      await fetch(`${url}/keepalive`);
      console.log('Keep-alive ping sent');
    } catch (error) {
      console.error('Keep-alive failed:', error.message);
    }
  }, 14 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HypeMeter.ai API server running on port ${PORT}`);
  console.log(`Reddit social media tracking enabled`);
  console.log(`Finnhub API Key configured: ${process.env.FINNHUB_API_KEY ? 'Yes' : 'No'}`);
});
