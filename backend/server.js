const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const app = express();

// Persistent storage manager
class PersistentStorage {
  constructor() {
    this.dataPath = process.env.DATA_PATH || '/tmp';
    this.historyFile = path.join(this.dataPath, 'mention_history.json');
    this.priceFile = path.join(this.dataPath, 'price_history.json');
    this.baselineFile = path.join(this.dataPath, 'baselines.json');
  }

  async ensureDataDir() {
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
    } catch (e) {}
  }

  async saveMentionHistory(data) {
    await this.ensureDataDir();
    await fs.writeFile(this.historyFile, JSON.stringify(data, null, 2));
  }

  async loadMentionHistory() {
    try {
      const data = await fs.readFile(this.historyFile, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      return {};
    }
  }

  async savePriceHistory(data) {
    await this.ensureDataDir();
    await fs.writeFile(this.priceFile, JSON.stringify(data, null, 2));
  }

  async loadPriceHistory() {
    try {
      const data = await fs.readFile(this.priceFile, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      return {};
    }
  }

  async saveBaselines(data) {
    await this.ensureDataDir();
    await fs.writeFile(this.baselineFile, JSON.stringify(data, null, 2));
  }

  async loadBaselines() {
    try {
      const data = await fs.readFile(this.baselineFile, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      return {};
    }
  }
}

// Dynamic weight calculator - NO FIXED WEIGHTS
class DynamicHypeCalculator {
  constructor() {
    this.storage = new PersistentStorage();
    this.cache = new Map();
    this.mentionHistory = new Map(); // ticker -> array of {timestamp, mentions, source}
    this.priceHistory = new Map(); // ticker -> array of {timestamp, price, volume}
    this.baselines = new Map(); // ticker -> {mentionBaseline, volumeBaseline, volatilityBaseline}
    this.CACHE_TTL = 5 * 60 * 1000;
    this.init();
  }

  async init() {
    // Load persistent data
    const [mentionData, priceData, baselineData] = await Promise.all([
      this.storage.loadMentionHistory(),
      this.storage.loadPriceHistory(),
      this.storage.loadBaselines()
    ]);

    // Restore to Maps
    for (const [ticker, history] of Object.entries(mentionData)) {
      this.mentionHistory.set(ticker, history);
    }
    for (const [ticker, history] of Object.entries(priceData)) {
      this.priceHistory.set(ticker, history);
    }
    for (const [ticker, baseline] of Object.entries(baselineData)) {
      this.baselines.set(ticker, baseline);
    }

    console.log(`Loaded ${this.mentionHistory.size} tickers from persistent storage`);

    // Auto-save every 5 minutes
    setInterval(() => this.persistData(), 5 * 60 * 1000);
  }

  async persistData() {
    const mentionData = Object.fromEntries(this.mentionHistory);
    const priceData = Object.fromEntries(this.priceHistory);
    const baselineData = Object.fromEntries(this.baselines);

    await Promise.all([
      this.storage.saveMentionHistory(mentionData),
      this.storage.savePriceHistory(priceData),
      this.storage.saveBaselines(baselineData)
    ]);

    console.log(`Persisted data for ${this.mentionHistory.size} tickers`);
  }

  // Store mention with timestamp
  recordMention(ticker, mentions, source = 'combined') {
    if (!this.mentionHistory.has(ticker)) {
      this.mentionHistory.set(ticker, []);
    }
    
    const history = this.mentionHistory.get(ticker);
    history.push({
      timestamp: Date.now(),
      mentions,
      source
    });

    // Keep only last 30 days
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    this.mentionHistory.set(
      ticker,
      history.filter(h => h.timestamp > thirtyDaysAgo)
    );
  }

  // Store price snapshot
  recordPrice(ticker, price, volume) {
    if (!this.priceHistory.has(ticker)) {
      this.priceHistory.set(ticker, []);
    }

    const history = this.priceHistory.get(ticker);
    history.push({
      timestamp: Date.now(),
      price,
      volume
    });

    // Keep only last 30 days
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    this.priceHistory.set(
      ticker,
      history.filter(h => h.timestamp > thirtyDaysAgo)
    );
  }

  // Calculate dynamic baseline for mentions
  calculateMentionBaseline(ticker, windowMinutes) {
    const history = this.mentionHistory.get(ticker);
    if (!history || history.length < 10) return null;

    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    
    // Get mentions from same time period in previous days
    const baselines = [];
    for (let daysAgo = 1; daysAgo <= 7; daysAgo++) {
      const startTime = now - (daysAgo * 24 * 60 * 60 * 1000) - windowMs;
      const endTime = now - (daysAgo * 24 * 60 * 60 * 1000);
      
      const periodMentions = history
        .filter(h => h.timestamp >= startTime && h.timestamp < endTime)
        .reduce((sum, h) => sum + h.mentions, 0);
      
      if (periodMentions > 0) baselines.push(periodMentions);
    }

    if (baselines.length === 0) return null;

    // Return median baseline
    baselines.sort((a, b) => a - b);
    const mid = Math.floor(baselines.length / 2);
    return baselines.length % 2 === 0
      ? (baselines[mid - 1] + baselines[mid]) / 2
      : baselines[mid];
  }

  // Calculate dynamic baseline for volume
  calculateVolumeBaseline(ticker) {
    const history = this.priceHistory.get(ticker);
    if (!history || history.length < 20) return null;

    // Get last 20 days of volume
    const twentyDaysAgo = Date.now() - (20 * 24 * 60 * 60 * 1000);
    const recentVolumes = history
      .filter(h => h.timestamp > twentyDaysAgo && h.volume > 0)
      .map(h => h.volume);

    if (recentVolumes.length < 10) return null;

    // Return average volume
    return recentVolumes.reduce((sum, v) => sum + v, 0) / recentVolumes.length;
  }

  // Calculate dynamic baseline for volatility
  calculateVolatilityBaseline(ticker) {
    const history = this.priceHistory.get(ticker);
    if (!history || history.length < 100) return null;

    // Calculate 5-minute percentage changes
    const volatilities = [];
    for (let i = 1; i < history.length; i++) {
      const prevPrice = history[i - 1].price;
      const currPrice = history[i].price;
      if (prevPrice > 0 && currPrice > 0) {
        const changePercent = Math.abs((currPrice - prevPrice) / prevPrice) * 100;
        volatilities.push(changePercent);
      }
    }

    if (volatilities.length < 10) return null;

    // Return average absolute change
    return volatilities.reduce((sum, v) => sum + v, 0) / volatilities.length;
  }

  // Get price change for specific timeframe
  getPriceChange(ticker, windowMinutes) {
    const history = this.priceHistory.get(ticker);
    if (!history || history.length < 2) return null;

    const now = Date.now();
    const targetTime = now - (windowMinutes * 60 * 1000);

    // Find closest snapshot to target time
    let oldSnapshot = history[0];
    let minDiff = Math.abs(history[0].timestamp - targetTime);

    for (const snapshot of history) {
      const diff = Math.abs(snapshot.timestamp - targetTime);
      if (diff < minDiff && snapshot.timestamp <= targetTime) {
        minDiff = diff;
        oldSnapshot = snapshot;
      }
    }

    const currentSnapshot = history[history.length - 1];
    
    if (oldSnapshot.price > 0 && currentSnapshot.price > 0) {
      const change = currentSnapshot.price - oldSnapshot.price;
      const changePercent = (change / oldSnapshot.price) * 100;
      return {
        change,
        changePercent,
        currentPrice: currentSnapshot.price,
        currentVolume: currentSnapshot.volume
      };
    }

    return null;
  }

  // DYNAMIC HYPE CALCULATION - NO FIXED WEIGHTS
  calculateDynamicHype(ticker, currentMentions, windowMinutes) {
    // Get baselines
    const mentionBaseline = this.calculateMentionBaseline(ticker, windowMinutes) || currentMentions;
    const volumeBaseline = this.calculateVolumeBaseline(ticker);
    const volatilityBaseline = this.calculateVolatilityBaseline(ticker);

    // Get current metrics
    const priceChange = this.getPriceChange(ticker, windowMinutes);
    const currentVolume = priceChange?.currentVolume || 0;
    const currentVolatility = priceChange ? Math.abs(priceChange.changePercent) : 0;

    // Calculate normalized metrics (0-1 scale based on baseline comparison)
    const mentionRatio = mentionBaseline > 0 ? currentMentions / mentionBaseline : 1;
    const volumeRatio = volumeBaseline && volumeBaseline > 0 ? currentVolume / volumeBaseline : 1;
    const volatilityRatio = volatilityBaseline && volatilityBaseline > 0
      ? currentVolatility / volatilityBaseline
      : 1;

    // Apply logarithmic scaling (natural growth curves, not linear)
    const mentionScore = Math.log10(mentionRatio + 1) * 100;
    const volumeScore = Math.log10(volumeRatio + 1) * 100;
    const volatilityScore = Math.log10(volatilityRatio + 1) * 100;

    // Dynamic weight calculation based on data quality
    const mentionWeight = this.mentionHistory.get(ticker)?.length || 1;
    const volumeWeight = this.priceHistory.get(ticker)?.length || 1;
    const volatilityWeight = volatilityBaseline ? 1 : 0.5;

    // Normalize weights to sum to 1
    const totalWeight = mentionWeight + volumeWeight + volatilityWeight;
    const normMentionWeight = mentionWeight / totalWeight;
    const normVolumeWeight = volumeWeight / totalWeight;
    const normVolatilityWeight = volatilityWeight / totalWeight;

    // Calculate weighted score
    let hypeScore = 
      (mentionScore * normMentionWeight) +
      (volumeScore * normVolumeWeight) +
      (volatilityScore * normVolatilityWeight);

    // Synergy bonus: when multiple metrics spike together
    if (mentionRatio > 1.5 && volumeRatio > 1.5) {
      hypeScore *= 1.3; // 30% boost for cross-metric confirmation
    }
    if (mentionRatio > 2 && volatilityRatio > 1.5) {
      hypeScore *= 1.2; // 20% boost for high attention + high movement
    }

    // Cap at 100
    return Math.min(Math.round(hypeScore), 100);
  }

  // Reddit mentions collector
  async getRedditMentions(tickerList, window) {
    const results = {};
    const subreddits = ['wallstreetbets', 'stocks', 'investing', 'stockmarket'];
    
    for (const ticker of tickerList) {
      try {
        let totalMentions = 0;
        const timeFilter = Math.floor((Date.now() - (window * 60 * 1000)) / 1000);
        
        for (const subreddit of subreddits) {
          try {
            const redditUrl = `https://www.reddit.com/r/${subreddit}/search.json?q=${ticker}&restrict_sr=1&sort=new&limit=100&t=hour`;
            
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            
            const response = await fetch(redditUrl, {
              signal: controller.signal,
              headers: {
                'User-Agent': 'HypeMeter:v5.0 (by /u/stocktracker)'
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
                
                const tickerPattern = new RegExp(`\\b${ticker}\\b`, 'g');
                
                const titleMatches = (title.match(tickerPattern) || []).length;
                const textMatches = (text.match(tickerPattern) || []).length;
                subredditMentions += titleMatches + textMatches;
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

  // StockTwits mentions collector
  async getStockTwitsMentions(tickerList) {
    const results = {};
    
    for (const ticker of tickerList) {
      try {
        const response = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`);
        
        if (!response.ok) {
          results[ticker] = { mentions: 0, source: 'stocktwits_failed' };
          continue;
        }
        
        const data = await response.json();
        let mentions = 0;
        
        if (data.messages) {
          const oneHourAgo = Date.now() - (60 * 60 * 1000);
          mentions = data.messages.filter(m => {
            const msgTime = new Date(m.created_at).getTime();
            return msgTime > oneHourAgo;
          }).length;
        }
        
        results[ticker] = {
          mentions,
          source: 'stocktwits',
          timestamp: new Date().toISOString()
        };
        
      } catch (error) {
        results[ticker] = { mentions: 0, source: 'stocktwits_failed' };
      }
    }
    
    return results;
  }

  // Combined mentions with proper weighting
  async getCombinedMentions(tickerList, window) {
    const [redditData, stocktwitsData] = await Promise.all([
      this.getRedditMentions(tickerList, window),
      this.getStockTwitsMentions(tickerList)
    ]);
    
    const results = {};
    
    for (const ticker of tickerList) {
      const reddit = redditData[ticker] || { mentions: 0 };
      const stocktwits = stocktwitsData[ticker] || { mentions: 0 };
      
      // Dynamic weighting based on data availability
      const redditWeight = reddit.mentions > 0 ? 0.7 : 0;
      const stocktwitsWeight = stocktwits.mentions > 0 ? 0.3 : 0;
      const totalWeight = redditWeight + stocktwitsWeight || 1;
      
      const combinedMentions = Math.round(
        (reddit.mentions * (redditWeight / totalWeight)) +
        (stocktwits.mentions * (stocktwitsWeight / totalWeight))
      );
      
      results[ticker] = {
        mentions: combinedMentions,
        reddit_mentions: reddit.mentions,
        stocktwits_mentions: stocktwits.mentions,
        window: parseInt(window),
        timestamp: new Date().toISOString()
      };
      
      // Record for baseline calculation
      this.recordMention(ticker, combinedMentions, 'combined');
    }
    
    return results;
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
}

const hypeCalc = new DynamicHypeCalculator();

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

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    version: '5.0.0-dynamic',
    timestamp: new Date().toISOString(),
    tracked_tickers: hypeCalc.mentionHistory.size,
    data_points: Array.from(hypeCalc.mentionHistory.values())
      .reduce((sum, h) => sum + h.length, 0)
  });
});

// Combined mentions endpoint
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
    const results = await hypeCalc.getCombinedMentions(tickerList, window);

    hypeCalc.setCache(cacheKey, results);
    res.json(results);
    
  } catch (error) {
    console.error('Mentions API error:', error);
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

          // Record price for baseline calculation
          hypeCalc.recordPrice(ticker, currentPrice, quoteData.v || 0);

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

// Dynamic hype endpoint
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

      // Calculate dynamic hype score
      const hypeScore = hypeCalc.calculateDynamicHype(
        ticker,
        mentionData.mentions || 0,
        parseInt(window)
      );

      const priceChange = hypeCalc.getPriceChange(ticker, parseInt(window));

      results[ticker] = {
        symbol: ticker,
        hypeScore: hypeScore,
        mentions: mentionData.mentions || 0,
        reddit_mentions: mentionData.reddit_mentions || 0,
        stocktwits_mentions: mentionData.stocktwits_mentions || 0,
        price: priceChange?.currentPrice || quoteData.currentPrice || null,
        change: priceChange?.change || quoteData.change || null,
        changePercent: priceChange?.changePercent || quoteData.changePercent || null,
        volume: priceChange?.currentVolume || quoteData.volume || null,
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
    message: 'HypeMeter.ai v5.0 - Dynamic Weights & Persistent Storage',
    version: '5.0.0',
    status: 'running',
    features: [
      'Dynamic weight calculation (no fixed weights)',
      'Persistent 30-day storage',
      'Time-accurate price changes',
      'Baseline-relative scoring',
      'Cross-metric synergy detection'
    ],
    endpoints: {
      health: '/health',
      mentions: '/api/mentions?tickers=NVDA,AAPL&window=60',
      quotes: '/api/quotes?tickers=NVDA,AAPL',
      hype: '/api/hype?tickers=NVDA,AAPL&window=60'
    }
  });
});

// Keep-alive
app.get('/keepalive', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Auto-persist and keep-alive
if (process.env.NODE_ENV === 'production') {
  setInterval(async () => {
    try {
      const url = process.env.RENDER_EXTERNAL_URL || 'https://hypemeter.onrender.com';
      await fetch(`${url}/keepalive`);
      await hypeCalc.persistData();
      console.log('Keep-alive ping sent and data persisted');
    } catch (error) {
      console.error('Keep-alive failed:', error.message);
    }
  }, 14 * 60 * 1000);
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Saving data before shutdown...');
  await hypeCalc.persistData();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HypeMeter.ai v5.0 - Dynamic Weights API running on port ${PORT}`);
  console.log(`Features:`);
  console.log(`  ✓ No fixed weights - all dynamic`);
  console.log(`  ✓ 30-day persistent storage`);
  console.log(`  ✓ Time-accurate price changes`);
  console.log(`  ✓ Baseline-relative scoring`);
  console.log(`  ✓ Data path: ${process.env.DATA_PATH || '/tmp'}`);
  console.log(`Finnhub API: ${process.env.FINNHUB_API_KEY ? '✓' : '✗'}`);
});
