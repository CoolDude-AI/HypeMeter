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
    this.priceHistory = new Map();
    this.volumeData = new Map(); // NEW: Dedicated volume tracking
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    this.HISTORICAL_FILE = '/tmp/historical_data.json';
    this.PRICE_HISTORY_FILE = '/tmp/price_history.json';
    this.VOLUME_DATA_FILE = '/tmp/volume_data.json';
    this.lastHistoricalUpdate = new Map();
    this.loadHistoricalData();
    
    // Start background historical data collection
    this.startHistoricalCollection();
  }

  async loadHistoricalData() {
    try {
      // Load historical mentions data
      const data = await fs.readFile(this.HISTORICAL_FILE, 'utf8');
      const parsed = JSON.parse(data);
      
      for (const [ticker, tickerData] of Object.entries(parsed)) {
        this.historicalData.set(ticker, {
          hourly: tickerData.hourly || [],
          daily: tickerData.daily || [],
          lastHourlyUpdate: tickerData.lastHourlyUpdate || 0,
          lastDailyUpdate: tickerData.lastDailyUpdate || 0
        });
      }
      
      console.log(`📂 Loaded historical data for ${this.historicalData.size} tickers`);
    } catch (error) {
      console.log('📂 No historical data file found, starting fresh');
    }
    
    // Load price history
    try {
      const priceData = await fs.readFile(this.PRICE_HISTORY_FILE, 'utf8');
      const parsedPrice = JSON.parse(priceData);
      
      for (const [ticker, history] of Object.entries(parsedPrice)) {
        this.priceHistory.set(ticker, history);
      }
      
      const totalSnapshots = Array.from(this.priceHistory.values())
        .reduce((sum, h) => sum + h.length, 0);
      console.log(`💰 Loaded ${totalSnapshots} price snapshots across ${this.priceHistory.size} tickers`);
    } catch (error) {
      console.log('💰 No price history file found, starting fresh');
    }
    
    // Load volume data
    try {
      const volumeData = await fs.readFile(this.VOLUME_DATA_FILE, 'utf8');
      const parsedVolume = JSON.parse(volumeData);
      
      for (const [ticker, volumes] of Object.entries(parsedVolume)) {
        this.volumeData.set(ticker, volumes);
      }
      console.log(`📊 Loaded volume data for ${this.volumeData.size} tickers`);
    } catch (error) {
      console.log('📊 No volume data file found, starting fresh');
    }
  }

  async saveHistoricalData() {
    try {
      // Save mentions data
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
      console.log(`  💾 Saved historical data for ${Object.keys(data).length} tickers`);
      
      // Save price history
      const priceData = {};
      for (const [ticker, history] of this.priceHistory.entries()) {
        // Keep last 30 days of price data
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        priceData[ticker] = history.filter(h => h.timestamp > thirtyDaysAgo);
      }
      await fs.writeFile(this.PRICE_HISTORY_FILE, JSON.stringify(priceData, null, 2));
      
      // Save volume data
      const volumeData = {};
      for (const [ticker, volumes] of this.volumeData.entries()) {
        // Keep last 24 hours of volume data
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
        volumeData[ticker] = volumes.filter(v => v.timestamp > oneDayAgo);
      }
      await fs.writeFile(this.VOLUME_DATA_FILE, JSON.stringify(volumeData, null, 2));
      
      const totalSnapshots = Object.values(priceData).reduce((sum, h) => sum + h.length, 0);
      console.log(`  💾 Saved ${totalSnapshots} price snapshots and volume data`);
      
    } catch (error) {
      console.error('❌ Failed to save data:', error.message);
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

  // ENHANCED: Store previousClose with price records
  recordPrice(ticker, price, previousClose, volume, volumeSource = 'unknown') {
    if (!this.priceHistory.has(ticker)) {
      this.priceHistory.set(ticker, []);
    }
    
    const history = this.priceHistory.get(ticker);
    const beforeCount = history.length;
    
    history.push({
      timestamp: Date.now(),
      price,
      previousClose, // NEW: Store this for change calculations
      volume,
      volumeSource
    });
    
    // Keep max 288 points (24 hours at 5-min intervals)
    if (history.length > 288) {
      this.priceHistory.set(ticker, history.slice(-288));
    }
    
    console.log(`    📊 ${ticker} price history: ${beforeCount} → ${history.length} snapshots`);
  }

  // NEW: Record volume separately for better tracking
  recordVolume(ticker, volume, source) {
    if (!this.volumeData.has(ticker)) {
      this.volumeData.set(ticker, []);
    }
    
    this.volumeData.get(ticker).push({
      volume,
      source,
      timestamp: Date.now()
    });
    
    // Keep last 100 volume records
    const volumes = this.volumeData.get(ticker);
    if (volumes.length > 100) {
      this.volumeData.set(ticker, volumes.slice(-100));
    }
    
    console.log(`    📊 ${ticker} recorded volume: ${volume.toLocaleString()} from ${source}`);
  }

  // NEW: Get latest volume from any source
  getLatestVolume(ticker) {
    const volumes = this.volumeData.get(ticker);
    if (volumes && volumes.length > 0) {
      return volumes[volumes.length - 1].volume;
    }
    
    // Fallback to price history volume
    const history = this.priceHistory.get(ticker);
    if (history && history.length > 0) {
      return history[history.length - 1].volume;
    }
    
    return 0;
  }

  // ENHANCED: Better price change calculation with previousClose fallback
  getPriceChange(ticker, windowMinutes = 60) {
    const history = this.priceHistory.get(ticker);
    
    console.log(`\n🔍 Calculating price change for ${ticker} (${windowMinutes}min window)...`);
    
    if (!history || history.length === 0) {
      console.log(`  ❌ No history available`);
      return null;
    }
    
    const currentSnapshot = history[history.length - 1];
    
    // If we only have 1 snapshot but it has previousClose, use that
    if (history.length === 1 && currentSnapshot.previousClose) {
      const change = currentSnapshot.price - currentSnapshot.previousClose;
      const changePercent = (change / currentSnapshot.previousClose) * 100;
      
      console.log(`  📍 Using previousClose: $${currentSnapshot.previousClose}`);
      console.log(`  📍 Current price: $${currentSnapshot.price}`);
      console.log(`  ✅ Change: $${change.toFixed(2)} (${changePercent.toFixed(2)}%)\n`);
      
      return {
        change,
        changePercent,
        currentPrice: currentSnapshot.price,
        oldPrice: currentSnapshot.previousClose,
        currentVolume: currentSnapshot.volume,
        source: 'previousClose'
      };
    }
    
    // Multiple snapshots - find the one closest to window
    if (history.length >= 2) {
      const now = Date.now();
      const targetTime = now - (windowMinutes * 60 * 1000);
      
      let oldSnapshot = history[0];
      let minDiff = Math.abs(history[0].timestamp - targetTime);
      
      for (const snapshot of history) {
        const diff = Math.abs(snapshot.timestamp - targetTime);
        if (diff < minDiff && snapshot.timestamp <= targetTime) {
          minDiff = diff;
          oldSnapshot = snapshot;
        }
      }
      
      console.log(`  📊 Using ${history.length} snapshots`);
      console.log(`  📍 Old price: $${oldSnapshot.price} from ${new Date(oldSnapshot.timestamp).toLocaleTimeString()}`);
      console.log(`  📍 Current price: $${currentSnapshot.price}`);
      
      const change = currentSnapshot.price - oldSnapshot.price;
      const changePercent = (change / oldSnapshot.price) * 100;
      
      console.log(`  ✅ Change: $${change.toFixed(2)} (${changePercent.toFixed(2)}%)\n`);
      
      return {
        change,
        changePercent,
        currentPrice: currentSnapshot.price,
        oldPrice: oldSnapshot.price,
        currentVolume: currentSnapshot.volume,
        oldVolume: oldSnapshot.volume,
        source: 'history'
      };
    }
    
    // Last resort: use previousClose from latest snapshot
    if (currentSnapshot.previousClose) {
      const change = currentSnapshot.price - currentSnapshot.previousClose;
      const changePercent = (change / currentSnapshot.previousClose) * 100;
      
      return {
        change,
        changePercent,
        currentPrice: currentSnapshot.price,
        oldPrice: currentSnapshot.previousClose,
        currentVolume: currentSnapshot.volume,
        source: 'previousClose-fallback'
      };
    }
    
    console.log(`  ❌ Unable to calculate price change\n`);
    return null;
  }

  async collectHistoricalDataPoint(ticker) {
    try {
      console.log(`  📊 Collecting historical data for ${ticker}`);
      
      // Get current mentions using combined sources
      const mentionsData = await this.getCombinedMentions([ticker], 60);
      const mentions = mentionsData[ticker]?.mentions || 0;
      
      // Get current price and volume
      const priceData = await this.getQuoteWithVolume(ticker);
      
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
          price: priceData?.price,
          volume: priceData?.volume,
          timestamp: now,
          date: new Date(now).toISOString()
        });
        
        // Keep last 30 days of hourly data (720 hours)
        if (tickerData.hourly.length > 720) {
          tickerData.hourly = tickerData.hourly.slice(-720);
        }
        
        tickerData.lastHourlyUpdate = now;
        console.log(`    ✅ Added hourly: ${mentions} mentions, $${priceData?.price}, Vol: ${priceData?.volume}`);
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
          price: priceData?.price,
          volume: priceData?.volume,
          timestamp: now,
          date: new Date(now).toISOString().split('T')[0]
        });
        
        // Keep last 60 days of daily data
        if (tickerData.daily.length > 60) {
          tickerData.daily = tickerData.daily.slice(-60);
        }
        
        tickerData.lastDailyUpdate = now;
        console.log(`    ✅ Added daily: ${avgMentions} avg mentions`);
      }
      
      this.historicalData.set(ticker, tickerData);
      
    } catch (error) {
      console.error(`  ❌ Error collecting historical data for ${ticker}:`, error.message);
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
    
    // Volume impact (0-20 points) - with proper scaling
    if (volume && volume > 0) {
      const volumeScore = Math.min(Math.log10(volume / 1000000 + 1) * 15, 20);
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
      const anomalyBonus = Math.min((mentionMultiplier - 1) * 12 * confidenceBoost, 20);
      hypeScore += anomalyBonus;
    }
    
    // Make scoring logarithmic to prevent too many 100s
    hypeScore = Math.min(Math.round(hypeScore * 0.85), 100);
    
    return hypeScore;
  }

  // COMPREHENSIVE: Multi-strategy volume collection with all fallbacks
  async getQuoteWithVolume(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) {
      console.log(`  ❌ No Finnhub API key`);
      return null;
    }
    
    const history = this.priceHistory.get(ticker);
    console.log(`\n📦 Collecting price/volume for ${ticker}...`);
    console.log(`  📚 BEFORE: ${history ? history.length : 0} price snapshots`);
    
    try {
      // STEP 1: Get quote for price and previousClose
      console.log(`  🔄 Step 1: Fetching quote...`);
      const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`;
      const quoteResponse = await fetch(quoteUrl);
      
      console.log(`    Quote Response Status: ${quoteResponse.status}`);
      
      if (!quoteResponse.ok) {
        console.log(`    ❌ Quote failed: ${quoteResponse.status}`);
        return null;
      }
      
      const quote = await quoteResponse.json();
      console.log(`    ✅ Quote: Price=$${quote.c}, PrevClose=$${quote.pc}, Change=${((quote.c - quote.pc) / quote.pc * 100).toFixed(2)}%`);
      
      let volume = 0;
      let volumeSource = 'none';
      
      // STEP 2: Multi-strategy volume collection
      console.log(`  🔄 Step 2: Volume collection...`);
      
      // Strategy 1: Try latest daily candle (most reliable)
      console.log(`    📊 Strategy 1: Daily candle...`);
      try {
        const to = Math.floor(Date.now() / 1000);
        const from = to - (2 * 86400); // Last 2 days
        
        const candleRes = await fetch(
          `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}&token=${apiKey}`
        );
        
        if (candleRes.ok) {
          const candle = await candleRes.json();
          console.log(`      Response: ${candle.s}, Points: ${candle.v?.length || 0}`);
          
          if (candle.s === 'ok' && candle.v?.length > 0) {
            // Get the most recent day's volume
            volume = candle.v[candle.v.length - 1] || 0;
            volumeSource = 'daily-candle';
            console.log(`      ✅ Daily volume: ${volume.toLocaleString()}`);
          } else {
            console.log(`      ⚠️ No daily data`);
          }
        }
      } catch (e) {
        console.log(`      ❌ Daily failed: ${e.message}`);
      }
      
      // Strategy 2: Try 5-minute candles if daily failed
      if (volume === 0) {
        console.log(`    📊 Strategy 2: 5-min candles...`);
        try {
          const to = Math.floor(Date.now() / 1000);
          const from = to - 3600; // Last hour
          
          const candleRes = await fetch(
            `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=5&from=${from}&to=${to}&token=${apiKey}`
          );
          
          if (candleRes.ok) {
            const candle = await candleRes.json();
            console.log(`      Response: ${candle.s}, Points: ${candle.v?.length || 0}`);
            
            if (candle.s === 'ok' && candle.v?.length > 0) {
              volume = candle.v.reduce((sum, v) => sum + (v || 0), 0);
              volumeSource = '5min-candle';
              console.log(`      ✅ 5min volume sum: ${volume.toLocaleString()}`);
            } else {
              console.log(`      ⚠️ No 5min data (market closed?)`);
            }
          }
        } catch (e) {
          console.log(`      ❌ 5min failed: ${e.message}`);
        }
      }
      
      // Strategy 3: Try hourly candles
      if (volume === 0) {
        console.log(`    📊 Strategy 3: Hourly candles...`);
        try {
          const to = Math.floor(Date.now() / 1000);
          const from = to - (4 * 3600); // Last 4 hours
          
          const candleRes = await fetch(
            `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=60&from=${from}&to=${to}&token=${apiKey}`
          );
          
          if (candleRes.ok) {
            const candle = await candleRes.json();
            console.log(`      Response: ${candle.s}, Points: ${candle.v?.length || 0}`);
            
            if (candle.s === 'ok' && candle.v?.length > 0) {
              volume = candle.v.reduce((sum, v) => sum + (v || 0), 0);
              volumeSource = 'hourly-candle';
              console.log(`      ✅ Hourly volume sum: ${volume.toLocaleString()}`);
            }
          }
        } catch (e) {
          console.log(`      ❌ Hourly failed: ${e.message}`);
        }
      }
      
      // Strategy 4: Use latest known volume
      if (volume === 0) {
        console.log(`    📊 Strategy 4: Previous volume...`);
        const latestVolume = this.getLatestVolume(ticker);
        if (latestVolume > 0) {
          volume = latestVolume;
          volumeSource = 'previous-known';
          console.log(`      ↻ Using previous: ${volume.toLocaleString()}`);
        } else {
          console.log(`      ❌ No previous volume`);
        }
      }
      
      // Strategy 5: Try Yahoo Finance as fallback
      if (volume === 0) {
        console.log(`    📊 Strategy 5: Yahoo Finance fallback...`);
        const yahooData = await this.getYahooQuote(ticker);
        if (yahooData && yahooData.volume > 0) {
          volume = yahooData.volume;
          volumeSource = 'yahoo-finance';
          console.log(`      ✅ Yahoo volume: ${volume.toLocaleString()}`);
        } else {
          console.log(`      ❌ Yahoo failed or no volume`);
        }
      }
      
      // STEP 3: Record everything
      console.log(`  🔄 Step 3: Recording data...`);
      console.log(`    💰 Price: $${quote.c}, PrevClose: $${quote.pc}`);
      console.log(`    📊 Volume: ${volume.toLocaleString()} (${volumeSource})`);
      
      // Record price with previousClose
      this.recordPrice(ticker, quote.c, quote.pc, volume, volumeSource);
      
      // Also record volume separately
      if (volume > 0) {
        this.recordVolume(ticker, volume, volumeSource);
      }
      
      // STEP 4: Verify recording
      const updatedHistory = this.priceHistory.get(ticker);
      console.log(`  📊 AFTER: ${updatedHistory ? updatedHistory.length : 0} price snapshots`);
      
      if (updatedHistory && updatedHistory.length > 1) {
        console.log(`  ✅ Ready for price change calculations`);
      } else if (updatedHistory && updatedHistory.length === 1 && quote.pc) {
        console.log(`  ✅ Can use previousClose for change`);
      }
      
      return {
        price: quote.c,
        previousClose: quote.pc,
        change: quote.c - quote.pc,
        changePercent: quote.pc ? ((quote.c - quote.pc) / quote.pc) * 100 : 0,
        volume: volume,
        volumeSource: volumeSource
      };
      
    } catch (error) {
      console.error(`  ❌ Failed to get quote for ${ticker}:`, error.message);
      return null;
    }
  }

  // NEW: Yahoo Finance fallback
  async getYahooQuote(ticker) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (!response.ok) {
        return null;
      }
      
      const data = await response.json();
      
      if (data.chart?.result?.[0]) {
        const result = data.chart.result[0];
        const quote = result.meta;
        const indicators = result.indicators?.quote?.[0];
        
        let volume = 0;
        if (indicators?.volume && indicators.volume.length > 0) {
          // Get the last non-null volume
          for (let i = indicators.volume.length - 1; i >= 0; i--) {
            if (indicators.volume[i] !== null) {
              volume = indicators.volume[i];
              break;
            }
          }
        }
        
        return {
          price: quote.regularMarketPrice,
          previousClose: quote.previousClose || quote.chartPreviousClose,
          volume: volume,
          source: 'yahoo'
        };
      }
      
      return null;
    } catch (e) {
      console.log(`      Yahoo error: ${e.message}`);
      return null;
    }
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
                'User-Agent': 'HypeMeter:v2.6 (by /u/stocktracker)'
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
            console.error(`    Error searching r/${subreddit} for ${ticker}:`, subredditError.message);
          }
        }
        
        results[ticker] = {
          mentions: totalMentions,
          window: parseInt(window),
          timestamp: new Date().toISOString(),
          source: 'reddit'
        };
        
      } catch (error) {
        console.error(`  Reddit mentions error for ${ticker}:`, error.message);
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

  async getCombinedMentions(tickerList, window) {
    const redditData = await this.getRedditMentions(tickerList, window);
    
    const results = {};
    
    for (const ticker of tickerList) {
      const reddit = redditData[ticker] || { mentions: 0 };
      
      results[ticker] = {
        mentions: reddit.mentions,
        reddit_mentions: reddit.mentions,
        twitter_mentions: 0,
        sources: reddit.mentions > 0 ? ['reddit'] : [],
        data_quality: reddit.mentions > 0 ? 1 : 0,
        window: parseInt(window),
        timestamp: new Date().toISOString(),
        source: 'combined'
      };
      
      console.log(`    📊 Mentions for ${ticker}: ${reddit.mentions} (Reddit)`);
    }
    
    return results;
  }

  // NEW: Synchronous initial data collection
  async collectInitialData(tickers) {
    console.log('\n🚀 Running initial data collection for immediate availability...\n');
    
    for (const ticker of tickers) {
      console.log(`  📊 Initial collection for ${ticker}...`);
      
      // Get price and volume immediately
      const priceData = await this.getQuoteWithVolume(ticker);
      
      if (priceData) {
        console.log(`    ✅ ${ticker}: $${priceData.price}, Vol: ${priceData.volume.toLocaleString()}`);
      } else {
        console.log(`    ⚠️ ${ticker}: Failed to get initial data`);
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('\n✅ Initial collection complete - API ready to serve!\n');
  }

  startHistoricalCollection() {
    // Common tickers to collect historical data for
    const commonTickers = [
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'NVDA', 'META', 'AMD',
      'GME', 'AMC', 'SPY', 'QQQ', 'COIN', 'NFLX', 'CRM', 'PLTR'
    ];
    
    // Collect historical data every hour
    setInterval(async () => {
      console.log('\n⏰ Starting hourly historical data collection...');
      
      for (const ticker of commonTickers) {
        await this.collectHistoricalDataPoint(ticker);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      await this.saveHistoricalData();
      console.log('✅ Hourly collection completed\n');
      
    }, 60 * 60 * 1000); // Every hour
  }

  getStats() {
    const stats = {
      cache_size: this.cache.size,
      tracked_tickers: this.historicalData.size,
      price_snapshots: Array.from(this.priceHistory.values()).reduce((sum, h) => sum + h.length, 0),
      volume_records: Array.from(this.volumeData.values()).reduce((sum, v) => sum + v.length, 0),
      baselines: []
    };
    
    for (const [ticker, data] of this.historicalData.entries()) {
      const baseline = this.calculateWeightedBaseline(ticker);
      const priceHistory = this.priceHistory.get(ticker) || [];
      const volumeData = this.volumeData.get(ticker) || [];
      stats.baselines.push({
        ticker,
        baseline: baseline.baseline,
        confidence: baseline.confidence,
        dataPoints: baseline.dataPoints,
        recentPoints: baseline.recentPoints,
        historicalPoints: baseline.historicalPoints,
        priceSnapshots: priceHistory.length,
        volumeRecords: volumeData.length
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
      console.log(`  📦 Serving cached mentions for ${tickers}`);
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

// Quotes endpoint with enhanced volume collection
app.get('/api/quotes', async (req, res) => {
  try {
    const { tickers } = req.query;

    if (!tickers) {
      return res.status(400).json({ error: 'Tickers parameter is required' });
    }

    const cacheKey = `quotes_${tickers}`;
    const cached = hypeCalc.getFromCache(cacheKey);
    if (cached) {
      console.log(`  📦 Serving cached quotes for ${tickers}`);
      return res.json(cached);
    }

    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = {};

    const promises = tickerList.map(async (ticker) => {
      const priceData = await hypeCalc.getQuoteWithVolume(ticker);
      
      if (priceData) {
        return {
          ticker,
          data: {
            symbol: ticker,
            name: ticker,
            currentPrice: priceData.price,
            previousClose: priceData.previousClose,
            change: priceData.change,
            changePercent: priceData.changePercent,
            volume: priceData.volume || 0,
            volumeSource: priceData.volumeSource,
            timestamp: new Date().toISOString()
          }
        };
      } else {
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

// Advanced hype endpoint with proper data flow
app.get('/api/hype', async (req, res) => {
  try {
    const { tickers, window = 60 } = req.query;
    
    if (!tickers) {
      return res.status(400).json({ error: 'Tickers parameter is required' });
    }

    console.log(`\n🎯 Processing hype request for: ${tickers} (${window}min window)`);

    const cacheKey = `hype_${tickers}_${window}`;
    const cached = hypeCalc.getFromCache(cacheKey);
    if (cached) {
      console.log(`  📦 Serving cached hype scores`);
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
      console.log(`\n  Processing ${ticker}...`);
      
      const mentionData = mentionsResponse[ticker] || { mentions: 0 };
      const quoteData = quotesResponse[ticker] || {};
      
      // Get historical price change
      const priceChange = hypeCalc.getPriceChange(ticker, parseInt(window));
      
      // Use price change from history if available, otherwise from quote
      const changePercent = priceChange?.changePercent ?? quoteData.changePercent ?? 0;
      const change = priceChange?.change ?? quoteData.change ?? 0;
      
      // Ensure we get the latest volume
      const latestVolume = hypeCalc.getLatestVolume(ticker);
      const volume = latestVolume || quoteData.volume || 0;

      // Calculate hype score with all available data
      const hypeScore = hypeCalc.calculateHypeScore(
        ticker,
        mentionData.mentions || 0,
        volume,
        changePercent
      );
      
      console.log(`    ✅ Hype Score: ${hypeScore}`);
      console.log(`    📊 Mentions: ${mentionData.mentions || 0}`);
      console.log(`    📊 Volume: ${volume.toLocaleString()} (${quoteData.volumeSource || 'cached'})`);
      console.log(`    📈 Change: ${changePercent.toFixed(2)}% (${priceChange?.source || 'quote'})`);

      results[ticker] = {
        symbol: ticker,
        hypeScore: hypeScore,
        mentions: mentionData.mentions || 0,
        price: quoteData.currentPrice || null,
        change: change || 0,
        changePercent: changePercent || 0,
        volume: volume || 0,
        volumeSource: quoteData.volumeSource || 'cached',
        name: quoteData.name || ticker,
        priceHistory: hypeCalc.priceHistory.get(ticker)?.length || 0,
        changeSource: priceChange?.source || 'quote',
        timestamp: new Date().toISOString()
      };
    }

    hypeCalc.setCache(cacheKey, results);
    console.log('\n✅ Hype calculation complete\n');
    res.json(results);
    
  } catch (error) {
    console.error('Hype API error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Enhanced debug endpoint
app.get('/api/debug/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const priceHistory = hypeCalc.priceHistory.get(ticker) || [];
  const volumeData = hypeCalc.volumeData.get(ticker) || [];
  const historicalData = hypeCalc.historicalData.get(ticker) || {};
  const baseline = hypeCalc.calculateWeightedBaseline(ticker);
  const priceChange60 = hypeCalc.getPriceChange(ticker, 60);
  const latestVolume = hypeCalc.getLatestVolume(ticker);
  
  res.json({
    ticker,
    currentData: {
      latestVolume,
      priceChange60min: priceChange60,
      baseline: baseline
    },
    priceHistory: {
      count: priceHistory.length,
      snapshots: priceHistory.slice(-10).map(p => ({
        time: new Date(p.timestamp).toLocaleTimeString(),
        price: p.price,
        previousClose: p.previousClose,
        volume: p.volume,
        source: p.volumeSource
      }))
    },
    volumeData: {
      count: volumeData.length,
      recent: volumeData.slice(-10).map(v => ({
        time: new Date(v.timestamp).toLocaleTimeString(),
        volume: v.volume,
        source: v.source
      }))
    },
    historicalData: {
      hourlyCount: historicalData.hourly?.length || 0,
      dailyCount: historicalData.daily?.length || 0,
      lastHourlyUpdate: historicalData.lastHourlyUpdate ? new Date(historicalData.lastHourlyUpdate).toISOString() : null,
      lastDailyUpdate: historicalData.lastDailyUpdate ? new Date(historicalData.lastDailyUpdate).toISOString() : null
    }
  });
});

// Default route
app.get('/', (req, res) => {
  const stats = hypeCalc.getStats();
  res.json({
    message: 'HypeMeter.ai v2.6 - Complete Volume & Price Fix',
    version: '2.6.0',
    status: 'running',
    features: [
      '✅ Initial data collection on startup',
      '✅ 5-strategy volume collection (daily→5min→hourly→previous→yahoo)',
      '✅ PreviousClose stored for immediate price changes',
      '✅ Separate volume tracking system',
      '✅ Yahoo Finance fallback',
      '✅ Enhanced diagnostics and debug endpoint',
      '✅ 30-day price persistence',
      '✅ Proper data flow from collection to API'
    ],
    ...stats,
    endpoints: {
      health: '/health',
      keepalive: '/keepalive',
      mentions: '/api/mentions?tickers=NVDA,AAPL&window=60',
      quotes: '/api/quotes?tickers=NVDA,AAPL',
      hype: '/api/hype?tickers=NVDA,AAPL&window=60',
      debug: '/api/debug/NVDA'
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
      console.log('💓 Keep-alive ping sent and data saved');
    } catch (error) {
      console.error('Keep-alive failed:', error.message);
    }
  }, 14 * 60 * 1000);
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n💾 Saving data before shutdown...');
  await hypeCalc.saveHistoricalData();
  console.log('✅ Shutdown complete');
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🚀 HypeMeter.ai v2.6 - Complete Volume & Price Tracking Fix`);
  console.log(`${'='.repeat(80)}\n`);
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`💰 Price history with previousClose tracking`);
  console.log(`📊 5-strategy volume collection (daily→5min→hourly→previous→yahoo)`);
  console.log(`🔍 Enhanced diagnostics and debug endpoint`);
  console.log(`\n🎯 Key Fixes Applied:`);
  console.log(`   • Initial data collection on startup for immediate availability`);
  console.log(`   • PreviousClose stored for instant price change calculations`);
  console.log(`   • Separate volume tracking system`);
  console.log(`   • Yahoo Finance fallback when Finnhub fails`);
  console.log(`   • Proper data flow from collection to API response`);
  console.log(`   • Daily candles prioritized (most reliable for volume)`);
  console.log(`\n${'='.repeat(80)}\n`);
  
  if (process.env.FINNHUB_API_KEY) {
    console.log('✅ Finnhub API Key configured');
    
    // RUN INITIAL DATA COLLECTION
    const initialTickers = ['NVDA', 'AAPL', 'TSLA', 'MSFT', 'GOOGL', 'AMC', 'GME', 'SPY'];
    await hypeCalc.collectInitialData(initialTickers);
    
  } else {
    console.log('❌ WARNING: FINNHUB_API_KEY not set - price/volume features will not work!');
  }
});
