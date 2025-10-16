const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const { BskyAgent } = require('@atproto/api');
const app = express();

// Persistent storage manager
class PersistentStorage {
  constructor() {
    this.dataPath = process.env.DATA_PATH || '/tmp';
    this.mentionEventsFile = path.join(this.dataPath, 'mention_events.json');
    this.priceHistoryFile = path.join(this.dataPath, 'price_history.json');
    this.aiWeightsFile = path.join(this.dataPath, 'ai_weights.json');
    this.aiInsightsFile = path.join(this.dataPath, 'ai_insights.json');
  }

  async ensureDataDir() {
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      console.log(`📁 Data directory ready: ${this.dataPath}`);
    } catch (e) {
      console.error(`❌ Failed to create data directory: ${e.message}`);
    }
  }

  async saveData(filename, data) {
    await this.ensureDataDir();
    const filepath = path.join(this.dataPath, filename);
    await fs.writeFile(filepath, JSON.stringify(data, null, 2));
    const stats = await fs.stat(filepath);
    console.log(`  💾 Saved ${filename}: ${(stats.size / 1024).toFixed(1)} KB`);
  }

  async loadData(filename) {
    try {
      const filepath = path.join(this.dataPath, filename);
      const data = await fs.readFile(filepath, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      return null;
    }
  }

  async saveMentionEvents(data) {
    await this.saveData('mention_events.json', data);
  }

  async loadMentionEvents() {
    return await this.loadData('mention_events.json') || {};
  }

  async savePriceHistory(data) {
    await this.saveData('price_history.json', data);
  }

  async loadPriceHistory() {
    return await this.loadData('price_history.json') || {};
  }

  async saveAIWeights(data) {
    await this.saveData('ai_weights.json', data);
  }

  async loadAIWeights() {
    return await this.loadData('ai_weights.json') || {};
  }

  async saveAIInsights(data) {
    await this.saveData('ai_insights.json', data);
  }

  async loadAIInsights() {
    return await this.loadData('ai_insights.json') || [];
  }
}

// AI-Powered Hype Calculator
class AIHypeCalculator {
  constructor() {
    this.storage = new PersistentStorage();
    this.mentionEvents = new Map();
    this.priceHistory = new Map();
    this.aiWeights = new Map();
    this.aiInsights = [];
    this.analysisCount = 0;
    this.useClaudeEvery = 50; // Use Claude every 50 analyses
    
    this.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    this.claudeAvailable = !!this.anthropicApiKey;
  }

  async init() {
    console.log('\n🤖 Initializing AI-Powered Hype Calculator...\n');
    
    // Load persistent data
    const [mentionData, priceData, weightsData, insightsData] = await Promise.all([
      this.storage.loadMentionEvents(),
      this.storage.loadPriceHistory(),
      this.storage.loadAIWeights(),
      this.storage.loadAIInsights()
    ]);

    // Restore to Maps
    for (const [ticker, events] of Object.entries(mentionData)) {
      this.mentionEvents.set(ticker, events);
    }
    for (const [ticker, history] of Object.entries(priceData)) {
      this.priceHistory.set(ticker, history);
    }
    for (const [ticker, weights] of Object.entries(weightsData)) {
      this.aiWeights.set(ticker, weights);
    }
    this.aiInsights = insightsData;

    const eventCount = Array.from(this.mentionEvents.values()).reduce((sum, e) => sum + e.length, 0);
    const priceCount = Array.from(this.priceHistory.values()).reduce((sum, h) => sum + h.length, 0);
    
    console.log(`📂 Loaded ${this.mentionEvents.size} tickers from storage`);
    console.log(`📊 Total mention events: ${eventCount.toLocaleString()}`);
    console.log(`💰 Total price snapshots: ${priceCount.toLocaleString()}`);
    console.log(`🧠 AI insights: ${this.aiInsights.length}`);
    console.log(`🤖 Claude API: ${this.claudeAvailable ? '✓ Available' : '✗ Not configured'}\n`);
  }

