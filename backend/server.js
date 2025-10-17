const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const { BskyAgent } = require('@atproto/api');
const app = express();

// Utility: Split array into chunks for parallel processing
function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Utility: Delay with milliseconds
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Rate Limiter for API calls
class RateLimiter {
  constructor(requestsPerMinute) {
    this.limit = requestsPerMinute;
    this.processing = 0;
    this.queue = [];
  }
  
  async execute(fn) {
    while (this.processing >= this.limit) {
      await delay(100);
    }
    
    this.processing++;
    try {
      return await fn();
    } finally {
      setTimeout(() => this.processing--, 60000 / this.limit);
    }
  }
}

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

// AI-Powered Hype Calculator with Percentile Scoring
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
    console.log('\n🤖 Initializing AI-Powered Hype Calculator v5.4.0...\n');
    
    // Test disk write permissions
    console.log(`📁 Data path: ${this.storage.dataPath}`);
    try {
      await fs.writeFile(path.join(this.storage.dataPath, 'test.json'), '{}');
      await fs.unlink(path.join(this.storage.dataPath, 'test.json'));
      console.log('✅ Disk write test: SUCCESS\n');
    } catch (e) {
      console.error('❌ Disk write test: FAILED', e.message);
      console.error('⚠️  Data will not persist across deploys!\n');
    }
    
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
    
    return eventCount > 0; // Return true if we have data
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

  recordPrice(ticker, price, volume, volumeSource = 'unknown') {
    if (!this.priceHistory.has(ticker)) {
      this.priceHistory.set(ticker, []);
    }

    const history = this.priceHistory.get(ticker);
    history.push({
      timestamp: Date.now(),
      price,
      volume,
      volumeSource
    });

    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    this.priceHistory.set(
      ticker,
      history.filter(h => h.timestamp > thirtyDaysAgo)
    );
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

  // NEW: Percentile-based scoring to prevent 100/100 spam
  calculatePercentileScore(ticker, baseScore, allTickersData) {
    const allScores = [];
    
    for (const [t, data] of allTickersData.entries()) {
      if (t !== ticker) {
        const score = this.calculateBaselineHype(t, data);
        allScores.push(score);
      }
    }
    
    if (allScores.length === 0) {
      return Math.min(baseScore, 85);
    }
    
    allScores.sort((a, b) => a - b);
    
    const lowerScores = allScores.filter(s => s < baseScore).length;
    const percentile = (lowerScores / allScores.length) * 100;
    
    // Add velocity component (is hype accelerating?)
    const mentionEvents = this.mentionEvents.get(ticker) || [];
    const last1h = mentionEvents.filter(e => e.timestamp > Date.now() - 3600000).length;
    const last2h = mentionEvents.filter(e => e.timestamp > Date.now() - 7200000).length;
    
    const velocityBonus = (last1h > (last2h - last1h)) ? 5 : 0;
    
    // Scale to 0-85 range, with velocity bonus
    let finalScore = percentile * 0.85;
    finalScore += velocityBonus;
    
    // Only exceptional cases hit 90+
    if (percentile > 98 && velocityBonus === 5) {
      finalScore = Math.min(finalScore + 10, 98);
    }
    
    return Math.round(finalScore);
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

**Important Context:**
- News is supplementary, not primary
- Retail sentiment (Reddit/StockTwits) should drive scores
- News should validate/amplify retail attention, not replace it
- If news is high but retail mentions are low, score should be moderate
- If retail mentions are high and news confirms it, score should be high

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

  async calculateHype(ticker, data, allTickersData) {
    this.analysisCount++;

    const shouldUseClaude = this.claudeAvailable && (this.analysisCount % this.useClaudeEvery === 0);

    if (shouldUseClaude) {
      const claudeAnalysis = await this.calculateWithClaude(ticker, data);
      if (claudeAnalysis) {
        // Apply percentile adjustment to Claude scores
        const adjustedScore = this.calculatePercentileScore(ticker, claudeAnalysis.hypeScore, allTickersData);
        
        return {
          hypeScore: adjustedScore,
          rawScore: claudeAnalysis.hypeScore,
          confidence: claudeAnalysis.confidence,
          reasoning: claudeAnalysis.reasoning + ' (percentile-adjusted)',
          keyFactors: claudeAnalysis.keyFactors,
          weights: claudeAnalysis.weights,
          anomalies: claudeAnalysis.anomalies,
          mode: 'claude-ai-percentile',
          recommendation: claudeAnalysis.recommendation
        };
      }
    }

    const learnedWeights = this.aiWeights.get(ticker);
    let baseScore;
    
    if (learnedWeights) {
      baseScore = 0;
      baseScore += (data.reddit || 0) * learnedWeights.reddit * 50;
      baseScore += (data.stocktwits || 0) * learnedWeights.stocktwits * 50;
      baseScore += (data.bluesky || 0) * learnedWeights.bluesky * 50;
      baseScore += (data.news || 0) * learnedWeights.news * 50;
      baseScore += Math.log10((data.volume || 0) / 1000000 + 1) * learnedWeights.volume * 30;
      baseScore += Math.abs(data.priceChangePercent || 0) * learnedWeights.price * 5;
    } else {
      baseScore = this.calculateBaselineHype(ticker, data);
    }

    // Apply percentile adjustment
    const adjustedScore = this.calculatePercentileScore(ticker, baseScore, allTickersData);

    return {
      hypeScore: adjustedScore,
      rawScore: baseScore,
      confidence: learnedWeights ? 75 : 50,
      weights: learnedWeights,
      mode: learnedWeights ? 'learned-weights-percentile' : 'baseline-percentile',
      reasoning: 'Percentile-based scoring prevents score inflation'
    };
  }
}

// Background data collector with PARALLEL collection
class BackgroundCollector {
  constructor() {
    this.aiCalc = new AIHypeCalculator();
    this.isCollecting = false;
    this.lastCollectionTime = null;
    this.nextCollectionTime = null;
    
    this.redditToken = null;
    this.redditTokenExpiry = 0;
    this.redditWorking = false;
    
    this.blueskyAgent = null;
    this.blueskyWorking = false;
    
    this.redditLimiter = new RateLimiter(50);
    this.finnhubLimiter = new RateLimiter(50);
    
    this.trackedTickers = new Set([
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'NVDA', 'META', 'AMD',
      'GME', 'AMC', 'SPY', 'QQQ', 'COIN', 'NFLX', 'PLTR', 'MSTR', 'SOFI',
      'HOOD', 'SNAP', 'RIVN', 'LCID', 'BB', 'NOK', 'BBBY'
    ]);
  }

  async init() {
    console.log('🚀 Initializing Background Collector v5.4.0...\n');
    
    const hasData = await this.aiCalc.init();
    await this.initBluesky();
    
    if (hasData) {
      console.log('✅ Existing data loaded - READY TO SERVE immediately!\n');
      return true;
    } else {
      console.log('⏳ No existing data - will collect on first cycle\n');
      return false;
    }
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
          'User-Agent': 'HypeMeter/5.4.0'
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

  async collectRedditComments(ticker, postPermalink) {
    const token = await this.getRedditToken();
    if (!token) return 0;
    
    try {
      const url = `https://oauth.reddit.com${postPermalink}.json?limit=100`;
      
      const response = await this.redditLimiter.execute(() => 
        fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'HypeMeter/5.4.0'
          }
        })
      );
      
      if (!response.ok) return 0;
      
      const data = await response.json();
      
      if (data[1]?.data?.children) {
        let commentMentions = 0;
        
        data[1].data.children.forEach(comment => {
          if (comment.data?.body) {
            const commentBody = comment.data.body.toUpperCase();
            const commentTime = comment.data.created_utc * 1000;
            
            const patterns = [
              new RegExp(`\\$${ticker}\\b`, 'gi'),
              new RegExp(`\\b${ticker}\\b`, 'gi'),
              new RegExp(`${ticker}[\\s,.]`, 'gi')
            ];
            
            patterns.forEach(p => {
              const matches = (commentBody.match(p) || []).length;
              if (matches > 0) {
                commentMentions += matches;
                
                for (let i = 0; i < matches; i++) {
                  if (!this.aiCalc.mentionEvents.has(ticker)) {
                    this.aiCalc.mentionEvents.set(ticker, []);
                  }
                  this.aiCalc.mentionEvents.get(ticker).push({
                    timestamp: commentTime,
                    source: 'reddit_comment'
                  });
                }
              }
            });
          }
        });
        
        return commentMentions;
      }
      
      return 0;
    } catch (e) {
      return 0;
    }
  }

  // CHANGE 1: Expanded to 70 subreddits (from 19)
  async collectReddit(ticker) {
    const token = await this.getRedditToken();
    if (!token) return 0;

    // 70 SUBREDDITS - All fair for every ticker
    const subreddits = [
      // Tier 1: Core Trading & Investing (20)
      'wallstreetbets', 'stocks', 'investing', 'stockmarket',
      'options', 'Daytrading', 'SwingTrading', 'thetagang',
      'pennystocks', 'RobinHood', 'SecurityAnalysis', 'ValueInvesting',
      'investing_discussion', 'Stock_Picks', 'StockMarketChat',
      'UnusualOptions', 'Shortsqueeze', 'SPACs', 'algotrading',
      'dividends',
      
      // Tier 2: Meme & Momentum (15)
      'Superstonk', 'WallStreetbetsELITE', 'wallstreetbetsOGs',
      'SqueezePlays', 'amcstock', 'GME', 'BBBY',
      'TrendingStocks', 'wallstreetbets2', 'MemeStocks',
      'MillennialBets', 'smallstreetbets', 'WallStreetBetsHUZZAH',
      'StockSDC', 'wallstreetbets_',
      
      // Tier 3: Value & Long-term (15)
      'Bogleheads', 'financialindependence', 'personalfinance',
      'Fire', 'leanfire', 'fatFIRE', 'ETFs', 'bonds',
      'realestateinvesting', 'M1Finance', 'DividendGrowth',
      'qyldgang', 'Vitards', 'HighDividendYield', 'fiaustralia',
      
      // Tier 4: Specialized Sectors (12)
      'biotechstocks', 'weedstocks', 'thecorporation',
      'EV', 'electricvehicles', 'CryptoCurrency',
      'ethtrader', 'CanadianInvestor', 'UKInvesting',
      'AusFinance', 'EuropeFIRE', 'IndiaInvestments',
      
      // Tier 5: Options & Advanced (8)
      'OptionsOnly', 'vegagang', 'Optionswheel',
      'pmcc', 'FuturesTrading', 'Forex',
      'ThetaGang', 'OptionsExclusive'
    ];
    
    let totalMentions = 0;
    let commentsFetched = 0;
    
    const oneDayAgo = Math.floor((Date.now() - (24 * 60 * 60 * 1000)) / 1000);
    
    // PARALLEL: Process 4 subreddits at a time
    const subredditBatches = chunk(subreddits, 4);
    
    for (const batch of subredditBatches) {
      const batchResults = await Promise.all(
        batch.map(async (sub) => {
          let subMentions = 0;
          const postsForComments = [];
          
          const [newPosts, hotPosts] = await Promise.all([
            this.fetchRedditPosts(token, sub, 'new', ticker, oneDayAgo),
            this.fetchRedditPosts(token, sub, 'hot', ticker, oneDayAgo)
          ]);
          
          subMentions += newPosts.mentions;
          subMentions += hotPosts.mentions;
          postsForComments.push(...newPosts.postsWithMentions, ...hotPosts.postsWithMentions);
          
          return { mentions: subMentions, postsForComments };
        })
      );
      
      batchResults.forEach(result => {
        totalMentions += result.mentions;
        
        result.postsForComments.slice(0, Math.max(0, 10 - commentsFetched)).forEach(async (post) => {
          if (commentsFetched >= 10) return;
          commentsFetched++;
          
          const commentCount = await this.collectRedditComments(ticker, post.permalink);
          if (commentCount > 0) {
            totalMentions += commentCount;
          }
        });
      });
      
      await delay(400);
    }
    
    return totalMentions;
  }

  async fetchRedditPosts(token, subreddit, sort, ticker, oneDayAgo) {
    try {
      const url = `https://oauth.reddit.com/r/${subreddit}/${sort}?limit=100`;
      
      const response = await this.redditLimiter.execute(() =>
        fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'HypeMeter/5.4.0'
          }
        })
      );

      if (!response.ok) return { mentions: 0, postsWithMentions: [] };
      
      const data = await response.json();
      let mentions = 0;
      const postsWithMentions = [];
      
      if (data?.data?.children) {
        for (const post of data.data.children) {
          const postTime = post.data.created_utc;
          
          if (postTime < oneDayAgo) continue;
          
          const title = (post.data.title || '').toUpperCase();
          const text = (post.data.selftext || '').toUpperCase();
          const combined = `${title} ${text}`;
          
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
            mentions += postMentions;
            
            const postTimestamp = postTime * 1000;
            for (let i = 0; i < postMentions; i++) {
              if (!this.aiCalc.mentionEvents.has(ticker)) {
                this.aiCalc.mentionEvents.set(ticker, []);
              }
              this.aiCalc.mentionEvents.get(ticker).push({
                timestamp: postTimestamp,
                source: 'reddit'
              });
            }
            
            if (post.data.num_comments > 0) {
              postsWithMentions.push({
                permalink: post.data.permalink,
                comments: post.data.num_comments
              });
            }
          }
        }
      }
      
      return { mentions, postsWithMentions };
    } catch (e) {
      return { mentions: 0, postsWithMentions: [] };
    }
  }

  // CHANGE 4: Expanded Bluesky from 6 to 20 search patterns + logging
  async collectBluesky(ticker) {
    if (!this.blueskyAgent || !this.blueskyWorking) {
      return 0;
    }

    try {
      // 20 SEARCH PATTERNS (up from 6)
      const searches = [
        // Core searches
        `$${ticker}`,
        `${ticker} stock`,
        `#${ticker}`,
        
        // Trading intent
        `${ticker} trading`,
        `${ticker} buy`,
        `${ticker} sell`,
        `${ticker} calls`,
        `${ticker} puts`,
        
        // Sentiment
        `${ticker} bullish`,
        `${ticker} bearish`,
        `${ticker} moon`,
        `${ticker} crash`,
        
        // Action verbs
        `${ticker} bought`,
        `${ticker} holding`,
        `${ticker} watching`,
        
        // Discussion
        `${ticker} DD`,
        `${ticker} analysis`,
        `${ticker} thoughts`,
        `${ticker} price target`,
        `${ticker} earnings`
      ];
      
      console.log(`  🐦 Bluesky: Searching ${searches.length} patterns for ${ticker}...`);
      
      const seenPosts = new Set();
      let totalMentions = 0;
      const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
      
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
              if (postTime < oneDayAgo) return;
              
              seenPosts.add(postId);
              totalMentions++;
              
              if (!this.aiCalc.mentionEvents.has(ticker)) {
                this.aiCalc.mentionEvents.set(ticker, []);
              }
              this.aiCalc.mentionEvents.get(ticker).push({
                timestamp: postTime,
                source: 'bluesky'
              });
            });
          }
          
          await delay(400);
        } catch (e) {
          console.error(`Bluesky search error for "${query}":`, e.message);
        }
      }
      
      console.log(`  🐦 Bluesky total for ${ticker}: ${totalMentions} mentions from ${seenPosts.size} unique posts`);
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
      const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
      
      if (data.messages) {
        data.messages.forEach(m => {
          const messageTime = new Date(m.created_at).getTime();
          
          if (messageTime > oneDayAgo) {
            mentions++;
            if (!this.aiCalc.mentionEvents.has(ticker)) {
              this.aiCalc.mentionEvents.set(ticker, []);
            }
            this.aiCalc.mentionEvents.get(ticker).push({
              timestamp: messageTime,
              source: 'stocktwits'
            });
          }
        });
      }
      
      return mentions;
    } catch (e) {
      return 0;
    }
  }

  // CHANGE 4: Added logging to news collection
  async collectNews(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) {
      return 0;
    }
    
    try {
      const today = new Date();
      const weekAgo = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000));
      
      const toDate = today.toISOString().split('T')[0];
      const fromDate = weekAgo.toISOString().split('T')[0];
      
      const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${fromDate}&to=${toDate}&token=${apiKey}`;
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      
      const response = await this.finnhubLimiter.execute(() =>
        fetch(url, { signal: controller.signal })
      );
      clearTimeout(timeout);
      
      if (!response.ok) {
        return 0;
      }
      
      const news = await response.json();
      
      if (!Array.isArray(news)) {
        return 0;
      }
      
      let effectiveCount = 0;
      
      if (news.length > 0) {
        news.forEach(article => {
          const articleTime = article.datetime * 1000;
          const ageHours = (Date.now() - articleTime) / (60 * 60 * 1000);
          
          let weight = 1;
          if (ageHours < 6) weight = 5;
          else if (ageHours < 24) weight = 3;
          
          effectiveCount += weight;
          
          for (let i = 0; i < weight; i++) {
            if (!this.aiCalc.mentionEvents.has(ticker)) {
              this.aiCalc.mentionEvents.set(ticker, []);
            }
            this.aiCalc.mentionEvents.get(ticker).push({
              timestamp: articleTime,
              source: 'news'
            });
          }
        });
      }
      
      console.log(`  📰 News for ${ticker}: ${news.length} articles found (age-weighted: ${effectiveCount})`);
      return news.length;
      
    } catch (e) {
      return 0;
    }
  }

  // CHANGE 2: Multi-strategy volume collection (4-tier fallback)
  async collectPriceData(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return null;
    
    try {
      const quoteRes = await this.finnhubLimiter.execute(() =>
        fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`)
      );
      const quote = await quoteRes.json();
      
      if (!quote.c) return null;
      
      let volume = 0;
      let volumeSource = 'none';
      
      // Strategy 1: Try 5-minute candles (last hour)
      try {
        const to = Math.floor(Date.now() / 1000);
        const from = to - 3600;
        
        const candleRes = await this.finnhubLimiter.execute(() =>
          fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=5&from=${from}&to=${to}&token=${apiKey}`)
        );
        const candle = await candleRes.json();
        
        if (candle.s === 'ok' && candle.v?.length > 0) {
          volume = candle.v.reduce((sum, v) => sum + (v || 0), 0);
          volumeSource = '5min-candle';
          console.log(`  ✓ ${ticker} volume from 5min candles: ${volume.toLocaleString()}`);
        }
      } catch (e) {
        console.log(`  ⚠ ${ticker} 5min candles failed: ${e.message}`);
      }
      
      // Strategy 2: Try hourly candles if 5min failed
      if (volume === 0) {
        try {
          const to = Math.floor(Date.now() / 1000);
          const from = to - 86400;
          
          const candleRes = await this.finnhubLimiter.execute(() =>
            fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=60&from=${from}&to=${to}&token=${apiKey}`)
          );
          const candle = await candleRes.json();
          
          if (candle.s === 'ok' && candle.v?.length > 0) {
            volume = candle.v.reduce((sum, v) => sum + (v || 0), 0);
            volumeSource = '60min-candle';
            console.log(`  ✓ ${ticker} volume from hourly candles: ${volume.toLocaleString()}`);
          }
        } catch (e) {
          console.log(`  ⚠ ${ticker} hourly candles failed: ${e.message}`);
        }
      }
      
      // Strategy 3: Try daily candle if hourly failed
      if (volume === 0) {
        try {
          const to = Math.floor(Date.now() / 1000);
          const from = to - 86400;
          
          const candleRes = await this.finnhubLimiter.execute(() =>
            fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}&token=${apiKey}`)
          );
          const candle = await candleRes.json();
          
          if (candle.s === 'ok' && candle.v?.length > 0) {
            volume = candle.v[0] || 0;
            volumeSource = 'daily-candle';
            console.log(`  ✓ ${ticker} volume from daily candle: ${volume.toLocaleString()}`);
          }
        } catch (e) {
          console.log(`  ⚠ ${ticker} daily candle failed: ${e.message}`);
        }
      }
      
      // Strategy 4: Use previous known volume from price history
      if (volume === 0) {
        const history = this.aiCalc.priceHistory.get(ticker);
        if (history && history.length > 0) {
          const lastKnownVolume = history[history.length - 1].volume;
          if (lastKnownVolume > 0) {
            volume = lastKnownVolume;
            volumeSource = 'previous-known';
            console.log(`  ↻ ${ticker} using previous known volume: ${volume.toLocaleString()}`);
          }
        }
      }
      
      if (volume === 0) {
        console.log(`  ❌ ${ticker} no volume data available from any source`);
      }
      
      this.aiCalc.recordPrice(ticker, quote.c, volume, volumeSource);
      
      return {
        price: quote.c,
        previousClose: quote.pc || quote.c,
        volume: volume,
        volumeSource: volumeSource
      };
      
    } catch (e) {
      return null;
    }
  }

  async collectTicker(ticker) {
    console.log(`🔄 ${ticker}...`);
    
    const [reddit, bluesky, stocktwits, news, priceData] = await Promise.all([
      this.collectReddit(ticker),
      this.collectBluesky(ticker),
      this.collectStocktwits(ticker),
      this.collectNews(ticker),
      this.collectPriceData(ticker)
    ]);
    
    const marketStatus = this.aiCalc.isMarketOpen() ? '🟢' : '🔴';
    console.log(`  ${marketStatus} ${ticker}: R:${reddit} ST:${stocktwits} B:${bluesky} N:${news} | Price: ${priceData?.price || 'N/A'} | Vol: ${priceData?.volume?.toLocaleString() || '0'} (${priceData?.volumeSource || 'none'})`);
    
    return { reddit, stocktwits, bluesky, news, priceData };
  }

  async startBackgroundCollection() {
    console.log(`\n🚀 Starting Background Collection Loop`);
    console.log(`📊 Tracking ${this.trackedTickers.size} tickers`);
    console.log(`⚡ Using PARALLEL collection (4 subs + 3 tickers at once)`);
    console.log(`🤖 AI Mode: ${this.aiCalc.claudeAvailable ? 'Claude API Enabled' : 'Local Learning Only'}\n`);
    
    await this.collectAll();
    
    setInterval(async () => {
      await this.collectAll();
    }, 5 * 60 * 1000);
    
    setInterval(async () => {
      await this.aiCalc.persistData();
    }, 10 * 60 * 1000);
  }

  async collectAll() {
    if (this.isCollecting) {
      console.log('⏭️  Collection already in progress, skipping...');
      return;
    }
    
    this.isCollecting = true;
    const startTime = Date.now();
    const time = new Date().toLocaleTimeString();
    const marketStatus = this.aiCalc.isMarketOpen() ? '🟢 MARKET OPEN' : '🔴 MARKET CLOSED';
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`⏰ ${time} | ${marketStatus}`);
    console.log(`${'='.repeat(80)}\n`);
    
    const tickerArray = Array.from(this.trackedTickers);
    const tickerBatches = chunk(tickerArray, 3);
    
    for (const batch of tickerBatches) {
      await Promise.all(batch.map(ticker => this.collectTicker(ticker)));
      await delay(2000);
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    this.lastCollectionTime = new Date();
    this.nextCollectionTime = new Date(Date.now() + 5 * 60 * 1000);
    
    const sources = [];
    if (this.redditWorking) sources.push('Reddit (70 subs)');
    if (this.blueskyWorking) sources.push('Bluesky (20 patterns)');
    sources.push('StockTwits', 'News');
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`✅ Collection complete in ${duration}s | Sources: ${sources.join(', ')}`);
    console.log(`⏱️  Next collection: ${this.nextCollectionTime.toLocaleTimeString()}`);
    console.log(`${'='.repeat(80)}\n`);
    
    this.isCollecting = false;
  }

  // CHANGE 5: Historical backfill for AI training
  async backfillHistoricalData() {
    console.log('\n📚 Starting Historical Backfill for AI Training...\n');
    
    const tickersToBackfill = Array.from(this.trackedTickers);
    
    for (const ticker of tickersToBackfill) {
      console.log(`📖 Backfilling ${ticker}...`);
      
      try {
        // Backfill 7 days of Reddit data
        for (let daysAgo = 1; daysAgo <= 7; daysAgo++) {
          const token = await this.getRedditToken();
          if (!token) continue;
          
          const subreddit = 'wallstreetbets';
          const searchUrl = `https://oauth.reddit.com/r/${subreddit}/search?q=${ticker}&restrict_sr=1&sort=top&t=week&limit=50`;
          
          const response = await this.redditLimiter.execute(() =>
            fetch(searchUrl, {
              headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'HypeMeter/5.4.0-backfill'
              }
            })
          );
          
          if (!response.ok) continue;
          
          const data = await response.json();
          let dayMentions = 0;
          
          if (data?.data?.children) {
            for (const post of data.data.children) {
              const postTime = post.data.created_utc * 1000;
              const postDaysAgo = Math.floor((Date.now() - postTime) / (24 * 60 * 60 * 1000));
              
              if (postDaysAgo === daysAgo) {
                const title = (post.data.title || '').toUpperCase();
                const text = (post.data.selftext || '').toUpperCase();
                const combined = `${title} ${text}`;
                
                const patterns = [
                  new RegExp(`\\$${ticker}\\b`, 'gi'),
                  new RegExp(`\\b${ticker}\\b`, 'gi')
                ];
                
                patterns.forEach(p => {
                  const matches = (combined.match(p) || []).length;
                  if (matches > 0) {
                    dayMentions += matches;
                    
                    if (!this.aiCalc.mentionEvents.has(ticker)) {
                      this.aiCalc.mentionEvents.set(ticker, []);
                    }
                    this.aiCalc.mentionEvents.get(ticker).push({
                      timestamp: postTime,
                      source: 'reddit_backfill'
                    });
                  }
                });
              }
            }
          }
          
          console.log(`  Day -${daysAgo}: ${dayMentions} mentions`);
          await delay(1000);
        }
        
        // Backfill price history (30 days)
        const apiKey = process.env.FINNHUB_API_KEY;
        if (apiKey) {
          try {
            const to = Math.floor(Date.now() / 1000);
            const from = to - (30 * 24 * 60 * 60);
            
            const candleRes = await this.finnhubLimiter.execute(() =>
              fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}&token=${apiKey}`)
            );
            const candle = await candleRes.json();
            
            if (candle.s === 'ok' && candle.c?.length > 0) {
              for (let i = 0; i < candle.t.length; i++) {
                this.aiCalc.recordPrice(
                  ticker,
                  candle.c[i],
                  candle.v[i] || 0,
                  'backfill'
                );
              }
              console.log(`  ✓ Backfilled ${candle.t.length} days of price data`);
            }
          } catch (e) {
            console.log(`  ⚠ Price backfill failed: ${e.message}`);
          }
        }
        
        console.log(`✅ ${ticker} backfill complete\n`);
        await delay(2000);
        
      } catch (error) {
        console.error(`❌ Error backfilling ${ticker}:`, error.message);
      }
    }
    
    console.log('📚 Historical Backfill Complete!\n');
    await this.aiCalc.persistData();
  }

  addTicker(ticker) {
    if (!this.trackedTickers.has(ticker)) {
      this.trackedTickers.add(ticker);
      console.log(`➕ ${ticker} added to tracking`);
    }
  }

  getHypeData(ticker, windowMinutes) {
    const events = this.aiCalc.mentionEvents.get(ticker);
    
    if (!events || events.length === 0) {
      return {
        ticker,
        available: false,
        message: 'Ticker not tracked yet',
        nextCollection: this.nextCollectionTime?.toISOString()
      };
    }
    
    const redditMentions = this.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'reddit');
    const redditComments = this.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'reddit_comment');
    const stocktwitsMentions = this.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'stocktwits');
    const blueskyMentions = this.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'bluesky');
    const newsMentions = this.aiCalc.getMentionsInWindow(ticker, windowMinutes, 'news');
    
    let priceChange = this.aiCalc.getPriceChange(ticker, windowMinutes);
    if (!priceChange && !this.aiCalc.isMarketOpen()) {
      priceChange = this.aiCalc.get24HourChange(ticker);
    }
    
    const priceHistory = this.aiCalc.priceHistory.get(ticker) || [];
    const latestPrice = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1] : null;
    
    return {
      ticker,
      available: true,
      reddit_mentions: redditMentions + redditComments,
      stocktwits_mentions: stocktwitsMentions,
      bluesky_mentions: blueskyMentions,
      news_count: newsMentions,
      priceData: latestPrice ? {
        price: latestPrice.price,
        volume: latestPrice.volume,
        volumeSource: latestPrice.volumeSource
      } : null,
      priceChange,
      timestamp: Date.now()
    };
  }

  getStats() {
    return {
      version: '5.4.0',
      tracked: this.trackedTickers.size,
      mention_events: Array.from(this.aiCalc.mentionEvents.values()).reduce((sum, e) => sum + e.length, 0),
      price_snapshots: Array.from(this.aiCalc.priceHistory.values()).reduce((sum, h) => sum + h.length, 0),
      ai_insights: this.aiCalc.aiInsights.length,
      ai_weights_learned: this.aiCalc.aiWeights.size,
      market_open: this.aiCalc.isMarketOpen(),
      is_collecting: this.isCollecting,
      last_collection: this.lastCollectionTime?.toISOString(),
      next_collection: this.nextCollectionTime?.toISOString(),
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

// CHANGE 3: Updated API endpoint with percentile scoring
app.get('/api/hype', async (req, res) => {
  try {
    const { tickers, window = 60 } = req.query;
    if (!tickers) return res.status(400).json({ error: 'Tickers required' });

    const windowMinutes = parseInt(window);
    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    
    // First pass: collect all data
    const allTickersData = new Map();
    
    for (const ticker of tickerList) {
      collector.addTicker(ticker);
      const data = collector.getHypeData(ticker, windowMinutes);
      
      if (data.available) {
        allTickersData.set(ticker, {
          reddit: data.reddit_mentions,
          stocktwits: data.stocktwits_mentions,
          bluesky: data.bluesky_mentions,
          news: data.news_count,
          volume: data.priceData?.volume || 0,
          priceChangePercent: data.priceChange?.changePercent || 0,
          marketOpen: collector.aiCalc.isMarketOpen()
        });
      }
    }
    
    // Second pass: calculate scores with percentile context
    const results = {};
    
    for (const ticker of tickerList) {
      const data = allTickersData.get(ticker);
      
      if (!data) {
        results[ticker] = {
          symbol: ticker,
          hypeScore: 0,
          available: false,
          message: 'Not yet tracked'
        };
        continue;
      }
      
      const hypeResult = await collector.aiCalc.calculateHype(ticker, data, allTickersData);
      const tickerData = collector.getHypeData(ticker, windowMinutes);
      
      results[ticker] = {
        symbol: ticker,
        hypeScore: hypeResult.hypeScore || 0,
        rawScore: hypeResult.rawScore || 0,
        confidence: hypeResult.confidence || 50,
        mentions: data.reddit + data.stocktwits + data.bluesky + data.news,
        reddit_mentions: data.reddit,
        stocktwits_mentions: data.stocktwits,
        bluesky_mentions: data.bluesky,
        news_count: data.news,
        price: tickerData.priceData?.price || null,
        change: tickerData.priceChange?.change || null,
        changePercent: data.priceChangePercent,
        volume: data.volume || 0,
        volumeSource: tickerData.priceData?.volumeSource || 'unknown',
        name: ticker,
        mode: hypeResult.mode || 'baseline',
        reasoning: hypeResult.reasoning,
        weights: hypeResult.weights,
        recommendation: hypeResult.recommendation,
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
      latestVolume: priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].volume : null,
      latestVolumeSource: priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].volumeSource : null
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
    marketOpen: collector.aiCalc.isMarketOpen()
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
    message: 'HypeMeter.ai v5.4.0 - Enhanced Multi-Source Collection',
    version: '5.4.0',
    status: 'running',
    features: [
      '⚡ INSTANT API responses (<50ms)',
      '🚀 PARALLEL collection (4 subs + 3 tickers)',
      '📊 70 Reddit subreddits (up from 19)',
      '🐦 20 Bluesky search patterns (up from 6)',
      '💾 Multi-strategy volume collection (4-tier fallback)',
      '🎯 Percentile-based scoring (no more 100/100 spam)',
      '📚 Historical backfill for AI training',
      '🤖 AI-powered dynamic weighting',
      '🧠 Claude API for deep intelligence'
    ],
    architecture: {
      collection: 'Background only, every 5 min, parallel',
      serving: 'Instant from memory, zero API calls',
      storage: 'Persistent disk at /var/data'
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
  res.json({ 
    alive: true, 
    timestamp: new Date().toISOString(),
    collecting: collector.isCollecting,
    nextCollection: collector.nextCollectionTime?.toISOString()
  });
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
  console.log(`🚀 HypeMeter.ai v5.4.0 - Enhanced Data Collection`);
  console.log(`${'='.repeat(80)}\n`);
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`\n🔧 Configuration:`);
  console.log(`   Data path: ${process.env.DATA_PATH || '/tmp'}`);
  console.log(`   Finnhub API: ${process.env.FINNHUB_API_KEY ? '✓' : '✗'}`);
  console.log(`   Reddit OAuth: ${process.env.REDDIT_CLIENT_ID ? '✓' : '✗'}`);
  console.log(`   Bluesky Auth: ${process.env.BLUESKY_USERNAME ? '✓' : '✗'}`);
  console.log(`   Claude AI: ${process.env.ANTHROPIC_API_KEY ? '✓ Enabled' : '✗ Disabled'}`);
  console.log(`\n🆕 v5.4.0 Features:`);
  console.log(`   📊 70 Reddit subreddits (vs 19)`);
  console.log(`   💾 Multi-strategy volume collection (4-tier fallback)`);
  console.log(`   🎯 Percentile-based scoring (no more 100/100 spam)`);
  console.log(`   🐦 20 Bluesky search patterns (vs 6)`);
  console.log(`   📚 Historical backfill for AI training`);
  console.log(`\n${'='.repeat(80)}\n`);
  
  const hasData = await collector.init();
  
  if (!hasData) {
    console.log('📖 No existing data - running historical backfill...\n');
    await collector.backfillHistoricalData();
  } else {
    console.log('✅ Existing data loaded - skipping backfill\n');
  }
  
  await collector.startBackgroundCollection();
});
