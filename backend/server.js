const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const app = express();

// Advanced caching system with multi-timeframe historical data
class AdvancedHypeCalculator {
  constructor() {
    this.cache = new Map();
    this.historicalData = new Map();
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    this.HISTORICAL_FILE = '/tmp/historical_data.json';
    this.lastHistoricalUpdate = new Map();
    this.loadHistoricalData();
    
    // Start background historical data collection
    this.startHistoricalCollection();
  }

  async loadHistoricalData() {
    try {
      const data = await fs.readFile(this.HISTORICAL_FILE, 'utf8');
      const parsed = JSON.parse(data);
      
      // Convert to Map with proper structure
      for (const [ticker, tickerData] of Object.entries(parsed)) {
        this.historicalData.set(ticker, {
          hourly: tickerData.hourly || [],
          daily: tickerData.daily || [],
          lastHourlyUpdate: tickerData.lastHourlyUpdate || 0,
          lastDailyUpdate: tickerData.lastDailyUpdate || 0
        });
      }
      
      console.log(`Loaded historical data for ${this.historicalData.size} tickers`);
    } catch (error) {
      console.log('No historical data file found, starting fresh');
    }
  }

  async saveHistoricalData() {
    try {
      const data = {};
      for (const [ticker, tickerData] of this.historicalData.entries()) {
        data[ticker] = {
          hourly: tickerData.hourly,
          daily: tickerData.daily,
          lastHourlyUpdate: tickerData.lastHourlyUpdate,
          lastDailyUpdate: tickerData.lastDailyUpdate
        };
      }
      await fs.writeFile(this.HISTORICAL_FILE, JSON.stringify(data, null, 2));
      console.log(`Saved historical data for ${Object.keys(data).length} tickers`);
    } catch (error) {
      console.error('Failed to save historical data:', error.message);
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

  async collectHistoricalDataPoint(ticker) {
    try {
      console.log(`Collecting historical data for ${ticker}`);
      
      // Get current mentions using combined sources
      const mentionsData = await this.getCombinedMentions([ticker], 60);
      const mentions = mentionsData[ticker]?.mentions || 0;
      
      if (!this.historicalData.has(ticker)) {
        this.historicalData.set(ticker, {
          hourly: [],
          daily: [],
          lastHourlyUpdate: 0,
          lastDailyUpdate: 0
        });
      }
      
      const tickerData = this.historicalData.get(ticker);
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      const oneDay = 24 * 60 * 60 * 1000;
      
      // Add hourly data point
      if (now - tickerData.lastHourlyUpdate > oneHour) {
        tickerData.hourly.push({
          mentions,
          timestamp: now,
          date: new Date(now).toISOString()
        });
        
        // Keep last 30 days of hourly data (720 hours)
        if (tickerData.hourly.length > 720) {
          tickerData.hourly = tickerData.hourly.slice(-720);
        }
        
        tickerData.lastHourlyUpdate = now;
        console.log(`Added hourly data point for ${ticker}: ${mentions} mentions`);
      }
      
      // Add daily data point (once per day, around midday)
      const currentHour = new Date().getHours();
      if (currentHour >= 11 && currentHour <= 13 && 
          now - tickerData.lastDailyUpdate > oneDay) {
        
        // Calculate average mentions for the day so far
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayHourlyData = tickerData.hourly.filter(h => h.timestamp > todayStart.getTime());
        const avgMentions = todayHourlyData.length > 0 
          ? todayHourlyData.reduce((sum, h) => sum + h.mentions, 0) / todayHourlyData.length
          : mentions;
        
        tickerData.daily.push({
          mentions: avgMentions,
          timestamp: now,
          date: new Date(now).toISOString().split('T')[0]
        });
        
        // Keep last 60 days of daily data
        if (tickerData.daily.length > 60) {
          tickerData.daily = tickerData.daily.slice(-60);
        }
        
        tickerData.lastDailyUpdate = now;
        console.log(`Added daily data point for ${ticker}: ${avgMentions} avg mentions`);
      }
      
      this.historicalData.set(ticker, tickerData);
      
    } catch (error) {
      console.error(`Error collecting historical data for ${ticker}:`, error.message);
    }
  }

  calculateWeightedBaseline(ticker) {
    const tickerData = this.historicalData.get(ticker);
    if (!tickerData) {
      return { baseline: null, confidence: 0, dataPoints: 0 };
    }
    
    const now = Date.now();
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
    
    // Get recent hourly data (last 7 days) with higher weight
    const recentHourly = tickerData.hourly.filter(h => h.timestamp > sevenDaysAgo);
    
    // Get older daily data (8-30 days ago) with lower weight
    const olderDaily = tickerData.daily.filter(h => 
      h.timestamp > thirtyDaysAgo && h.timestamp <= sevenDaysAgo
    );
    
    if (recentHourly.length === 0 && olderDaily.length === 0) {
      return { baseline: null, confidence: 0, dataPoints: 0 };
    }
    
    let weightedSum = 0;
    let totalWeight = 0;
    
    // Recent hourly data: weight = 1.0
    for (const point of recentHourly) {
      const weight = 1.0;
      weightedSum += point.mentions * weight;
      totalWeight += weight;
    }
    
    // Older daily data: weight = 0.3 (lower influence)
    for (const point of olderDaily) {
      const weight = 0.3;
      weightedSum += point.mentions * weight;
      totalWeight += weight;
    }
    
    const baseline = totalWeight > 0 ? weightedSum / totalWeight : null;
    const confidence = Math.min(totalWeight / 50, 1); // Confidence based on data amount
    
    return {
      baseline: baseline ? Math.round(baseline * 10) / 10 : null,
      confidence: Math.round(confidence * 100) / 100,
      dataPoints: recentHourly.length + olderDaily.length,
      recentPoints: recentHourly.length,
      historicalPoints: olderDaily.length
    };
  }

  calculateHypeScore(ticker, currentMentions, volume, priceChangePercent) {
    const baselineData = this.calculateWeightedBaseline(ticker);
    const baseline = baselineData.baseline;
    
    // If no baseline yet, use current mentions as baseline
    const effectiveBaseline = baseline || Math.max(currentMentions, 1);
    
    // Calculate mention anomaly with confidence adjustment
    let mentionMultiplier = 1;
    if (effectiveBaseline > 0) {
      mentionMultiplier = currentMentions / effectiveBaseline;
      
      // Apply confidence factor - less confident baselines have less impact
      const confidenceFactor = baselineData.confidence || 0.5;
      mentionMultiplier = 1 + (mentionMultiplier - 1) * confidenceFactor;
      
      // Cap extreme multipliers
      mentionMultiplier = Math.min(mentionMultiplier, 5);
      mentionMultiplier = Math.max(mentionMultiplier, 0.1);
    }
    
    // Base hype from adjusted mentions (0-60 points)
    const adjustedMentions = currentMentions * Math.log(mentionMultiplier + 1);
    let hypeScore = Math.min(adjustedMentions * 1.8, 60);
    
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
    
    // Boost for significantly above-baseline activity (higher confidence = bigger boost)
    if (mentionMultiplier > 1.5) {
      const confidenceBoost = baselineData.confidence || 0.5;
      const anomalyBonus = Math.min((mentionMultiplier - 1) * 12 * confidenceBonus, 20);
      hypeScore += anomalyBonus;
    }
    
    return Math.min(Math.round(hypeScore), 100);
  }

  async getRedditMentions(tickerList, window) {
    const results = {};
    const subreddits = ['wallstreetbets', 'stocks', 'investing', 'SecurityAnalysis'];
    
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
                'User-Agent': 'HypeMeter:v2.3 (by /u/stocktracker)'
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
                  new RegExp(`\\${ticker}\\b`, 'g'),
                  new RegExp(`\\b${ticker}\\const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const app = express();

// Advanced caching system with multi-timeframe historical data
class AdvancedHypeCalculator {
  constructor() {
    this.cache = new Map();
    this.historicalData = new Map();
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    this.HISTORICAL_FILE = '/tmp/historical_data.json';
    this.lastHistoricalUpdate = new Map();
    this.loadHistoricalData();
    
    // Start background historical data collection
    this.startHistoricalCollection();
  }

  async loadHistoricalData() {
    try {
      const data = await fs.readFile(this.HISTORICAL_FILE, 'utf8');
      const parsed = JSON.parse(data);
      
      // Convert to Map with proper structure
      for (const [ticker, tickerData] of Object.entries(parsed)) {
        this.historicalData.set(ticker, {
          hourly: tickerData.hourly || [],
          daily: tickerData.daily || [],
          lastHourlyUpdate: tickerData.lastHourlyUpdate || 0,
          lastDailyUpdate: tickerData.lastDailyUpdate || 0
        });
      }
      
      console.log(`Loaded historical data for ${this.historicalData.size} tickers`);
    } catch (error) {
      console.log('No historical data file found, starting fresh');
    }
  }

  async saveHistoricalData() {
    try {
      const data = {};
      for (const [ticker, tickerData] of this.historicalData.entries()) {
        data[ticker] = {
          hourly: tickerData.hourly,
          daily: tickerData.daily,
          lastHourlyUpdate: tickerData.lastHourlyUpdate,
          lastDailyUpdate: tickerData.lastDailyUpdate
        };
      }
      await fs.writeFile(this.HISTORICAL_FILE, JSON.stringify(data, null, 2));
      console.log(`Saved historical data for ${Object.keys(data).length} tickers`);
    } catch (error) {
      console.error('Failed to save historical data:', error.message);
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

  async collectHistoricalDataPoint(ticker) {
    try {
      console.log(`Collecting historical data for ${ticker}`);
      
      // Get current mentions
      const mentionsData = await this.getRedditMentions([ticker], 60);
      const mentions = mentionsData[ticker]?.mentions || 0;
      
      if (!this.historicalData.has(ticker)) {
        this.historicalData.set(ticker, {
          hourly: [],
          daily: [],
          lastHourlyUpdate: 0,
          lastDailyUpdate: 0
        });
      }
      
      const tickerData = this.historicalData.get(ticker);
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      const oneDay = 24 * 60 * 60 * 1000;
      
      // Add hourly data point
      if (now - tickerData.lastHourlyUpdate > oneHour) {
        tickerData.hourly.push({
          mentions,
          timestamp: now,
          date: new Date(now).toISOString()
        });
        
        // Keep last 30 days of hourly data (720 hours)
        if (tickerData.hourly.length > 720) {
          tickerData.hourly = tickerData.hourly.slice(-720);
        }
        
        tickerData.lastHourlyUpdate = now;
        console.log(`Added hourly data point for ${ticker}: ${mentions} mentions`);
      }
      
      // Add daily data point (once per day, around midday)
      const currentHour = new Date().getHours();
      if (currentHour >= 11 && currentHour <= 13 && 
          now - tickerData.lastDailyUpdate > oneDay) {
        
        // Calculate average mentions for the day so far
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayHourlyData = tickerData.hourly.filter(h => h.timestamp > todayStart.getTime());
        const avgMentions = todayHourlyData.length > 0 
          ? todayHourlyData.reduce((sum, h) => sum + h.mentions, 0) / todayHourlyData.length
          : mentions;
        
        tickerData.daily.push({
          mentions: avgMentions,
          timestamp: now,
          date: new Date(now).toISOString().split('T')[0]
        });
        
        // Keep last 60 days of daily data
        if (tickerData.daily.length > 60) {
          tickerData.daily = tickerData.daily.slice(-60);
        }
        
        tickerData.lastDailyUpdate = now;
        console.log(`Added daily data point for ${ticker}: ${avgMentions} avg mentions`);
      }
      
      this.historicalData.set(ticker, tickerData);
      
    } catch (error) {
      console.error(`Error collecting historical data for ${ticker}:`, error.message);
    }
  }

  calculateWeightedBaseline(ticker) {
    const tickerData = this.historicalData.get(ticker);
    if (!tickerData) {
      return { baseline: null, confidence: 0, dataPoints: 0 };
    }
    
    const now = Date.now();
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
    
    // Get recent hourly data (last 7 days) with higher weight
    const recentHourly = tickerData.hourly.filter(h => h.timestamp > sevenDaysAgo);
    
    // Get older daily data (8-30 days ago) with lower weight
    const olderDaily = tickerData.daily.filter(h => 
      h.timestamp > thirtyDaysAgo && h.timestamp <= sevenDaysAgo
    );
    
    if (recentHourly.length === 0 && olderDaily.length === 0) {
      return { baseline: null, confidence: 0, dataPoints: 0 };
    }
    
    let weightedSum = 0;
    let totalWeight = 0;
    
    // Recent hourly data: weight = 1.0
    for (const point of recentHourly) {
      const weight = 1.0;
      weightedSum += point.mentions * weight;
      totalWeight += weight;
    }
    
    // Older daily data: weight = 0.3 (lower influence)
    for (const point of olderDaily) {
      const weight = 0.3;
      weightedSum += point.mentions * weight;
      totalWeight += weight;
    }
    
    const baseline = totalWeight > 0 ? weightedSum / totalWeight : null;
    const confidence = Math.min(totalWeight / 50, 1); // Confidence based on data amount
    
    return {
      baseline: baseline ? Math.round(baseline * 10) / 10 : null,
      confidence: Math.round(confidence * 100) / 100,
      dataPoints: recentHourly.length + olderDaily.length,
      recentPoints: recentHourly.length,
      historicalPoints: olderDaily.length
    };
  }

  calculateHypeScore(ticker, currentMentions, volume, priceChangePercent) {
    const baselineData = this.calculateWeightedBaseline(ticker);
    const baseline = baselineData.baseline;
    
    // If no baseline yet, use current mentions as baseline
    const effectiveBaseline = baseline || Math.max(currentMentions, 1);
    
    // Calculate mention anomaly with confidence adjustment
    let mentionMultiplier = 1;
    if (effectiveBaseline > 0) {
      mentionMultiplier = currentMentions / effectiveBaseline;
      
      // Apply confidence factor - less confident baselines have less impact
      const confidenceFactor = baselineData.confidence || 0.5;
      mentionMultiplier = 1 + (mentionMultiplier - 1) * confidenceFactor;
      
      // Cap extreme multipliers
      mentionMultiplier = Math.min(mentionMultiplier, 5);
      mentionMultiplier = Math.max(mentionMultiplier, 0.1);
    }
    
    // Base hype from adjusted mentions (0-60 points)
    const adjustedMentions = currentMentions * Math.log(mentionMultiplier + 1);
    let hypeScore = Math.min(adjustedMentions * 1.8, 60);
    
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
    
    // Boost for significantly above-baseline activity (higher confidence = bigger boost)
    if (mentionMultiplier > 1.5) {
      const confidenceBoost = baselineData.confidence || 0.5;
      const anomalyBonus = Math.min((mentionMultiplier - 1) * 12 * confidenceBonus, 20);
      hypeScore += anomalyBonus;
    }
    
    return Math.min(Math.round(hypeScore), 100);
  }

, 'g')
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

  async getTwitterMentions(tickerList) {
    const results = {};
    const twitterApiKey = process.env.TWITTER_BEARER_TOKEN;
    
    if (!twitterApiKey) {
      console.log('Twitter API key not configured, skipping Twitter data');
      for (const ticker of tickerList) {
        results[ticker] = {
          mentions: 0,
          source: 'twitter_disabled',
          error: 'Twitter API key not configured'
        };
      }
      return results;
    }
    
    for (const ticker of tickerList) {
      try {
        // Raw Twitter API v2 search
        const query = `${ticker} OR ${ticker}`;
        const twitterUrl = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=100`;
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        
        const response = await fetch(twitterUrl, {
          signal: controller.signal,
          headers: {
            'Authorization': `Bearer ${twitterApiKey}`,
            'User-Agent': 'HypeMeter/v2.4'
          }
        });
        
        clearTimeout(timeout);
        
        if (!response.ok) {
          throw new Error(`Twitter API returned ${response.status}`);
        }
        
        const data = await response.json();
        
        // Count recent tweets (last hour)
        let mentions = 0;
        if (data && data.data && Array.isArray(data.data)) {
          const oneHourAgo = new Date(Date.now() - (60 * 60 * 1000));
          
          mentions = data.data.filter(tweet => {
            const tweetTime = new Date(tweet.created_at);
            return tweetTime > oneHourAgo;
          }).length;
        }
        
        results[ticker] = {
          mentions,
          source: 'twitter',
          timestamp: new Date().toISOString()
        };
        
        console.log(`Twitter: Found ${mentions} mentions for ${ticker}`);
        
      } catch (error) {
        console.error(`Twitter error for ${ticker}:`, error.message);
        results[ticker] = {
          mentions: 0,
          source: 'twitter_failed',
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    }
    
    return results;
  }

  async getCombinedMentions(tickerList, window) {
    // Get data from both sources in parallel
    const [redditData, twitterData] = await Promise.all([
      this.getRedditMentions(tickerList, window),
      this.getTwitterMentions(tickerList)
    ]);
    
    const results = {};
    
    for (const ticker of tickerList) {
      const reddit = redditData[ticker] || { mentions: 0 };
      const twitter = twitterData[ticker] || { mentions: 0 };
      
      // Combine mentions with weighting
      // Reddit: 60% weight (longer discussions)  
      // Twitter: 40% weight (real-time reactions)
      const redditWeight = 0.6;
      const twitterWeight = 0.4;
      
      const combinedMentions = Math.round(
        (reddit.mentions * redditWeight) + (twitter.mentions * twitterWeight)
      );
      
      // Track data quality
      const dataSources = [];
      if (reddit.mentions > 0 && !reddit.error) dataSources.push('reddit');
      if (twitter.mentions > 0 && !twitter.error) dataSources.push('twitter');
      
      results[ticker] = {
        mentions: combinedMentions,
        reddit_mentions: reddit.mentions,
        twitter_mentions: twitter.mentions,
        sources: dataSources,
        data_quality: dataSources.length,
        window: parseInt(window),
        timestamp: new Date().toISOString(),
        source: 'combined'
      };
      
      console.log(`Combined mentions for ${ticker}: ${combinedMentions} (Reddit: ${reddit.mentions}, Twitter: ${twitter.mentions})`);
    }
    
    return results;
  }

  startHistoricalCollection() {
    // Common tickers to collect historical data for
    const commonTickers = [
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'NVDA', 'META', 'AMD',
      'GME', 'AMC', 'SPY', 'QQQ', 'COIN', 'NFLX', 'CRM', 'PLTR'
    ];
    
    // Collect historical data every hour
    setInterval(async () => {
      console.log('Starting hourly historical data collection...');
      
      for (const ticker of commonTickers) {
        await this.collectHistoricalDataPoint(ticker);
        // Small delay between tickers to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      await this.saveHistoricalData();
      console.log('Hourly historical data collection completed');
      
    }, 60 * 60 * 1000); // Every hour
    
    // Initial collection after 5 minutes
    setTimeout(() => {
      commonTickers.forEach(ticker => this.collectHistoricalDataPoint(ticker));
    }, 5 * 60 * 1000);
  }

  getStats() {
    const stats = {
      cache_size: this.cache.size,
      tracked_tickers: this.historicalData.size,
      baselines: []
    };
    
    for (const [ticker, data] of this.historicalData.entries()) {
      const baseline = this.calculateWeightedBaseline(ticker);
      stats.baselines.push({
        ticker,
        baseline: baseline.baseline,
        confidence: baseline.confidence,
        dataPoints: baseline.dataPoints,
        recentPoints: baseline.recentPoints,
        historicalPoints: baseline.historicalPoints
      });
    }
    
    return stats;
  }
}

const hypeCalc = new AdvancedHypeCalculator();

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

// Combined mentions endpoint with Reddit + StockTwits
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
    console.error('Combined mentions API error:', error);
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

// Advanced hype endpoint with weighted historical baselines
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

      // Use advanced baseline-adjusted hype calculation
      const hypeScore = hypeCalc.calculateHypeScore(
        ticker,
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

// Individual source endpoints for comparison
app.get('/api/reddit/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const window = parseInt(req.query.window) || 60;
    
    const redditData = await hypeCalc.getRedditMentions([ticker], window);
    res.json(redditData[ticker] || { mentions: 0, error: 'No data' });
    
  } catch (error) {
    console.error('Reddit API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stocktwits/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    
    const stocktwitsData = await hypeCalc.getStockTwitsMentions([ticker]);
    res.json(stocktwitsData[ticker] || { mentions: 0, error: 'No data' });
    
  } catch (error) {
    console.error('StockTwits API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Compare sources endpoint
app.get('/api/compare/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const window = parseInt(req.query.window) || 60;
    
    const [redditData, stocktwitsData] = await Promise.all([
      hypeCalc.getRedditMentions([ticker], window),
      hypeCalc.getStockTwitsMentions([ticker])
    ]);
    
    res.json({
      ticker,
      reddit: redditData[ticker] || { mentions: 0 },
      stocktwits: stocktwitsData[ticker] || { mentions: 0 },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Compare API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin endpoint to view detailed baselines
app.get('/api/admin/baselines', (req, res) => {
  const stats = hypeCalc.getStats();
  res.json(stats.baselines);
});

// Default route
app.get('/', (req, res) => {
  const stats = hypeCalc.getStats();
  res.json({
    message: 'HypeMeter.ai - Multi-Source Social Media Hype Tracking',
    version: '2.4.0',
    status: 'running',
    data_sources: 'Reddit (70% weight) + StockTwits (30% weight)',
    historical_collection: 'Combined sources: Hourly (30 days) + Daily (60 days)',
    ...stats,
    endpoints: {
      health: '/health',
      keepalive: '/keepalive',
      mentions: '/api/mentions?tickers=NVDA,AAPL&window=60',
      quotes: '/api/quotes?tickers=NVDA,AAPL',
      hype: '/api/hype?tickers=NVDA,AAPL&window=60',
      reddit_only: '/api/reddit/TSLA?window=60',
      stocktwits_only: '/api/stocktwits/TSLA',
      compare_sources: '/api/compare/TSLA?window=60',
      baselines: '/api/admin/baselines'
    }
  });
});

// Enhanced self-ping and data persistence
if (process.env.NODE_ENV === 'production') {
  setInterval(async () => {
    try {
      const url = process.env.RENDER_EXTERNAL_URL || 'https://hypemeter.onrender.com';
      await fetch(`${url}/keepalive`);
      await hypeCalc.saveHistoricalData();
      console.log('Keep-alive ping sent and historical data saved');
    } catch (error) {
      console.error('Keep-alive failed:', error.message);
    }
  }, 14 * 60 * 1000);
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Saving historical data before shutdown...');
  await hypeCalc.saveHistoricalData();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HypeMeter.ai API server running on port ${PORT}`);
  console.log(`Advanced historical baseline tracking enabled`);
  console.log(`Collection: Hourly (last 30 days) + Daily midday (30-60 days ago)`);
  console.log(`Weighting: Recent hourly=1.0, Historical daily=0.3`);
  console.log(`Finnhub API Key configured: ${process.env.FINNHUB_API_KEY ? 'Yes' : 'No'}`);
});