  async persistData() {
    console.log(`\n💾 Persisting data to disk...`);
    
    try {
      const mentionData = Object.fromEntries(this.mentionEvents);
      const priceData = Object.fromEntries(this.priceHistory);
      const weightsData = Object.fromEntries(this.aiWeights);

      await Promise.all([
        this.storage.saveMentionEvents(mentionData),
        this.storage.savePriceHistory(priceData),
        this.storage.saveAIWeights(weightsData),
        this.storage.saveAIInsights(this.aiInsights.slice(-100)) // Keep last 100 insights
      ]);

      console.log(`✅ Data persisted successfully\n`);
    } catch (error) {
      console.error(`❌ Failed to persist data: ${error.message}\n`);
    }
  }

  // Market hours detection
  isMarketOpen() {
    const now = new Date();
    const utcDay = now.getUTCDay();
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    
    if (utcDay === 0 || utcDay === 6) return false;
    
    const utcTime = utcHours + utcMinutes / 60;
    return utcTime >= 14.5 && utcTime < 21;
  }

  // Record mention event
  recordMentionEvent(ticker, source, count = 1) {
    if (!this.mentionEvents.has(ticker)) {
      this.mentionEvents.set(ticker, []);
    }
    
    const events = this.mentionEvents.get(ticker);
    for (let i = 0; i < count; i++) {
      events.push({
        timestamp: Date.now(),
        source
      });
    }

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

  // Get mentions in window
  getMentionsInWindow(ticker, windowMinutes, source = null) {
    const events = this.mentionEvents.get(ticker);
    if (!events || events.length === 0) return 0;
    
    const windowMs = windowMinutes * 60 * 1000;
    const cutoffTime = Date.now() - windowMs;
    
    return events.filter(e => {
      const inWindow = e.timestamp > cutoffTime;
      const matchesSource = !source || e.source === source;
      return inWindow && matchesSource;
    }).length;
  }

  // Get price change for window
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
        currentVolume: currentSnapshot.volume,
        oldPrice: oldSnapshot.price
      };
    }

    return null;
  }

  // Get 24-hour change (for when market closed)
  get24HourChange(ticker) {
    const history = this.priceHistory.get(ticker);
    if (!history || history.length < 2) return null;
    
    const latest = history[history.length - 1];
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    
    // Find snapshot closest to 24 hours ago
    let oldSnapshot = history[0];
    let minDiff = Math.abs(history[0].timestamp - oneDayAgo);
    
    for (const snapshot of history) {
      const diff = Math.abs(snapshot.timestamp - oneDayAgo);
      if (diff < minDiff) {
        minDiff = diff;
        oldSnapshot = snapshot;
      }
    }
    
    if (oldSnapshot.price > 0 && latest.price > 0) {
      return {
        change: latest.price - oldSnapshot.price,
        changePercent: ((latest.price - oldSnapshot.price) / oldSnapshot.price) * 100,
        currentPrice: latest.price,
        currentVolume: latest.volume,
        label: '24h Change'
      };
    }
    
    return null;
  }

  // Calculate baseline hype score (fallback when AI not available)
  calculateBaselineHype(ticker, data) {
    const { reddit, stocktwits, bluesky, news, volume, priceChangePercent } = data;
    
    // Simple logarithmic scaling
    let score = 0;
    
    if (reddit > 0) score += Math.min(Math.log10(reddit + 1) * 20, 30);
    if (stocktwits > 0) score += Math.min(Math.log10(stocktwits + 1) * 15, 20);
    if (bluesky > 0) score += Math.min(Math.log10(bluesky + 1) * 10, 15);
    if (news > 0) score += Math.min(news * 5, 15);
    if (volume > 0) score += Math.min(Math.log10(volume / 1000000 + 1) * 10, 15);
    if (priceChangePercent) score += Math.min(Math.abs(priceChangePercent) * 2, 10);
    
    return Math.min(Math.round(score), 100);
  }

  // Ask Claude AI for intelligent analysis
  async calculateWithClaude(ticker, data) {
    if (!this.claudeAvailable) {
      return null;
    }

    try {
      const historicalData = {
        mentionEvents: this.mentionEvents.get(ticker)?.slice(-50) || [],
        priceHistory: this.priceHistory.get(ticker)?.slice(-20) || [],
        previousWeights: this.aiWeights.get(ticker) || null
      };

      const recentInsights = this.aiInsights.slice(-5);

      const prompt = `You are an expert financial AI analyzing stock market hype. Calculate a hype score (0-100) for ${ticker}.

**Current Data (last hour):**
- Reddit mentions: ${data.reddit}
- StockTwits mentions: ${data.stocktwits}
- Bluesky mentions: ${data.bluesky}
- News articles: ${data.news}
- Trading volume: ${data.volume?.toLocaleString() || 'N/A'}
- Price change: ${data.priceChangePercent?.toFixed(2)}%
- Time: ${new Date().toLocaleString()}
- Market: ${data.marketOpen ? 'OPEN' : 'CLOSED'}

**Historical Context:**
Recent mention events: ${historicalData.mentionEvents.length}
Recent price snapshots: ${historicalData.priceHistory.length}

**Recent AI Insights:**
${JSON.stringify(recentInsights, null, 2)}

**Your Task:**
1. Analyze all data sources for unusual patterns
2. Detect potential anomalies (bots, manipulation, genuine interest)
3. Consider market conditions and time of day
4. Assign dynamic weights to each data source (must sum to 1.0)
5. Calculate a hype score (0-100) with confidence level

**Return ONLY valid JSON** (no markdown, no code blocks):
{
  "hypeScore": 0-100,
  "confidence": 0-100,
  "reasoning": "brief explanation",
  "keyFactors": ["most important factor", "second factor"],
  "weights": {
    "reddit": 0.0-1.0,
    "stocktwits": 0.0-1.0,
    "bluesky": 0.0-1.0,
    "news": 0.0-1.0,
    "volume": 0.0-1.0,
    "price": 0.0-1.0
  },
  "anomalies": ["detected issue 1", "detected issue 2"],
  "recommendation": "high hype / moderate / low / suspicious"
}`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: prompt
          }]
        })
      });

      if (!response.ok) {
        throw new Error(`Claude API error: ${response.status}`);
      }

      const result = await response.json();
      const text = result.content[0].text;
      
      // Clean up response (remove markdown if present)
      const cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const analysis = JSON.parse(cleanText);

      // Store insight
      this.aiInsights.push({
        timestamp: Date.now(),
        ticker,
        analysis
      });

      // Keep only last 100 insights
      if (this.aiInsights.length > 100) {
        this.aiInsights = this.aiInsights.slice(-100);
      }

      // Store learned weights
      this.aiWeights.set(ticker, analysis.weights);

      console.log(`  🧠 Claude analysis for ${ticker}:`);
      console.log(`     Score: ${analysis.hypeScore} (${analysis.confidence}% confidence)`);
      console.log(`     Reasoning: ${analysis.reasoning}`);

      return analysis;
    } catch (error) {
      console.error(`  ❌ Claude AI error: ${error.message}`);
      return null;
    }
  }

  // Calculate hype using learned weights or fallback
  async calculateHype(ticker, data) {
    this.analysisCount++;

    // Every Nth analysis, use Claude for deep intelligence
    const shouldUseClaude = this.claudeAvailable && (this.analysisCount % this.useClaudeEvery === 0);

    if (shouldUseClaude) {
      const claudeAnalysis = await this.calculateWithClaude(ticker, data);
      if (claudeAnalysis) {
        return {
          hypeScore: claudeAnalysis.hypeScore,
          confidence: claudeAnalysis.confidence,
          reasoning: claudeAnalysis.reasoning,
          keyFactors: claudeAnalysis.keyFactors,
          weights: claudeAnalysis.weights,
          anomalies: claudeAnalysis.anomalies,
          mode: 'claude-ai',
          recommendation: claudeAnalysis.recommendation
        };
      }
    }

    // Use learned weights if available
    const learnedWeights = this.aiWeights.get(ticker);
    
    if (learnedWeights) {
      // Apply learned weights
      let score = 0;
      score += (data.reddit || 0) * learnedWeights.reddit * 50;
      score += (data.stocktwits || 0) * learnedWeights.stocktwits * 50;
      score += (data.bluesky || 0) * learnedWeights.bluesky * 50;
      score += (data.news || 0) * learnedWeights.news * 50;
      score += Math.log10((data.volume || 0) / 1000000 + 1) * learnedWeights.volume * 30;
      score += Math.abs(data.priceChangePercent || 0) * learnedWeights.price * 5;

      return {
        hypeScore: Math.min(Math.round(score), 100),
        confidence: 75,
        weights: learnedWeights,
        mode: 'learned-weights',
        reasoning: 'Using AI-learned weights from previous analyses'
      };
    }

    // Fallback to baseline
    return {
      hypeScore: this.calculateBaselineHype(ticker, data),
      confidence: 50,
      weights: null,
      mode: 'baseline',
      reasoning: 'Using baseline algorithm, AI learning in progress'
    };
  }
}

