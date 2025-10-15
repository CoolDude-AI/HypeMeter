const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const app = express();

// Simplified for Phase 1: Get APIs working first
class HypeCalculator {
  constructor() {
    this.cache = new Map();
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  }

  getFromCache(key) {
    const item = this.cache.get(key);
    if (item && Date.now() - item.timestamp < this.CACHE_TTL) {
      console.log(`Cache hit: ${key}`);
      return item.data;
    }
    this.cache.delete(key);
    return null;
  }

  setCache(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  async getRedditMentions(tickerList, windowMinutes) {
    const results = {};
    const subreddits = ['wallstreetbets', 'stocks', 'investing', 'stockmarket'];
    
    console.log(`\n=== Fetching Reddit mentions for: ${tickerList.join(', ')} ===`);
    
    for (const ticker of tickerList) {
      try {
        let totalMentions = 0;
        const timeFilterUnix = Math.floor((Date.now() - (windowMinutes * 60 * 1000)) / 1000);
        
        console.log(`\nSearching for ${ticker} in Reddit...`);
        console.log(`Time filter: last ${windowMinutes} minutes (since ${new Date(timeFilterUnix * 1000).toISOString()})`);
        
        for (const subreddit of subreddits) {
          try {
            // Use Reddit's search with time filter
            const redditUrl = `https://www.reddit.com/r/${subreddit}/search.json?q=${ticker}&restrict_sr=1&sort=new&limit=100&t=day`;
            
            console.log(`  Checking r/${subreddit}...`);
            
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            
            const response = await fetch(redditUrl, {
              signal: controller.signal,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            });
            
            clearTimeout(timeout);
            
            if (!response.ok) {
              console.log(`    ❌ HTTP ${response.status}`);
              continue;
            }
            
            const data = await response.json();
            
            if (!data || !data.data || !data.data.children) {
              console.log(`    ❌ Invalid response structure`);
              continue;
            }
            
            // Filter posts within time window
            const recentPosts = data.data.children.filter(post => {
              return post.data.created_utc > timeFilterUnix;
            });
            
            console.log(`    Found ${data.data.children.length} total posts, ${recentPosts.length} within time window`);
            
            // Count mentions in titles and body text
            let subredditMentions = 0;
            
            recentPosts.forEach(post => {
              const title = (post.data.title || '').toUpperCase();
              const text = (post.data.selftext || '').toUpperCase();
              const combined = `${title} ${text}`;
              
              // Create regex pattern with word boundaries
              // Match $TICKER, TICKER, or ticker in various contexts
              const patterns = [
                new RegExp(`\\$${ticker}\\b`, 'g'),           // $NVDA
                new RegExp(`\\b${ticker}\\b`, 'g'),           // NVDA
                new RegExp(`\\b${ticker.toLowerCase()}\\b`, 'g') // nvda
              ];
              
              patterns.forEach(pattern => {
                const matches = combined.match(pattern);
                if (matches) {
                  subredditMentions += matches.length;
                }
              });
            });
            
            totalMentions += subredditMentions;
            console.log(`    ✅ ${subredditMentions} mentions found`);
            
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
            
          } catch (subredditError) {
            console.log(`    ❌ Error: ${subredditError.message}`);
          }
        }
        
        results[ticker] = {
          mentions: totalMentions,
          window: parseInt(windowMinutes),
          timestamp: new Date().toISOString(),
          source: 'reddit'
        };
        
        console.log(`\n📊 TOTAL for ${ticker}: ${totalMentions} mentions`);
        
      } catch (error) {
        console.error(`\n❌ Error fetching ${ticker}:`, error.message);
        results[ticker] = {
          mentions: 0,
          window: parseInt(windowMinutes),
          timestamp: new Date().toISOString(),
          source: 'error',
          error: error.message
        };
      }
    }
    
    return results;
  }

  // Simple hype calculation for Phase 1 - just to verify data flow
  calculateSimpleHype(mentions, volume, priceChangePercent) {
    let score = 0;
    
    // Mentions component (0-40)
    if (mentions > 0) {
      score += Math.min(Math.log10(mentions + 1) * 12, 40);
    }
    
    // Volume component (0-30)
    if (volume && volume > 0) {
      score += Math.min(Math.log10(volume / 1000000 + 1) * 20, 30);
    }
    
    // Price movement component (0-30)
    if (priceChangePercent !== undefined && priceChangePercent !== null) {
      score += Math.min(Math.abs(priceChangePercent) * 3, 30);
    }
    
    return Math.round(score);
  }
}

const hypeCalc = new HypeCalculator();

// CORS
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

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    phase: 'Phase 1 - API Testing',
    timestamp: new Date().toISOString(),
    cache_size: hypeCalc.cache.size
  });
});

