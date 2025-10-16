npm install -g @anthropic-ai/claude-code

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
    this.useClaudeEvery = 50;
    
    this.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    this.claudeAvailable = !!this.anthropicApiKey;
  }

  async init() {
    console.log('\n🤖 Initializing AI-Powered Hype Calculator...\n');
    
    const [mentionData, priceData, weightsData, insightsData] = await Promise.all([
      this.storage.loadMentionEvents(),
      this.storage.loadPriceHistory(),
      this.storage.loadAIWeights(),
      this.storage.loadAIInsights()
    ]);

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
        this.storage.saveAIInsights(this.aiInsights.slice(-100))
      ]);

      console.log(`✅ Data persisted successfully\n`);
    } catch (error) {
      console.error(`❌ Failed to persist data: ${error.message}\n`);
    }
  }

  isMarketOpen() {
    const now = new Date();
    const utcDay = now.getUTCDay();
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    
    if (utcDay === 0 || utcDay === 6) return false;
    
    const utcTime = utcHours + utcMinutes / 60;
    return utcTime >= 14.5 && utcTime < 21;
  }

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

    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    this.mentionEvents.set(
      ticker,
      events.filter(e => e.timestamp > thirtyDaysAgo)
    );
  }

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

    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    this.priceHistory.set(
      ticker,
      history.filter(h => h.timestamp > thirtyDaysAgo)
    );
  }

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

  getPriceChange(ticker, windowMinutes) {
    const history = this.priceHistory.get(ticker);
    if (!history || history.length < 2) return null;

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

  get24HourChange(ticker) {
    const history = this.priceHistory.get(ticker);
    if (!history || history.length < 2) return null;
    
    const latest = history[history.length - 1];
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    
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

  calculateBaselineHype(ticker, data) {
    const { reddit, stocktwits, bluesky, news, volume, priceChangePercent } = data;
    
    let score = 0;
    
    if (reddit > 0) score += Math.min(Math.log10(reddit + 1) * 20, 30);
    if (stocktwits > 0) score += Math.min(Math.log10(stocktwits + 1) * 15, 20);
    if (bluesky > 0) score += Math.min(Math.log10(bluesky + 1) * 10, 15);
    if (news > 0) score += Math.min(news * 5, 15);
    if (volume > 0) score += Math.min(Math.log10(volume / 1000000 + 1) * 10, 15);
    if (priceChangePercent) score += Math.min(Math.abs(priceChangePercent) * 2, 10);
    
    return Math.min(Math.round(score), 100);
  }

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
      
      const cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const analysis = JSON.parse(cleanText);

      this.aiInsights.push({
        timestamp: Date.now(),
        ticker,
        analysis
      });

      if (this.aiInsights.length > 100) {
        this.aiInsights = this.aiInsights.slice(-100);
      }

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

  async calculateHype(ticker, data) {
    this.analysisCount++;

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

    const learnedWeights = this.aiWeights.get(ticker);
    
    if (learnedWeights) {
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

    return {
      hypeScore: this.calculateBaselineHype(ticker, data),
      confidence: 50,
      weights: null,
      mode: 'baseline',
      reasoning: 'Using baseline algorithm, AI learning in progress'
    };
  }
}

// Background data collector with AGGRESSIVE collection
class BackgroundCollector {
  constructor() {
    this.aiCalc = new AIHypeCalculator();
    this.cache = new Map();
    this.CACHE_TTL = 5 * 60 * 1000;
    
    this.redditToken = null;
    this.redditTokenExpiry = 0;
    this.redditWorking = false;
    
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
          'User-Agent': 'HypeMeter/5.2.1-aggressive'
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

  // AGGRESSIVE Reddit collection - get MUCH more data
  async collectReddit(ticker) {
    const token = await this.getRedditToken();
    if (!token) return 0;

    const subreddits = [
      'wallstreetbets', 'stocks', 'investing', 'stockmarket', 'options',
      'Daytrading', 'SwingTrading', 'thetagang', 'pennystocks', 'RobinHood',
      'SecurityAnalysis', 'ValueInvesting', 'investing_discussion', 
      'Stock_Picks', 'StockMarketChat',
      'UnusualOptions', 'Shortsqueeze', 'SPACs', 'algotrading',
      'CryptoCurrency', 'Bitcoin'
    ];
    
    let totalMentions = 0;
    
    // Get posts from last 24 HOURS (not just 1 hour)
    const oneDayAgo = Math.floor((Date.now() - (24 * 60 * 60 * 1000)) / 1000);
    
    for (const sub of subreddits) {
      try {
        // Check BOTH "new" and "hot" posts (more coverage)
        for (const sort of ['new', 'hot']) {
          const url = `https://oauth.reddit.com/r/${sub}/${sort}?limit=100`;
          
          const response = await fetch(url, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'User-Agent': 'HypeMeter/5.2.1-aggressive'
            }
          });

          if (response.ok) {
            const data = await response.json();
            
            if (data?.data?.children) {
              for (const post of data.data.children) {
                const postTime = post.data.created_utc;
                
                // Count ALL posts from last 24 hours
                if (postTime < oneDayAgo) continue;
                
                const title = (post.data.title || '').toUpperCase();
                const text = (post.data.selftext || '').toUpperCase();
                const combined = `${title} ${text}`;
                
                // Multiple pattern variations for better matching
                const patterns = [
                  new RegExp(`\\$${ticker}\\b`, 'gi'),
                  new RegExp(`\\b${ticker}\\b`, 'gi'),
                  new RegExp(`${ticker}[\\s,.]`, 'gi')
                ];
                
                let postMentions = 0;
                patterns.forEach(p => {
                  const matches = (combined.match(p) || []).length;
                  postMentions += matches;
                });
                
                if (postMentions > 0) {
                  totalMentions += postMentions;
                  
                  // Record with actual post timestamp
                  const postTimestamp = postTime * 1000;
                  for (let i = 0; i < postMentions; i++) {
                    this.aiCalc.mentionEvents.get(ticker)?.push({
                      timestamp: postTimestamp,
                      source: 'reddit'
                    }) || this.aiCalc.recordMentionEvent(ticker, 'reddit');
                  }
                }
              }
            }
          }
          
          await new Promise(r => setTimeout(r, 300)); // Slower to avoid rate limit
        }
        
      } catch (e) {
        console.error(`Reddit r/${sub} error: ${e.message}`);
      }
    }
    
    return totalMentions;
  }

  // AGGRESSIVE Bluesky collection
  async collectBluesky(ticker) {
    if (!this.blueskyAgent || !this.blueskyWorking) {
      return 0;
    }

    try {
      // 6 different search strategies
      const searches = [
        `$${ticker}`,
        `${ticker} stock`,
        `#${ticker}`,
        `${ticker} trading`,
        `${ticker} buy`,
        `${ticker} calls` // Options trading mentions
      ];
      
      const seenPosts = new Set();
      let totalMentions = 0;
      const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000); // Last 24 hours
      
      for (const query of searches) {
        try {
          const result = await this.blueskyAgent.api.app.bsky.feed.searchPosts({
            q: query,
            limit: 100
          });
          
          if (result.data?.posts) {
            result.data.posts.forEach(post => {
              const postId = post.uri;
              if (seenPosts.has(postId)) return;
              
              const postTime = new Date(post.indexedAt).getTime();
              if (postTime < oneDayAgo) return; // Last 24 hours
              
              seenPosts.add(postId);
              totalMentions++;
              
              // Record with actual post timestamp
              this.aiCalc.mentionEvents.get(ticker)?.push({
                timestamp: postTime,
                source: 'bluesky'
              }) || this.aiCalc.recordMentionEvent(ticker, 'bluesky');
            });
          }
          
          await new Promise(r => setTimeout(r, 400)); // Rate limiting
        } catch (e) {
          console.error(`Bluesky search error for "${query}":`, e.message);
        }
      }
      
      return totalMentions;
    } catch (e) {
      console.error(`Bluesky error for ${ticker}:`, e.message);
      return 0;
    }
  }

  async collectStocktwits(ticker) {
    try {
      const response = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`);
      
      if (!response.ok) return 0;
      
      const data = await response.json();
      let mentions = 0;
      const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000); // Last 24 hours
      
      if (data.messages) {
        data.messages.forEach(m => {
          const messageTime = new Date(m.created_at).getTime();
          
          if (messageTime > oneDayAgo) {
            mentions++;
            this.aiCalc.mentionEvents.get(ticker)?.push({
              timestamp: messageTime,
              source: 'stocktwits'
            }) || this.aiCalc.recordMentionEvent(ticker, 'stocktwits');
          }
        });
      }
      
      return mentions;
    } catch (e) {
      return 0;
    }
  }

  // AGGRESSIVE news collection - count ALL articles from last 7 days
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
        // Count ALL news from last 7 days, weighted by age
        news.forEach(article => {
          const articleTime = article.datetime * 1000;
          const ageHours = (Date.now() - articleTime) / (60 * 60 * 1000);
          
          // Weight: Recent news counts more
          // Last 6 hours: 5 mentions each
          // Last 24 hours: 3 mentions each
          // Last 7 days: 1 mention each
          let weight = 1;
          if (ageHours < 6) weight = 5;
          else if (ageHours < 24) weight = 3;
          
          for (let i = 0; i < weight; i++) {
            this.aiCalc.mentionEvents.get(ticker)?.push({
              timestamp: articleTime,
              source: 'news'
            }) || this.aiCalc.recordMentionEvent(ticker, 'news');
          }
        });
        
        return news.length;
      }
    } catch (e) {
      console.error(`News error for ${ticker}:`, e.message);
    }
    return 0;
  }

  async collectPriceData(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return null;
    
    try {
      const quoteRes = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`
      );
      const quote = await quoteRes.json();
      
      if (!quote.c) return null;
      
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

  async collectTicker(ticker, windowMinutes = 60) {
    console.log(`🔄 ${ticker} (collecting last 24h, filtering to ${windowMinutes}min)...`);
    
    // Collect from last 24 hours (aggressive)
    const [reddit, bluesky, stocktwits, news, priceData] = await Promise.all([
      this.collectReddit(ticker),
      this.collectBluesky(ticker),
      this.collectStocktwits(ticker),
      this.collectNews(ticker),
      this.collectPriceData(ticker)
    ]);
    
    // Now filter to requested window
    const redditInWindow = this.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'reddit');
    const blueskyInWindow = this.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'bluesky');
    const stocktwitsInWindow = this.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'stocktwits');
    const newsInWindow = this.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'news');
    
    let priceChange = this.aiCalc.getPriceChange(ticker, windowMinutes);
    
    if (!priceChange && !this.aiCalc.isMarketOpen()) {
      priceChange = this.aiCalc.get24HourChange(ticker);
    }
    
    const hypeResult = await this.aiCalc.calculateHype(ticker, {
      reddit: redditInWindow,
      stocktwits: stocktwitsInWindow,
      bluesky: blueskyInWindow,
      news: newsInWindow,
      volume: priceData?.volume || 0,
      priceChangePercent: priceChange?.changePercent || 0,
      marketOpen: this.aiCalc.isMarketOpen()
    });
    
    const marketStatus = this.aiCalc.isMarketOpen() ? '🟢' : '🔴';
    const modeIcon = hypeResult.mode === 'claude-ai' ? '🧠' : hypeResult.mode === 'learned-weights' ? '🎯' : '📊';
    
    console.log(`  ${marketStatus} ${modeIcon} ${ticker}: Score ${hypeResult.hypeScore} | Total24h: R:${reddit} ST:${stocktwits} B:${bluesky} N:${news}`);
    console.log(`       In ${windowMinutes}min window: R:${redditInWindow} ST:${stocktwitsInWindow} B:${blueskyInWindow} N:${newsInWindow}`);
    
    this.cache.set(`${ticker}_${windowMinutes}`, {
      ticker,
      reddit_mentions: redditInWindow,
      stocktwits_mentions: stocktwitsInWindow,
      bluesky_mentions: blueskyInWindow,
      news_count: newsInWindow,
      reddit_total_24h: reddit,
      stocktwits_total_24h: stocktwits,
      bluesky_total_24h: bluesky,
      news_total_24h: news,
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

  async startCollection() {
    console.log(`\n🚀 HypeMeter v5.2.1 - AGGRESSIVE Data Collection`);
    console.log(`📊 Tracking ${this.trackedTickers.size} tickers`);
    console.log(`🔍 Collecting from LAST 24 HOURS (not just 1 hour)`);
    console.log(`📰 Counting ALL news from last 7 days`);
    console.log(`🤖 AI Mode: ${this.aiCalc.claudeAvailable ? 'Claude API Enabled' : 'Local Learning Only'}\n`);
    
    await this.collectAll();
    
    setInterval(async () => {
      await this.collectAll();
    }, 5 * 60 * 1000);
    
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
      await new Promise(r => setTimeout(r, 1500)); // 1.5 sec between tickers (more API calls = need more delay)
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
      version: '5.2.1-aggressive',
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

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    ...collector.getStats()
  });
});