// Background data collector
class BackgroundCollector {
  constructor() {
    this.aiCalc = new AIHypeCalculator();
    this.cache = new Map();
    this.CACHE_TTL = 5 * 60 * 1000;
    
    // Reddit OAuth
    this.redditToken = null;
    this.redditTokenExpiry = 0;
    this.redditWorking = false;
    
    // Bluesky
    this.blueskyAgent = null;
    this.blueskyWorking = false;
    
    this.trackedTickers = new Set([
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'NVDA', 'META', 'AMD',
      'GME', 'AMC', 'SPY', 'QQQ', 'COIN', 'NFLX', 'PLTR', 'MSTR', 'SOFI'
    ]);
  }

  async init() {
    await this.aiCalc.init();
    await this.initBluesky();
  }

  async initBluesky() {
    const username = process.env.BLUESKY_USERNAME;
    const password = process.env.BLUESKY_PASSWORD;
    
    if (!username || !password) {
      this.blueskyWorking = false;
      return;
    }

    try {
      this.blueskyAgent = new BskyAgent({ service: 'https://bsky.social' });
      await this.blueskyAgent.login({ identifier: username, password: password });
      this.blueskyWorking = true;
      console.log(`✅ Bluesky authenticated: ${username}`);
    } catch (e) {
      this.blueskyWorking = false;
      console.log(`❌ Bluesky authentication failed`);
    }
  }

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
          'User-Agent': 'HypeMeter/5.2-AI'
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
      console.error(`Reddit OAuth error: ${e.message}`);
    }
    
    this.redditWorking = false;
    return null;
  }

  // Collect from 20+ Reddit subreddits
  async collectReddit(ticker, windowMinutes) {
    const token = await this.getRedditToken();
    if (!token) return 0;

    const subreddits = [
      // Tier 1 - High volume
      'wallstreetbets', 'stocks', 'investing', 'stockmarket', 'options',
      // Tier 2 - Active trading
      'Daytrading', 'SwingTrading', 'thetagang', 'pennystocks', 'RobinHood',
      // Tier 3 - Analysis
      'SecurityAnalysis', 'ValueInvesting', 'investing_discussion', 
      'Stock_Picks', 'StockMarketChat',
      // Tier 4 - Specialized
      'UnusualOptions', 'Shortsqueeze', 'SPACs', 'algotrading',
      // Tier 5 - Crypto (for COIN, MSTR)
      'CryptoCurrency', 'Bitcoin'
    ];
    
    let totalMentions = 0;
    const windowMs = windowMinutes * 60 * 1000;
    const cutoffTime = Date.now() - windowMs;
    
    for (const sub of subreddits) {
      try {
        const url = `https://oauth.reddit.com/r/${sub}/new?limit=100`;
        
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'HypeMeter/5.2-AI'
          }
        });

        if (response.ok) {
          const data = await response.json();
          
          if (data?.data?.children) {
            for (const post of data.data.children) {
              const postTime = post.data.created_utc * 1000;
              
              if (postTime < cutoffTime) continue;
              
              const title = (post.data.title || '').toUpperCase();
              const text = (post.data.selftext || '').toUpperCase();
              const combined = `${title} ${text}`;
              
              const patterns = [
                new RegExp(`\\$${ticker}\\b`, 'gi'),
                new RegExp(`\\b${ticker}\\b`, 'gi')
              ];
              
              patterns.forEach(p => {
                const matches = (combined.match(p) || []).length;
                totalMentions += matches;
                
                // Record individual events
                for (let i = 0; i < matches; i++) {
                  this.aiCalc.recordMentionEvent(ticker, 'reddit');
                }
              });
            }
          }
        }
        
        // Rate limiting: 400ms between subreddit searches
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        // Silent fail, continue with other subs
      }
    }
    
    return totalMentions;
  }

  // Collect from Bluesky with multiple search strategies
  async collectBluesky(ticker, windowMinutes) {
    if (!this.blueskyAgent || !this.blueskyWorking) {
      return 0;
    }

    try {
      const searches = [
        `$${ticker}`,
        `${ticker} stock`,
        `#${ticker}`,
        `${ticker} trading`
      ];
      
      const windowMs = windowMinutes * 60 * 1000;
      const cutoffTime = Date.now() - windowMs;
      const seenPosts = new Set();
      let totalMentions = 0;
      
      for (const query of searches) {
        const result = await this.blueskyAgent.api.app.bsky.feed.searchPosts({
          q: query,
          limit: 100
        });
        
        if (result.data?.posts) {
          result.data.posts.forEach(post => {
            const postId = post.uri;
            if (seenPosts.has(postId)) return; // Dedupe
            
            const postTime = new Date(post.indexedAt).getTime();
            if (postTime < cutoffTime) return;
            
            seenPosts.add(postId);
            totalMentions++;
            this.aiCalc.recordMentionEvent(ticker, 'bluesky');
          });
        }
        
        await new Promise(r => setTimeout(r, 300));
      }
      
      return totalMentions;
    } catch (e) {
      return 0;
    }
  }

  // Collect from StockTwits
  async collectStocktwits(ticker, windowMinutes) {
    try {
      const response = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`);
      
      if (!response.ok) return 0;
      
      const data = await response.json();
      const windowMs = windowMinutes * 60 * 1000;
      const cutoffTime = Date.now() - windowMs;
      let mentions = 0;
      
      if (data.messages) {
        data.messages.forEach(m => {
          const messageTime = new Date(m.created_at).getTime();
          
          if (messageTime > cutoffTime) {
            mentions++;
            this.aiCalc.recordMentionEvent(ticker, 'stocktwits');
          }
        });
      }
      
      return mentions;
    } catch (e) {
      return 0;
    }
  }

  // Collect news from Finnhub
  async collectNews(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return 0;
    
    try {
      const today = new Date();
      const weekAgo = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000));
      
      const toDate = today.toISOString().split('T')[0];
      const fromDate = weekAgo.toISOString().split('T')[0];
      
      const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${fromDate}&to=${toDate}&token=${apiKey}`;
      
      const response = await fetch(url);
      const news = await response.json();
      
      if (Array.isArray(news)) {
        const recentNews = news.filter(article => {
          const articleTime = article.datetime * 1000;
          const oneHourAgo = Date.now() - (60 * 60 * 1000);
          return articleTime > oneHourAgo;
        });
        
        // Record news events
        recentNews.forEach(() => {
          this.aiCalc.recordMentionEvent(ticker, 'news');
        });
        
        return recentNews.length;
      }
    } catch (e) {}
    return 0;
  }

  // Collect price data with volume
  async collectPriceData(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return null;
    
    try {
      // Get current price
      const quoteRes = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`
      );
      const quote = await quoteRes.json();
      
      if (!quote.c) return null;
      
      // Get volume from candle
      const to = Math.floor(Date.now() / 1000);
      const from = to - 3600;
      
      const candleRes = await fetch(
        `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=5&from=${from}&to=${to}&token=${apiKey}`
      );
      const candle = await candleRes.json();
      
      let volume = 0;
      if (candle.s === 'ok' && candle.v?.length > 0) {
        volume = candle.v.reduce((sum, v) => sum + (v || 0), 0);
      }
      
      // Record in history
      this.aiCalc.recordPrice(ticker, quote.c, volume);
      
      return {
        price: quote.c,
        previousClose: quote.pc || quote.c,
        volume: volume
      };
      
    } catch (e) {
      console.error(`Price data error for ${ticker}: ${e.message}`);
      return null;
    }
  }

  // Collect all data for a ticker
  async collectTicker(ticker, windowMinutes = 60) {
    console.log(`🔄 ${ticker}...`);
    
    const [reddit, bluesky, stocktwits, news, priceData] = await Promise.all([
      this.collectReddit(ticker, windowMinutes),
      this.collectBluesky(ticker, windowMinutes),
      this.collectStocktwits(ticker, windowMinutes),
      this.collectNews(ticker),
      this.collectPriceData(ticker)
    ]);
    
    // Get price change
    let priceChange = this.aiCalc.getPriceChange(ticker, windowMinutes);
    
    // If market closed, show 24h change
    if (!priceChange && !this.aiCalc.isMarketOpen()) {
      priceChange = this.aiCalc.get24HourChange(ticker);
    }
    
    // Calculate AI hype score
    const hypeResult = await this.aiCalc.calculateHype(ticker, {
      reddit,
      stocktwits,
      bluesky,
      news,
      volume: priceData?.volume || 0,
      priceChangePercent: priceChange?.changePercent || 0,
      marketOpen: this.aiCalc.isMarketOpen()
    });
    
    const marketStatus = this.aiCalc.isMarketOpen() ? '🟢' : '🔴';
    const modeIcon = hypeResult.mode === 'claude-ai' ? '🧠' : hypeResult.mode === 'learned-weights' ? '🎯' : '📊';
    
    console.log(`  ${marketStatus} ${modeIcon} ${ticker}: Score ${hypeResult.hypeScore} | R:${reddit} ST:${stocktwits} B:${bluesky} N:${news} | ${hypeResult.mode}`);
    
    // Cache the result
    this.cache.set(`${ticker}_${windowMinutes}`, {
      ticker,
      reddit_mentions: reddit,
      stocktwits_mentions: stocktwits,
      bluesky_mentions: bluesky,
      news_count: news,
      hypeScore: hypeResult.hypeScore,
      confidence: hypeResult.confidence,
      reasoning: hypeResult.reasoning,
      keyFactors: hypeResult.keyFactors,
      weights: hypeResult.weights,
      anomalies: hypeResult.anomalies,
      mode: hypeResult.mode,
      recommendation: hypeResult.recommendation,
      priceData,
      priceChange,
      timestamp: Date.now()
    });
    
    return this.cache.get(`${ticker}_${windowMinutes}`);
  }

  // Background collection loop
  async startCollection() {
    console.log(`\n🚀 HypeMeter v5.2 - AI-Powered Self-Learning System`);
    console.log(`📊 Tracking ${this.trackedTickers.size} tickers`);
    console.log(`🤖 AI Mode: ${this.aiCalc.claudeAvailable ? 'Claude API Enabled' : 'Local Learning Only'}\n`);
    
    // Initial collection
    await this.collectAll();
    
    // Then every 5 minutes
    setInterval(async () => {
      await this.collectAll();
    }, 5 * 60 * 1000);
    
    // Save data every 5 minutes
    setInterval(async () => {
      await this.aiCalc.persistData();
    }, 5 * 60 * 1000);
  }

  async collectAll() {
    const time = new Date().toLocaleTimeString();
    const marketStatus = this.aiCalc.isMarketOpen() ? '🟢 MARKET OPEN' : '🔴 MARKET CLOSED';
    console.log(`\n⏰ ${time} | ${marketStatus}\n`);
    
    for (const ticker of this.trackedTickers) {
      await this.collectTicker(ticker, 60);
      // 1 second delay between tickers to avoid rate limiting
      await new Promise(r => setTimeout(r, 1000));
    }
    
    const sources = [];
    if (this.redditWorking) sources.push('Reddit');
    if (this.blueskyWorking) sources.push('Bluesky');
    sources.push('StockTwits', 'News');
    
    console.log(`\n✅ Collection complete | Sources: ${sources.join(', ')}\n`);
  }

  addTicker(ticker) {
    if (!this.trackedTickers.has(ticker)) {
      this.trackedTickers.add(ticker);
      console.log(`➕ Added ${ticker} to tracking`);
    }
  }

  getCachedData(ticker, windowMinutes) {
    const key = `${ticker}_${windowMinutes}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
      return cached;
    }
    return null;
  }

  getStats() {
    return {
      version: '5.2.0-ai',
      tracked: this.trackedTickers.size,
      mention_events: Array.from(this.aiCalc.mentionEvents.values()).reduce((sum, e) => sum + e.length, 0),
      price_snapshots: Array.from(this.aiCalc.priceHistory.values()).reduce((sum, h) => sum + h.length, 0),
      ai_insights: this.aiCalc.aiInsights.length,
      ai_weights_learned: this.aiCalc.aiWeights.size,
      market_open: this.aiCalc.isMarketOpen(),
      sources: {
        reddit: this.redditWorking,
        bluesky: this.blueskyWorking,
        stocktwits: true,
        news: true,
        claude_ai: this.aiCalc.claudeAvailable
      }
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

// Main hype endpoint (uses cached data from background collection)
app.get('/api/hype', async (req, res) => {
  try {
    const { tickers, window = 60 } = req.query;
    if (!tickers) return res.status(400).json({ error: 'Tickers required' });

    const windowMinutes = parseInt(window);
    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = {};
    
    for (const ticker of tickerList) {
      // Add to tracking if not already tracked
      collector.addTicker(ticker);
      
      // Try to get cached data first (instant response)
      let data = collector.getCachedData(ticker, windowMinutes);
      
      // If not cached, collect now (slower but ensures fresh data)
      if (!data) {
        console.log(`📥 On-demand collection for ${ticker}`);
        data = await collector.collectTicker(ticker, windowMinutes);
      }
      
      results[ticker] = {
        symbol: ticker,
        hypeScore: data.hypeScore || 0,
        confidence: data.confidence || 50,
        mentions: (data.reddit_mentions || 0) + (data.stocktwits_mentions || 0) + (data.bluesky_mentions || 0) + (data.news_count || 0),
        reddit_mentions: data.reddit_mentions || 0,
        stocktwits_mentions: data.stocktwits_mentions || 0,
        bluesky_mentions: data.bluesky_mentions || 0,
        news_count: data.news_count || 0,
        price: data.priceData?.price || null,
        change: data.priceChange?.change || null,
        changePercent: data.priceChange?.changePercent || null,
        changeLabel: data.priceChange?.label || null,
        volume: data.priceData?.volume || 0,
        name: ticker,
        mode: data.mode || 'baseline',
        reasoning: data.reasoning,
        weights: data.weights,
        recommendation: data.recommendation,
        timestamp: new Date().toISOString()
      };
    }
    
    res.json(results);
  } catch (error) {
    console.error('Hype error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint with AI insights
app.get('/api/debug/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const windowMinutes = parseInt(req.query.window) || 60;
  
  const mentionEvents = collector.aiCalc.mentionEvents.get(ticker) || [];
  const priceHistory = collector.aiCalc.priceHistory.get(ticker) || [];
  const weights = collector.aiCalc.aiWeights.get(ticker) || null;
  
  // Get insights about this ticker
  const tickerInsights = collector.aiCalc.aiInsights.filter(i => i.ticker === ticker).slice(-5);
  
  // Calculate current metrics
  const currentMentions = collector.aiCalc.getMentionsInWindow(ticker, windowMinutes);
  const redditMentions = collector.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'reddit');
  const stocktwitsMentions = collector.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'stocktwits');
  const blueskyMentions = collector.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'bluesky');
  const newsMentions = collector.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'news');
  const priceChange = collector.aiCalc.getPriceChange(ticker, windowMinutes);
  
  res.json({
    ticker,
    window: windowMinutes,
    mentionEvents: {
      total: mentionEvents.length,
      inWindow: currentMentions,
      breakdown: {
        reddit: redditMentions,
        stocktwits: stocktwitsMentions,
        bluesky: blueskyMentions,
        news: newsMentions
      },
      oldest: mentionEvents.length > 0 ? new Date(mentionEvents[0].timestamp).toISOString() : null,
      newest: mentionEvents.length > 0 ? new Date(mentionEvents[mentionEvents.length - 1].timestamp).toISOString() : null
    },
    priceHistory: {
      total: priceHistory.length,
      oldest: priceHistory.length > 0 ? new Date(priceHistory[0].timestamp).toISOString() : null,
      newest: priceHistory.length > 0 ? new Date(priceHistory[priceHistory.length - 1].timestamp).toISOString() : null,
      latestPrice: priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].price : null,
      latestVolume: priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].volume : null
    },
    aiWeights: weights,
    aiInsights: tickerInsights.map(i => ({
      timestamp: new Date(i.timestamp).toISOString(),
      score: i.analysis.hypeScore,
      confidence: i.analysis.confidence,
      reasoning: i.analysis.reasoning,
      weights: i.analysis.weights
    })),
    currentMetrics: {
      mentions: currentMentions,
      priceChange: priceChange
    },
    marketOpen: collector.aiCalc.isMarketOpen(),
    totalAIInsights: collector.aiCalc.aiInsights.length,
    totalLearnedWeights: collector.aiCalc.aiWeights.size
  });
});

