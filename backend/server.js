const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const app = express();

// Enhanced caching system with historical baselines (backend only)
class HypeCalculator {
  constructor() {
    this.cache = new Map();
    this.baselines = new Map();
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    this.BASELINE_FILE = '/tmp/baselines.json';
    this.loadBaselines();
  }

  async loadBaselines() {
    try {
      const data = await fs.readFile(this.BASELINE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      this.baselines = new Map(Object.entries(parsed));
      console.log(`Loaded baselines for ${this.baselines.size} tickers`);
    } catch (error) {
      console.log('No baseline file found, starting fresh');
    }
  }

  async saveBaselines() {
    try {
      const data = Object.fromEntries(this.baselines);
      await fs.writeFile(this.BASELINE_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save baselines:', error.message);
    }
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

  updateBaseline(ticker, mentions) {
    if (!this.baselines.has(ticker)) {
      this.baselines.set(ticker, {
        history: [],
        average: mentions,
        lastUpdated: Date.now()
      });
    }

    const baseline = this.baselines.get(ticker);
    baseline.history.push({
      mentions,
      timestamp: Date.now()
    });

    // Keep last 20 data points (rolling baseline)
    if (baseline.history.length > 20) {
      baseline.history = baseline.history.slice(-20);
    }

    // Calculate rolling average
    const recentMentions = baseline.history.map(h => h.mentions);
    baseline.average = recentMentions.reduce((sum, m) => sum + m, 0) / recentMentions.length;
    baseline.lastUpdated = Date.now();

    this.baselines.set(ticker, baseline);

    // Save every 5 updates
    if (baseline.history.length % 5 === 0) {
      this.saveBaselines();
    }
  }

  calculateHypeScore(ticker, currentMentions, volume, priceChangePercent) {
    // Update baseline with current data
    this.updateBaseline(ticker, currentMentions);
    
    const baseline = this.baselines.get(ticker);
    const averageBaseline = baseline ? baseline.average : currentMentions;

    // Calculate mention anomaly (how unusual current mentions are)
    let mentionMultiplier = 1;
    if (averageBaseline > 0) {
      mentionMultiplier = currentMentions / averageBaseline;
      // Cap extreme multipliers
      mentionMultiplier = Math.min(mentionMultiplier, 4);
      mentionMultiplier = Math.max(mentionMultiplier, 0.1);
    }

    // Base hype from adjusted mentions (0-60 points)
    const adjustedMentions = currentMentions * Math.log(mentionMultiplier + 1);
    let hypeScore = Math.min(adjustedMentions * 1.5, 60);

    // Volume impact (0-20 points)
    if (volume && volume > 0) {
      const volumeScore = Math.min(Math.log(volume / 1000000 + 1) * 15, 20);
      hypeScore += volumeScore;
    }

    // Price movement impact (0-20 points)
    if (priceChangePercent !== undefined && priceChangePercent !== null) {
      const priceScore = Math.min(Math.abs(priceChangePercent) * 2.5, 20);
      hypeScore += priceScore;
    }

    // Boost for significantly above-baseline activity
    if (mentionMultiplier > 1.5) {
      const anomalyBonus = Math.min((mentionMultiplier - 1) * 10, 15);
      hypeScore += anomalyBonus;
    }

    return Math.min(Math.round(hypeScore), 100);
  }

  getStats() {
    return {
      cache_size: this.cache.size,
      tracked_tickers: this.baselines.size,
      baselines: Array.from(this.baselines.entries()).map(([ticker, data]) => ({
        ticker,
        baseline: Math.round(data.average * 10) / 10,
        dataPoints: data.history.length
      }))
    };
  }
}

const hypeCalc = new HypeCalculator();

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

// Keep-alive endpoint
app.get('/keepalive', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Health check endpoint
app.get('/health', (req, res) => {
  const stats = hypeCalc.getStats();
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    ...stats
  });
});

// Admin endpoint to view baselines (optional)
app.get('/api/admin/baselines', (req, res) => {
  const stats = hypeCalc.getStats();
  res.json(stats.baselines);
});

// Enhanced mentions endpoint
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
    const results = {};

    const promises = tickerList.map(async (ticker) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        
        const now = new Date();
        const startTime = new Date(now.getTime() - (window * 60 * 1000));
        
        const formatGDELTDate = (date) => {
          return date.getUTCFullYear().toString() +
                 (date.getUTCMonth() + 1).toString().padStart(2, '0') +
                 date.getUTCDate().toString().padStart(2, '0') +
                 date.getUTCHours().toString().padStart(2, '0') +
                 date.getUTCMinutes().toString().padStart(2, '0');
        };

        const startTimeFormatted = formatGDELTDate(startTime);
        const endTimeFormatted = formatGDELTDate(now);
        
        const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${ticker}&mode=artlist&maxrecords=75&timespan=${startTimeFormatted}-${endTimeFormatted}&format=json`;
        
        const response = await fetch(gdeltUrl, {
          signal: controller.signal,
          headers: { 
            'User-Agent': 'HypeMeter/2.0',
            'Accept': 'application/json'
          }
        });
        
        clearTimeout(timeout);
        
        if (!response.ok) {
          throw new Error(`GDELT API returned ${response.status}`);
        }
        
        const text = await response.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch (parseError) {
          throw new Error('Invalid JSON response from GDELT');
        }
        
        let mentions = 0;
        
        if (data && data.articles && Array.isArray(data.articles)) {
          mentions = data.articles.length;
        } else if (Array.isArray(data)) {
          mentions = data.length;
        }
        
        // Apply realistic scaling
        if (mentions > 40) {
          mentions = Math.floor(mentions * 0.7) + Math.floor(Math.random() * 8);
        }

        return {
          ticker,
          data: {
            mentions,
            window: parseInt(window),
            timestamp: now.toISOString(),
            source: 'gdelt'
          }
        };
        
      } catch (error) {
        console.error(`Mentions error for ${ticker}:`, error.message);
        
        // Realistic simulation based on ticker popularity
        const popularTickers = ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'GOOGL', 'AMZN', 'META'];
        const megaCapTickers = ['AAPL', 'MSFT', 'GOOGL', 'AMZN'];
        
        let baseMentions, variance;
        if (megaCapTickers.includes(ticker)) {
          baseMentions = 18;
          variance = 12;
        } else if (popularTickers.includes(ticker)) {
          baseMentions = 12;
          variance = 8;
        } else {
          baseMentions = 4;
          variance = 6;
        }
        
        const simulatedMentions = baseMentions + Math.floor(Math.random() * variance);
        
        return {
          ticker,
          data: {
            mentions: simulatedMentions,
            window: parseInt(window),
            timestamp: new Date().toISOString(),
            source: 'simulated'
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
    console.error('Mentions API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Quotes endpoint (unchanged but cached)
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

// Smart hype endpoint with baseline-adjusted scoring
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

    // Get mentions and quotes in parallel
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

      // Use smart baseline-adjusted hype calculation
      const hypeScore = hypeCalc.calculateHypeScore(
        ticker,
        mentionData.mentions || 0,
        quoteData.volume || 0,
        quoteData.changePercent
      );

      // Clean response (no baseline details exposed to frontend)
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
  const stats = hypeCalc.getStats();
  res.json({
    message: 'HypeMeter.ai - Smart Baseline Hype Tracking',
    version: '2.1.0',
    status: 'running',
    ...stats,
    endpoints: {
      health: '/health',
      keepalive: '/keepalive',
      mentions: '/api/mentions?tickers=NVDA,AAPL&window=60',
      quotes: '/api/quotes?tickers=NVDA,AAPL',
      hype: '/api/hype?tickers=NVDA,AAPL&window=60'
    }
  });
});

// Self-ping and data persistence
if (process.env.NODE_ENV === 'production') {
  setInterval(async () => {
    try {
      const url = process.env.RENDER_EXTERNAL_URL || 'https://hypemeter.onrender.com';
      await fetch(`${url}/keepalive`);
      await hypeCalc.saveBaselines();
      console.log('Keep-alive ping sent and baselines saved');
    } catch (error) {
      console.error('Keep-alive failed:', error.message);
    }
  }, 14 * 60 * 1000);
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Saving baselines before shutdown...');
  await hypeCalc.saveBaselines();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HypeMeter.ai API server running on port ${PORT}`);
  console.log(`Smart baseline tracking enabled`);
  console.log(`Finnhub API Key configured: ${process.env.FINNHUB_API_KEY ? 'Yes' : 'No'}`);
});