app.get('/api/hype', async (req, res) => {
  try {
    const { tickers, window = 60 } = req.query;
    if (!tickers) return res.status(400).json({ error: 'Tickers required' });

    const windowMinutes = parseInt(window);
    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = {};
    
    for (const ticker of tickerList) {
      collector.addTicker(ticker);
      
      let data = collector.getCachedData(ticker, windowMinutes);
      
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

app.get('/api/debug/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const windowMinutes = parseInt(req.query.window) || 60;
  
  const mentionEvents = collector.aiCalc.mentionEvents.get(ticker) || [];
  const priceHistory = collector.aiCalc.priceHistory.get(ticker) || [];
  const weights = collector.aiCalc.aiWeights.get(ticker) || null;
  
  const tickerInsights = collector.aiCalc.aiInsights.filter(i => i.ticker === ticker).slice(-5);
  
  const currentMentions = collector.aiCalc.getMentionsInWindow(ticker, windowMinutes);
  const redditMentions = collector.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'reddit');
  const stocktwitsMentions = collector.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'stocktwits');
  const blueskyMentions = collector.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'bluesky');
  const newsMentions = collector.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'news');
  const priceChange = collector.aiCalc.getPriceChange(ticker, windowMinutes);
  
  // Also show 24h totals
  const reddit24h = collector.aiCalc.getMentionsInWindow(ticker, 1440, 'reddit');
  const stocktwits24h = collector.aiCalc.getMentionsInWindow(ticker, 1440, 'stocktwits');
  const bluesky24h = collector.aiCalc.getMentionsInWindow(ticker, 1440, 'bluesky');
  const news24h = collector.aiCalc.getMentionsInWindow(ticker, 1440, 'news');
  
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
      last24h: {
        reddit: reddit24h,
        stocktwits: stocktwits24h,
        bluesky: bluesky24h,
        news: news24h,
        total: reddit24h + stocktwits24h + bluesky24h + news24h
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

app.get('/', (req, res) => {
  res.json({
    message: 'HypeMeter.ai v5.2.1 - AGGRESSIVE Data Collection',
    version: '5.2.1-aggressive',
    status: 'running',
    features: [
      '🚀 AGGRESSIVE: Collects from LAST 24 HOURS (not just 1 hour)',
      '📰 Counts ALL news from last 7 days with age-based weighting',
      '🔍 20+ Reddit subreddits × 2 sorting methods = 40+ sources',
      '🐦 6 Bluesky search strategies (vs 4 before)',
      '🤖 AI-powered dynamic weighting',
      '🧠 Claude API for deep intelligence',
      '🎯 Self-learning from patterns',
      '💰 Volume working (Finnhub Candle API)',
      '⏰ 24-hour price change when market closed',
      '💾 30-day persistent storage'
    ],
    collection_details: {
      reddit: '20+ subreddits × 2 sorts × 100 posts = 4000+ posts checked',
      bluesky: '6 search queries × 100 posts = 600+ posts checked',
      stocktwits: 'Latest 30 messages per ticker',
      news: 'ALL articles from last 7 days, weighted by age'
    },
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

process.on('SIGTERM', async () => {
  console.log('\n💾 Saving AI data before shutdown...');
  await collector.aiCalc.persistData();
  console.log('✅ Shutdown complete\n');
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🚀 HypeMeter.ai v5.2.1 - AGGRESSIVE Data Collection`);
  console.log(`${'='.repeat(80)}\n`);
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`\n🔧 Configuration:`);
  console.log(`   Data path: ${process.env.DATA_PATH || '/tmp'}`);
  console.log(`   Finnhub API: ${process.env.FINNHUB_API_KEY ? '✓' : '✗'}`);
  console.log(`   Reddit OAuth: ${process.env.REDDIT_CLIENT_ID ? '✓' : '✗'}`);
  console.log(`   Bluesky Auth: ${process.env.BLUESKY_USERNAME ? '✓' : '✗'}`);
  console.log(`   Claude AI: ${process.env.ANTHROPIC_API_KEY ? '✓ Enabled' : '✗ Disabled (optional)'}`);
  console.log(`\n🎯 AGGRESSIVE Collection:`);
  console.log(`   📅 Collects from LAST 24 HOURS (not just 60 minutes)`);
  console.log(`   🔍 20+ Reddit subs × 2 sorts = 4000+ posts per cycle`);
  console.log(`   🐦 6 Bluesky queries = 600+ posts per cycle`);
  console.log(`   📰 ALL news from last 7 days, age-weighted`);
  console.log(`   💡 Filters to requested window for display`);
  console.log(`\n💡 Expected Results:`);
  console.log(`   Reddit: 100-500+ mentions per popular ticker`);
  console.log(`   Bluesky: 20-100+ mentions`);
  console.log(`   StockTwits: 30-80 mentions`);
  console.log(`   News: 5-20 articles`);
  console.log(`   TOTAL: 200-700+ mentions (vs 30-50 before)`);
  console.log(`\n${'='.repeat(80)}\n`);
  
  await collector.init();
  await collector.startCollection();
});