// AI insights endpoint
app.get('/api/ai/insights', (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const recentInsights = collector.aiCalc.aiInsights.slice(-limit).map(i => ({
    timestamp: new Date(i.timestamp).toISOString(),
    ticker: i.ticker,
    score: i.analysis.hypeScore,
    confidence: i.analysis.confidence,
    reasoning: i.analysis.reasoning,
    keyFactors: i.analysis.keyFactors,
    anomalies: i.analysis.anomalies,
    recommendation: i.analysis.recommendation
  }));
  
  res.json({
    total_insights: collector.aiCalc.aiInsights.length,
    learned_weights: collector.aiCalc.aiWeights.size,
    recent: recentInsights
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'HypeMeter.ai v5.2 - AI-Powered Self-Learning System',
    version: '5.2.0-ai',
    status: 'running',
    features: [
      '🤖 AI-powered dynamic weighting (no static formulas)',
      '🧠 Claude API for deep intelligence analysis',
      '🎯 Self-learning from patterns and outcomes',
      '📊 Background collection (instant API responses)',
      '🔍 20+ Reddit subreddits coverage',
      '🐦 Enhanced Bluesky multi-query search',
      '📰 Finnhub news integration',
      '💰 Volume working (Finnhub Candle API)',
      '⏰ 24-hour price change when market closed',
      '💾 30-day persistent storage with AI weights',
      '🚨 Anomaly detection (bots, manipulation)',
      '📈 Confidence scores and reasoning'
    ],
    endpoints: {
      health: '/health',
      hype: '/api/hype?tickers=NVDA,AAPL&window=60',
      debug: '/api/debug/NVDA?window=60',
      ai_insights: '/api/ai/insights?limit=10'
    }
  });
});