// Test Reddit API directly
app.get('/api/test/reddit/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const window = parseInt(req.query.window) || 60;
    
    console.log(`\n🔍 TEST: Fetching Reddit data for ${ticker}`);
    
    const data = await hypeCalc.getRedditMentions([ticker], window);
    
    res.json({
      success: true,
      ticker,
      window,
      data: data[ticker],
      note: 'Check server logs for detailed breakdown'
    });
    
  } catch (error) {
    console.error('Test error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Mentions endpoint
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
    console.error('Mentions API error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
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

    console.log(`\n📈 Fetching quotes for: ${tickerList.join(', ')}`);

    const promises = tickerList.map(async (ticker) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        
        const quoteResponse = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubApiKey}`,
          { signal: controller.signal }
        );
        
        clearTimeout(timeout);
        
        if (!quoteResponse.ok) {
          throw new Error(`Finnhub HTTP ${quoteResponse.status}`);
        }
        
        const quoteData = await quoteResponse.json();

        if (quoteData.c && quoteData.pc) {
          const currentPrice = quoteData.c;
          const previousClose = quoteData.pc;
          const change = currentPrice - previousClose;
          const changePercent = (change / previousClose) * 100;

          console.log(`  ✅ ${ticker}: $${currentPrice} (${changePercent > 0 ? '+' : ''}${changePercent.toFixed(2)}%)`);

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
        console.error(`  ❌ ${ticker}: ${error.message}`);
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

// Combined hype endpoint
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

    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    
    console.log(`\n🎯 Calculating hype for: ${tickerList.join(', ')}`);
    
    // Fetch both mentions and quotes in parallel
    const [mentionsData, quotesData] = await Promise.all([
      hypeCalc.getRedditMentions(tickerList, window),
      (async () => {
        const quoteResponse = await fetch(
          `${req.protocol}://${req.get('host')}/api/quotes?tickers=${tickers}`
        );
        return quoteResponse.json();
      })()
    ]);

    const results = {};

    for (const ticker of tickerList) {
      const mentionData = mentionsData[ticker] || { mentions: 0 };
      const quoteData = quotesData[ticker] || {};

      const hypeScore = hypeCalc.calculateSimpleHype(
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

      console.log(`  ${ticker}: Hype=${hypeScore}, Mentions=${mentionData.mentions}, Price=${quoteData.currentPrice}`);
    }

    hypeCalc.setCache(cacheKey, results);
    res.json(results);
    
  } catch (error) {
    console.error('Hype API error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'HypeMeter.ai - Phase 1: API Testing',
    version: '3.0.0-phase1',
    status: 'running',
    endpoints: {
      health: '/health',
      test_reddit: '/api/test/reddit/NVDA?window=60',
      mentions: '/api/mentions?tickers=NVDA,AAPL&window=60',
      quotes: '/api/quotes?tickers=NVDA,AAPL',
      hype: '/api/hype?tickers=NVDA,AAPL&window=60'
    },
    notes: [
      'Phase 1: Testing and debugging APIs',
      'Check server logs for detailed output',
      'Use /api/test/reddit/TICKER to debug specific tickers'
    ]
  });
});

// Keep-alive for Render
app.get('/keepalive', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

if (process.env.NODE_ENV === 'production') {
  setInterval(async () => {
    try {
      const url = process.env.RENDER_EXTERNAL_URL || 'https://hypemeter.onrender.com';
      await fetch(`${url}/keepalive`);
      console.log('✅ Keep-alive ping sent');
    } catch (error) {
      console.error('❌ Keep-alive failed:', error.message);
    }
  }, 14 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 HypeMeter API Phase 1 - Running on port ${PORT}`);
  console.log(`📊 Phase: API Testing & Debugging`);
  console.log(`🔑 Finnhub API: ${process.env.FINNHUB_API_KEY ? '✅ Configured' : '❌ Missing'}`);
  console.log(`\n🧪 Test endpoint: /api/test/reddit/TSLA?window=60`);
  console.log(`📝 Check logs for detailed API responses\n`);
});
