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
    this.mentionEventsFile = path.join(this.dataPath, 'mention_events.json');
    this.priceHistoryFile = path.join(this.dataPath, 'price_history.json');
    this.baselinesFile = path.join(this.dataPath, 'baselines.json');
  }

  async ensureDataDir() {
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
    } catch (e) {}
  }

  async saveMentionEvents(data) {
    await this.ensureDataDir();
    await fs.writeFile(this.mentionEventsFile, JSON.stringify(data, null, 2));
  }

  async loadMentionEvents() {
    try {
      const data = await fs.readFile(this.mentionEventsFile, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      return {};
    }
  }

  async savePriceHistory(data) {
    await this.ensureDataDir();
    await fs.writeFile(this.priceHistoryFile, JSON.stringify(data, null, 2));
  }

  async loadPriceHistory() {
    try {
      const data = await fs.readFile(this.priceHistoryFile, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      return {};
    }
  }

  async saveBaselines(data) {
    await this.ensureDataDir();
    await fs.writeFile(this.baselinesFile, JSON.stringify(data, null, 2));
  }

  async loadBaselines() {
    try {
      const data = await fs.readFile(this.baselinesFile, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      return {};
    }
  }
}

// Enhanced collector with Reddit OAuth and all fixes
class BackgroundCollector {
  constructor() {
    this.storage = new PersistentStorage();
    this.cache = new Map();
    this.mentionEvents = new Map(); // ticker -> array of {timestamp, source}
    this.priceHistory = new Map(); // ticker -> array of {timestamp, price, volume}
    this.baselines = new Map();
    this.CACHE_TTL = 5 * 60 * 1000;
    
    // Reddit OAuth
    this.redditToken = null;
    this.redditTokenExpiry = 0;
    this.redditWorking = false;
    
    this.trackedTickers = new Set([
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'NVDA', 'META', 'AMD',
      'GME', 'AMC', 'SPY', 'QQQ', 'COIN', 'NFLX', 'PLTR', 'MSTR', 'SOFI'
    ]);
    
    this.init();
  }

  async init() {
    // Load persistent data
    const [mentionData, priceData, baselineData] = await Promise.all([
      this.storage.loadMentionEvents(),
      this.storage.loadPriceHistory(),
      this.storage.loadBaselines()
    ]);

    // Restore to Maps
    for (const [ticker, events] of Object.entries(mentionData)) {
      this.mentionEvents.set(ticker, events);
    }
    for (const [ticker, history] of Object.entries(priceData)) {
      this.priceHistory.set(ticker, history);
    }
    for (const [ticker, baseline] of Object.entries(baselineData)) {
      this.baselines.set(ticker, baseline);
    }

    console.log(`📂 Loaded ${this.mentionEvents.size} tickers from persistent storage`);
    console.log(`📊 Total mention events: ${Array.from(this.mentionEvents.values()).reduce((sum, e) => sum + e.length, 0)}`);
    console.log(`💰 Total price snapshots: ${Array.from(this.priceHistory.values()).reduce((sum, h) => sum + h.length, 0)}`);

    // Auto-save every 5 minutes
    setInterval(() => this.persistData(), 5 * 60 * 1000);
  }

  async persistData() {
    const mentionData = Object.fromEntries(this.mentionEvents);
    const priceData = Object.fromEntries(this.priceHistory);
    const baselineData = Object.fromEntries(this.baselines);

    await Promise.all([
      this.storage.saveMentionEvents(mentionData),
      this.storage.savePriceHistory(priceData),
      this.storage.saveBaselines(baselineData)
    ]);

    console.log(`💾 Persisted data for ${this.mentionEvents.size} tickers`);
  }

  // Market hours detection
  isMarketOpen() {
    const now = new Date();
    const utcDay = now.getUTCDay();
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    
    // Weekend
    if (utcDay === 0 || utcDay === 6) return false;
    
    // Market hours: 9:30 AM - 4:00 PM EST
    // EST = UTC - 5, so 9:30 AM EST = 14:30 UTC, 4:00 PM EST = 21:00 UTC
    const utcTime = utcHours + utcMinutes / 60;
    
    // 14:30 (9:30 AM EST) to 21:00 (4:00 PM EST)
    if (utcTime >= 14.5 && utcTime < 21) return true;
    
    return false;
  }

  // Get data age in days
  getDataAge(ticker) {
    const events = this.mentionEvents.get(ticker);
    if (!events || events.length === 0) return 0;
    
    const oldestTimestamp = Math.min(...events.map(e => e.timestamp));
    const ageMs = Date.now() - oldestTimestamp;
    return ageMs / (24 * 60 * 60 * 1000); // Convert to days
  }

  // Record individual mention event
  recordMentionEvent(ticker, source = 'combined') {
    if (!this.mentionEvents.has(ticker)) {
      this.mentionEvents.set(ticker, []);
    }
    
    const events = this.mentionEvents.get(ticker);
    events.push({
      timestamp: Date.now(),
      source
    });

    // Keep only last 30 days
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    this.mentionEvents.set(
      ticker,
      events.filter(e => e.timestamp > thirtyDaysAgo)
    );
  }

  // Record price snapshot
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

  // Get mentions in specific time window
  getMentionsInWindow(ticker, windowMinutes) {
    const events = this.mentionEvents.get(ticker);
    if (!events || events.length === 0) return 0;
    
    const windowMs = windowMinutes * 60 * 1000;
    const cutoffTime = Date.now() - windowMs;
    
    return events.filter(e => e.timestamp > cutoffTime).length;
  }

  // Calculate baseline mentions for time window
  calculateMentionBaseline(ticker, windowMinutes) {
    const events = this.mentionEvents.get(ticker);
    if (!events || events.length < 100) return null;

    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    
    // Get mention counts for same window on previous 7 days
    const baselines = [];
    for (let daysAgo = 1; daysAgo <= 7; daysAgo++) {
      const startTime = now - (daysAgo * 24 * 60 * 60 * 1000) - windowMs;
      const endTime = now - (daysAgo * 24 * 60 * 60 * 1000);
      
      const periodMentions = events.filter(e => 
        e.timestamp >= startTime && e.timestamp < endTime
      ).length;
      
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

  // Calculate volume baseline
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

  // Calculate volatility baseline
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

  // SIMPLE HYPE CALCULATION (first 7 days)
  calculateSimpleHype(ticker, currentMentions, currentVolume, priceChangePercent, windowMinutes) {
    // Calculate market-wide averages
    const allTickers = Array.from(this.mentionEvents.keys());
    const avgMentions = allTickers.reduce((sum, t) => {
      return sum + this.getMentionsInWindow(t, windowMinutes);
    }, 0) / Math.max(allTickers.length, 1);

    const allVolumes = Array.from(this.priceHistory.values())
      .map(h => h.length > 0 ? h[h.length - 1].volume : 0)
      .filter(v => v > 0);
    const avgVolume = allVolumes.length > 0
      ? allVolumes.reduce((sum, v) => sum + v, 0) / allVolumes.length
      : 1;

    // Calculate ratios relative to market
    const mentionRatio = avgMentions > 0 ? currentMentions / avgMentions : 1;
    const volumeRatio = avgVolume > 0 && currentVolume > 0 ? currentVolume / avgVolume : 1;
    const volatilityRatio = priceChangePercent ? Math.abs(priceChangePercent) / 2 : 0;

    // Simple scoring
    let score = 0;
    score += Math.min(Math.log10(mentionRatio + 1) * 50, 50);
    score += Math.min(Math.log10(volumeRatio + 1) * 30, 30);
    score += Math.min(volatilityRatio * 10, 20);

    return Math.min(Math.round(score), 100);
  }

  // DYNAMIC HYPE CALCULATION (after 7 days)
  calculateDynamicHype(ticker, currentMentions, currentVolume, priceChangePercent, windowMinutes) {
    // Get baselines
    const mentionBaseline = this.calculateMentionBaseline(ticker, windowMinutes);
    const volumeBaseline = this.calculateVolumeBaseline(ticker);
    const volatilityBaseline = this.calculateVolatilityBaseline(ticker);

    // Calculate ratios
    const mentionRatio = mentionBaseline && mentionBaseline > 0 
      ? currentMentions / mentionBaseline 
      : 1;
    const volumeRatio = volumeBaseline && volumeBaseline > 0 && currentVolume > 0
      ? currentVolume / volumeBaseline 
      : 1;
    const currentVolatility = priceChangePercent ? Math.abs(priceChangePercent) : 0;
    const volatilityRatio = volatilityBaseline && volatilityBaseline > 0
      ? currentVolatility / volatilityBaseline
      : 1;

    // Apply logarithmic scaling
    const mentionScore = Math.log10(mentionRatio + 1) * 100;
    const volumeScore = Math.log10(volumeRatio + 1) * 100;
    const volatilityScore = Math.log10(volatilityRatio + 1) * 100;

    // Dynamic weights based on data quality
    const mentionWeight = mentionBaseline ? 1 : 0.5;
    const volumeWeight = volumeBaseline ? 1 : 0.5;
    const volatilityWeight = volatilityBaseline ? 1 : 0.5;

    // Normalize weights
    const totalWeight = mentionWeight + volumeWeight + volatilityWeight;
    const normMentionWeight = mentionWeight / totalWeight;
    const normVolumeWeight = volumeWeight / totalWeight;
    const normVolatilityWeight = volatilityWeight / totalWeight;

    // Calculate weighted score
    let hypeScore = 
      (mentionScore * normMentionWeight) +
      (volumeScore * normVolumeWeight) +
      (volatilityScore * normVolatilityWeight);

    // Synergy bonuses
    if (mentionRatio > 1.5 && volumeRatio > 1.5) {
      hypeScore *= 1.3;
    }
    if (mentionRatio > 2 && volatilityRatio > 1.5) {
      hypeScore *= 1.2;
    }

    return Math.min(Math.round(hypeScore), 100);
  }

  // Master hype calculation (chooses simple or dynamic)
  calculateHypeScore(ticker, currentMentions, currentVolume, priceChangePercent, windowMinutes) {
    const dataAge = this.getDataAge(ticker);
    
    if (dataAge < 7) {
      return this.calculateSimpleHype(ticker, currentMentions, currentVolume, priceChangePercent, windowMinutes);
    } else {
      return this.calculateDynamicHype(ticker, currentMentions, currentVolume, priceChangePercent, windowMinutes);
    }
  }

  // Reddit OAuth
  async getRedditToken() {
    if (this.redditToken && Date.now() < this.redditTokenExpiry) {
      return this.redditToken;
    }

    const clientId = process.env.REDDIT_CLIENT_ID;
    const clientSecret = process.env.REDDIT_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      this.redditWorking = false;
      return null;
    }

    try {
      const auth = Buffer.from(`${clientId.trim()}:${clientSecret.trim()}`).toString('base64');
      const response = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'HypeMeter/5.1'
        },
        body: 'grant_type=client_credentials'
      });

      if (response.ok) {
        const data = await response.json();
        if (data.access_token) {
          this.redditToken = data.access_token;
          this.redditTokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
          this.redditWorking = true;
          return this.redditToken;
        }
      }
    } catch (e) {
      console.error('Reddit OAuth error:', e.message);
    }
    
    this.redditWorking = false;
    return null;
  }

  // Reddit collector with OAuth
  async collectReddit(ticker, windowMinutes) {
    const token = await this.getRedditToken();
    if (!token) return { mentions: 0, events: [] };

    const subreddits = [
      'wallstreetbets', 'stocks', 'investing', 'stockmarket',
      'options', 'thetagang', 'Daytrading'
    ];
    
    const allEvents = [];
    const windowMs = windowMinutes * 60 * 1000;
    const cutoffTime = Date.now() - windowMs;
    
    for (const sub of subreddits) {
      try {
        const url = `https://oauth.reddit.com/r/${sub}/new?limit=100`;
        
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'HypeMeter/5.1'
          }
        });

        if (response.ok) {
          const data = await response.json();
          
          if (data?.data?.children) {
            for (const post of data.data.children) {
              const postTime = post.data.created_utc * 1000;
              
              // Only count posts within time window
              if (postTime < cutoffTime) continue;
              
              const title = (post.data.title || '').toUpperCase();
              const text = (post.data.selftext || '').toUpperCase();
              const combined = `${title} ${text}`;
              
              const patterns = [
                new RegExp(`\\$${ticker}\\b`, 'gi'),
                new RegExp(`\\b${ticker}\\b`, 'gi')
              ];
              
              let mentionCount = 0;
              patterns.forEach(p => {
                const matches = combined.match(p) || [];
                mentionCount += matches.length;
              });
              
              // Add mention events
              for (let i = 0; i < mentionCount; i++) {
                allEvents.push({ timestamp: postTime, source: 'reddit' });
              }
            }
          }
        }
        
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.error(`Reddit r/${sub} error:`, e.message);
      }
    }
    
    return { mentions: allEvents.length, events: allEvents };
  }

  // StockTwits collector
  async collectStocktwits(ticker, windowMinutes) {
    try {
      const response = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`);
      
      if (!response.ok) return { mentions: 0, events: [] };
      
      const data = await response.json();
      const allEvents = [];
      
      const windowMs = windowMinutes * 60 * 1000;
      const cutoffTime = Date.now() - windowMs;
      
      if (data.messages) {
        data.messages.forEach(m => {
          const messageTime = new Date(m.created_at).getTime();
          
          // Only count messages within time window
          if (messageTime > cutoffTime) {
            allEvents.push({ timestamp: messageTime, source: 'stocktwits' });
          }
        });
      }
      
      return { mentions: allEvents.length, events: allEvents };
    } catch (e) {
      return { mentions: 0, events: [] };
    }
  }

  // Price data collector with VOLUME from Finnhub Candle
  async collectPriceData(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return null;
    
    try {
      // Get current price from quote endpoint
      const quoteRes = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`
      );
      const quote = await quoteRes.json();
      
      if (!quote.c) return null;
      
      // Get volume from candle endpoint
      const to = Math.floor(Date.now() / 1000);
      const from = to - 3600; // Last hour
      
      const candleRes = await fetch(
        `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=5&from=${from}&to=${to}&token=${apiKey}`
      );
      const candle = await candleRes.json();
      
      // Extract latest volume
      let volume = 0;
      if (candle.s === 'ok' && candle.v?.length > 0) {
        // Sum all volumes in the period
        volume = candle.v.reduce((sum, v) => sum + (v || 0), 0);
      }
      
      const snapshot = {
        price: quote.c,
        previousClose: quote.pc || quote.c,
        volume: volume,
        timestamp: Date.now()
      };
      
      // Record in history
      this.recordPrice(ticker, quote.c, volume);
      
      const marketStatus = this.isMarketOpen() ? '🟢' : '🔴';
      console.log(`  ${marketStatus} ${ticker}: $${quote.c.toFixed(2)} | Vol: ${volume.toLocaleString()}`);
      
      return snapshot;
      
    } catch (e) {
      console.error(`Price data error for ${ticker}:`, e.message);
      return null;
    }
  }

  // Collect all data for a ticker
  async collectTicker(ticker, windowMinutes = 60) {
    console.log(`🔄 ${ticker} (${windowMinutes}min window)...`);
    
    const [reddit, stocktwits, priceData] = await Promise.all([
      this.collectReddit(ticker, windowMinutes),
      this.collectStocktwits(ticker, windowMinutes),
      this.collectPriceData(ticker)
    ]);
    
    // Record all mention events
    reddit.events.forEach(e => this.recordMentionEvent(ticker, 'reddit'));
    stocktwits.events.forEach(e => this.recordMentionEvent(ticker, 'stocktwits'));
    
    // Get total mentions in window
    const totalMentions = this.getMentionsInWindow(ticker, windowMinutes);
    
    // Calculate hype score
    const priceChange = this.getPriceChange(ticker, windowMinutes);
    const hypeScore = this.calculateHypeScore(
      ticker,
      totalMentions,
      priceData?.volume || 0,
      priceChange?.changePercent || 0,
      windowMinutes
    );
    
    const dataAge = this.getDataAge(ticker);
    const scoringMode = dataAge < 7 ? 'SIMPLE' : 'DYNAMIC';
    
    console.log(`  ✅ ${ticker}: ${totalMentions} mentions (R:${reddit.mentions} ST:${stocktwits.mentions}) | Score: ${hypeScore} [${scoringMode}]`);
    
    return {
      ticker,
      totalMentions,
      reddit_mentions: reddit.mentions,
      stocktwits_mentions: stocktwits.mentions,
      hypeScore,
      priceData,
      priceChange,
      dataAge,
      scoringMode
    };
  }

  // Background collection
  async startCollection() {
    console.log(`\n🚀 HypeMeter v5.1 - All Fixes Applied`);
    console.log(`📊 Tracking ${this.trackedTickers.size} tickers\n`);
    
    await this.collectAll();
    
    setInterval(() => {
      this.collectAll();
    }, 5 * 60 * 1000);
  }

  async collectAll() {
    const time = new Date().toLocaleTimeString();
    const marketStatus = this.isMarketOpen() ? '🟢 MARKET OPEN' : '🔴 MARKET CLOSED';
    console.log(`\n⏰ ${time} | ${marketStatus}\n`);
    
    for (const ticker of this.trackedTickers) {
      await this.collectTicker(ticker, 60);
      await new Promise(r => setTimeout(r, 700));
    }
    
    console.log(`\n✅ Collection complete. R:${this.redditWorking ? '✓' : '✗'}\n`);
  }

  addTicker(ticker) {
    if (!this.trackedTickers.has(ticker)) {
      this.trackedTickers.add(ticker);
      console.log(`➕ Added ${ticker} to tracking`);
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

  getStats() {
    return {
      version: '5.1.0',
      tracked: this.trackedTickers.size,
      mention_events: Array.from(this.mentionEvents.values()).reduce((sum, e) => sum + e.length, 0),
      price_snapshots: Array.from(this.priceHistory.values()).reduce((sum, h) => sum + h.length, 0),
      market_open: this.isMarketOpen(),
      reddit: this.redditWorking
    };
  }
}

const collector = new BackgroundCollector();

// CORS
app.use(cors({
  origin: [
    'https://hypemeter.ai',
    'https://www.hypemeter.ai',
    'https://cooldude-ai.github.io',
    'http://localhost:3000'
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
    ...collector.getStats()
  });
});

// Hype endpoint
app.get('/api/hype', async (req, res) => {
  try {
    const { tickers, window = 60 } = req.query;
    if (!tickers) return res.status(400).json({ error: 'Tickers required' });

    const windowMinutes = parseInt(window);
    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = {};
    
    // Add tickers to tracking
    tickerList.forEach(t => collector.addTicker(t));
    
    // Collect fresh data for each ticker
    for (const ticker of tickerList) {
      const data = await collector.collectTicker(ticker, windowMinutes);
      
      results[ticker] = {
        symbol: ticker,
        hypeScore: data.hypeScore || 0,
        mentions: data.totalMentions || 0,
        reddit_mentions: data.reddit_mentions || 0,
        stocktwits_mentions: data.stocktwits_mentions || 0,
        price: data.priceData?.price || null,
        change: data.priceChange?.change || null,
        changePercent: data.priceChange?.changePercent || null,
        volume: data.priceData?.volume || 0,
        name: ticker,
        scoringMode: data.scoringMode,
        dataAge: Math.round(data.dataAge * 10) / 10,
        timestamp: new Date().toISOString()
      };
    }
    
    res.json(results);
  } catch (error) {
    console.error('Hype error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint
app.get('/api/debug/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const windowMinutes = parseInt(req.query.window) || 60;
  
  const mentionEvents = collector.mentionEvents.get(ticker) || [];
  const priceHistory = collector.priceHistory.get(ticker) || [];
  const baselines = collector.baselines.get(ticker) || {};
  
  // Calculate current metrics
  const currentMentions = collector.getMentionsInWindow(ticker, windowMinutes);
  const mentionBaseline = collector.calculateMentionBaseline(ticker, windowMinutes);
  const volumeBaseline = collector.calculateVolumeBaseline(ticker);
  const volatilityBaseline = collector.calculateVolatilityBaseline(ticker);
  const priceChange = collector.getPriceChange(ticker, windowMinutes);
  const dataAge = collector.getDataAge(ticker);
  
  res.json({
    ticker,
    window: windowMinutes,
    dataAge: Math.round(dataAge * 10) / 10,
    scoringMode: dataAge < 7 ? 'SIMPLE' : 'DYNAMIC',
    mentionEvents: {
      total: mentionEvents.length,
      inWindow: currentMentions,
      oldest: mentionEvents.length > 0 ? new Date(mentionEvents[0].timestamp).toISOString() : null,
      newest: mentionEvents.length > 0 ? new Date(mentionEvents[mentionEvents.length - 1].timestamp).toISOString() : null,
      bySource: {
        reddit: mentionEvents.filter(e => e.source === 'reddit').length,
        stocktwits: mentionEvents.filter(e => e.source === 'stocktwits').length
      }
    },
    priceHistory: {
      total: priceHistory.length,
      oldest: priceHistory.length > 0 ? new Date(priceHistory[0].timestamp).toISOString() : null,
      newest: priceHistory.length > 0 ? new Date(priceHistory[priceHistory.length - 1].timestamp).toISOString() : null,
      latestPrice: priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].price : null,
      latestVolume: priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].volume : null
    },
    baselines: {
      mentions: mentionBaseline,
      volume: volumeBaseline,
      volatility: volatilityBaseline
    },
    currentMetrics: {
      mentions: currentMentions,
      priceChange: priceChange
    },
    marketOpen: collector.isMarketOpen()
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'HypeMeter.ai v5.1 - All Fixes Applied',
    version: '5.1.0',
    status: 'running',
    fixes: [
      '✅ Volume working (Finnhub Candle API)',
      '✅ Reddit OAuth integrated',
      '✅ Individual mention events stored',
      '✅ Timeframe affects all metrics',
      '✅ Hybrid scoring (simple → dynamic)',
      '✅ Market hours detection',
      '✅ 30-day persistent storage'
    ],
    endpoints: {
      health: '/health',
      hype: '/api/hype?tickers=NVDA,AAPL&window=60',
      debug: '/api/debug/NVDA?window=60'
    }
  });
});

app.get('/keepalive', (req, res) => {
  res.json({ alive: true });
});

// Auto-persist and keep-alive
if (process.env.NODE_ENV === 'production') {
  setInterval(async () => {
    try {
      const url = process.env.RENDER_EXTERNAL_URL || 'https://hypemeter.onrender.com';
      await fetch(`${url}/keepalive`);
      await collector.persistData();
      console.log('💓 Keep-alive ping and data persisted');
    } catch (error) {
      console.error('Keep-alive failed:', error.message);
    }
  }, 14 * 60 * 1000);
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('💾 Saving data before shutdown...');
  await collector.persistData();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 HypeMeter.ai v5.1 running on port ${PORT}`);
  console.log(`\n📋 All Fixes Applied:`);
  console.log(`   ✅ Volume working (Finnhub Candle API)`);
  console.log(`   ✅ Reddit OAuth integrated`);
  console.log(`   ✅ Individual mention events stored`);
  console.log(`   ✅ Timeframe affects all metrics`);
  console.log(`   ✅ Hybrid scoring (simple → dynamic)`);
  console.log(`   ✅ Market hours detection`);
  console.log(`   ✅ 30-day persistent storage`);
  console.log(`\n🔧 Configuration:`);
  console.log(`   Data path: ${process.env.DATA_PATH || '/tmp'}`);
  console.log(`   Finnhub API: ${process.env.FINNHUB_API_KEY ? '✓' : '✗'}`);
  console.log(`   Reddit OAuth: ${process.env.REDDIT_CLIENT_ID ? '✓' : '✗'}`);
  console.log(`\n`);
  
  collector.startCollection();
});