app.get('/keepalive', (req, res) => {
  res.json({ alive: true, timestamp: new Date().toISOString() });
});

// Auto-persist and keep-alive
if (process.env.NODE_ENV === 'production') {
  setInterval(async () => {
    try {
      const url = process.env.RENDER_EXTERNAL_URL || 'https://hypemeter.onrender.com';
      await fetch(`${url}/keepalive`);
      console.log('💓 Keep-alive ping sent');
    } catch (error) {
      console.error('Keep-alive failed:', error.message);
    }
  }, 14 * 60 * 1000);
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n💾 Saving AI data before shutdown...');
  await collector.aiCalc.persistData();
  console.log('✅ Shutdown complete\n');
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🚀 HypeMeter.ai v5.2 - AI-Powered Self-Learning System`);
  console.log(`${'='.repeat(80)}\n`);
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`\n🔧 Configuration:`);
  console.log(`   Data path: ${process.env.DATA_PATH || '/tmp'}`);
  console.log(`   Finnhub API: ${process.env.FINNHUB_API_KEY ? '✓' : '✗'}`);
  console.log(`   Reddit OAuth: ${process.env.REDDIT_CLIENT_ID ? '✓' : '✗'}`);
  console.log(`   Bluesky Auth: ${process.env.BLUESKY_USERNAME ? '✓' : '✗'}`);
  console.log(`   Claude AI: ${process.env.ANTHROPIC_API_KEY ? '✓ Enabled' : '✗ Disabled (optional)'}`);
  console.log(`\n🎯 Features:`);
  console.log(`   🤖 Zero static weights - AI learns optimal combinations`);
  console.log(`   🧠 Claude API analyzes every 50th request for deep insights`);
  console.log(`   🎯 Learned weights applied to remaining requests`);
  console.log(`   📊 Background collection every 5 minutes (instant API)`);
  console.log(`   🔍 20+ Reddit subreddits for maximum coverage`);
  console.log(`   🐦 Enhanced Bluesky with 4 search strategies`);
  console.log(`   📰 Finnhub company news integration`);
  console.log(`   💰 Volume from Finnhub Candle API`);
  console.log(`   💾 Persistent storage: data + AI weights + insights`);
  console.log(`\n${'='.repeat(80)}\n`);
  
  await collector.init();
  await collector.startCollection();
});
