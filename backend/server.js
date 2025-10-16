const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const googleTrends = require('google-trends-api');
const { BskyAgent } = require('@atproto/api');
const app = express();

class BackgroundCollector {
  constructor() {
    this.liveData = new Map();
    this.priceSnapshots = new Map();
    this.historicalBaselines = new Map(); // Store historical averages
    this.redditToken = null;
    this.redditTokenExpiry = 0;
    this.redditWorking = false;
    this.blueskyAgent = null;
    this.blueskyWorking = false;
    
    this.trackedTickers = new Set([
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'NVDA', 'META', 'AMD',
      'GME', 'AMC', 'SPY', 'QQQ', 'COIN', 'NFLX', 'PLTR', 'MSTR', 'SOFI'
    ]);
    
    this.initBluesky();
  }

  async initBluesky() {
    const username = process.env.BLUESKY_USERNAME;
    const password = process.env.BLUESKY_PASSWORD;
    
    if (!username || !password) {
      console.log('⚠️  Bluesky not configured');
      return;
    }

    try {
      this.blueskyAgent = new BskyAgent({ service: 'https://bsky.social' });
      await this.blueskyAgent.login({
        identifier: username,
        password: password
      });
      this.blueskyWorking = true;
      console.log('✅ Bluesky authenticated');
    } catch (e) {
      console.log('⚠️  Bluesky failed:', e.message);
      this.blueskyWorking = false;
    }
  }

  // BACKFILL HISTORICAL PRICE DATA
  async backfillPriceHistory(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return;
    
    try {
      console.log(`  📊 Backfilling 24h price history for ${ticker}...`);
      
      // Get 1-minute candles for last 24 hours
      const to = Math.floor(Date.now() / 1000);
      const from = to - (24 * 60 * 60); // 24 hours ago
      
      const url = `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=5&from=${from}&to=${to}&token=${apiKey}`;
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.s === 'ok' && data.t && data.c) {
        const history = [];
        
        // Create snapshots from candle data (every 5 minutes)
        for (let i = 0; i < data.t.length; i++) {
          history.push({
            price: data.c[i],
            previousClose: i > 0 ? data.c[i-1] : data.c[i],
            volume: data.v[i] || 0,
            timestamp: data.t[i] * 1000
          });
        }
        
        this.priceSnapshots.set(ticker, history);
        console.log(`  ✅ Backfilled ${history.length} price points for ${ticker}`);
      }
      
    } catch (e) {
      console.log(`  ⚠️  Backfill failed for ${ticker}:`, e.message);
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
          'User-Agent': 'HypeMeter/4.0'
        },
        body: 'grant_type=client_credentials'
      });

      if (!response.ok) {
        console.log(`  ⚠️  Reddit OAuth failed: ${response.status}`);
        this.redditWorking = false;
        return null;
      }

      const data = await response.json();
      if (data.access_token) {
        this.redditToken = data.access_token;
        this.redditTokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
        this.redditWorking = true;
        return this.redditToken;
      }
    } catch (e) {
      console.log(`  ⚠️  Reddit error:`, e.message);
      this.redditWorking = false;
    }
    return null;
  }

  async collectReddit(ticker) {
    const token = await this.getRedditToken();
    if (!token) return { mentions: 0, posts: 0 };

    const subreddits = ['wallstreetbets', 'stocks', 'investing', 'stockmarket'];
    
    let totalMentions = 0;
    let totalPosts = 0;
    const oneHourAgo = Math.floor((Date.now() - (60 * 60 * 1000)) / 1000);
    
    for (const sub of subreddits) {
      try {
        const url = `https://oauth.reddit.com/r/${sub}/new?limit=100`;
        
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'HypeMeter/4.0'
          }
        });

        if (response.ok) {
          const data = await response.json();
          
          if (data?.data?.children) {
            const recent = data.data.children.filter(p => p.data.created_utc > oneHourAgo);
            
            recent.forEach(post => {
              const title = (post.data.title || '').toUpperCase();
              const text = (post.data.selftext || '').toUpperCase();
              const combined = `${title} ${text}`;
              
              const patterns = [
                new RegExp(`\\$${ticker}\\b`, 'gi'),
                new RegExp(`\\b${ticker}\\b`, 'gi')
              ];
              
              let foundInPost = false;
              patterns.forEach(p => {
                const matches = combined.match(p) || [];
                if (matches.length > 0) {
                  totalMentions += matches.length;
                  if (!foundInPost) {
                    totalPosts++;
                    foundInPost = true;
                  }
                }
              });
            });
          }
        }
        
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.log(`  ⚠️  Reddit r/${sub} error:`, e.message);
      }
    }
    
    return { mentions: totalMentions, posts: totalPosts };
  }

  async collectBluesky(ticker) {
    if (!this.blueskyAgent || !this.blueskyWorking) {
      return { mentions: 0, posts: 0 };
    }

    try {
      const queries = [`$${ticker}`, `${ticker} stock`];
      let totalMentions = 0;
      let totalPosts = 0;
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      
      for (const query of queries) {
        try {
          const result = await this.blueskyAgent.api.app.bsky.feed.searchPosts({
            q: query,
            limit: 100
          });
          
          if (result.data?.posts) {
            const recentPosts = result.data.posts.filter(post => {
              const postTime = new Date(post.indexedAt).getTime();
              return postTime > oneHourAgo;
            });
            
            recentPosts.forEach(post => {
              const text = (post.record?.text || '').toUpperCase();
              
              const patterns = [
                new RegExp(`\\$${ticker}\\b`, 'gi'),
                new RegExp(`\\b${ticker}\\b`, 'gi')
              ];
              
              let foundInPost = false;
              patterns.forEach(p => {
                const matches = text.match(p) || [];
                if (matches.length > 0) {
                  totalMentions += matches.length;
                  if (!foundInPost) {
                    totalPosts++;
                    foundInPost = true;
                  }
                }
              });
            });
          }
          
          await new Promise(r => setTimeout(r, 300));
        } catch (queryError) {
          console.log(`  ⚠️  Bluesky query error:`, queryError.message);
        }
      }
      
      return { mentions: totalMentions, posts: totalPosts };
      
    } catch (e) {
      console.log(`  ⚠️  Bluesky error:`, e.message);
      return { mentions: 0, posts: 0 };
    }
  }

  async collectStocktwits(ticker) {
    try {
      const response = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`, {
        headers: {
          'User-Agent': 'HypeMeter/4.0'
        }
      });
      
      if (!response.ok) {
        console.log(`  ⚠️  Stocktwits ${response.status}`);
        return { mentions: 0, bullish: 0, bearish: 0 };
      }
      
      const data = await response.json();
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      
      const recent = data.messages?.filter(m => 
        new Date(m.created_at).getTime() > oneHourAgo
      ) || [];
      
      let bullish = 0, bearish = 0;
      recent.forEach(m => {
        if (m.entities?.sentiment?.basic === 'Bullish') bullish++;
        if (m.entities?.sentiment?.basic === 'Bearish') bearish++;
      });
      
      return { mentions: recent.length, bullish, bearish };
    } catch (e) {
      console.log(`  ⚠️  Stocktwits error:`, e.message);
      return { mentions: 0, bullish: 0, bearish: 0 };
    }
  }

  async collectFinnhubNews(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return { news: 0 };
    
    try {
      const today = new Date();
      const yesterday = new Date(Date.now() - (24 * 60 * 60 * 1000));
      
      const toDate = today.toISOString().split('T')[0];
      const fromDate = yesterday.toISOString().split('T')[0];
      
      const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${fromDate}&to=${toDate}&token=${apiKey}`;
      
      const response = await fetch(url);
      const news = await response.json();
      
      if (Array.isArray(news)) {
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        const recent = news.filter(a => a.datetime * 1000 > oneHourAgo);
        return { news: recent.length, total: news.length };
      }
    } catch (e) {
      console.log(`  ⚠️  News error:`, e.message);
    }
    return { news: 0, total: 0 };
  }

  async collectGoogleTrends(ticker) {
    try {
      const endTime = new Date();
      const startTime = new Date(Date.now() - (4 * 60 * 60 * 1000)); // Last 4 hours
      
      const result = await googleTrends.interestOverTime({
        keyword: `${ticker} stock`,
        startTime: startTime,
        endTime: endTime,
        granularTimeResolution: true
      });
      
      const data = JSON.parse(result);
      
      if (data.default?.timelineData) {
        const recentPoints = data.default.timelineData.slice(-3);
        
        let totalInterest = 0;
        let count = 0;
        
        recentPoints.forEach(point => {
          point.value?.forEach(val => {
            if (val !== null && val !== undefined) {
              totalInterest += parseInt(val);
              count++;
            }
          });
        });
        
        const avgInterest = count > 0 ? Math.round(totalInterest / count) : 0;
        return { interest: avgInterest };
      }
      
    } catch (e) {
      console.log(`  ⚠️  Trends error:`, e.message);
    }
    return { interest: 0 };
  }

  async collectPriceData(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return null;
    
    try {
      const response = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`);
      const data = await response.json();
      
      if (data.c) {
        const snapshot = {
          price: data.c || 0,
          previousClose: data.pc || data.c,
          volume: data.v || 0,
          timestamp: Date.now()
        };
        
        if (!this.priceSnapshots.has(ticker)) {
          this.priceSnapshots.set(ticker, []);
        }
        const history = this.priceSnapshots.get(ticker);
        history.push(snapshot);
        
        if (history.length > 288) history.shift();
        
        return snapshot;
      }
    } catch (e) {
      console.log(`  ⚠️  Price error:`, e.message);
    }
    return null;
  }

  async collectTicker(ticker) {
    console.log(`🔄 ${ticker}...`);
    
    const [reddit, bluesky, stocktwits, news, trends, priceData] = await Promise.all([
      this.collectReddit(ticker),
      this.collectBluesky(ticker),
      this.collectStocktwits(ticker),
      this.collectFinnhubNews(ticker),
      this.collectGoogleTrends(ticker),
      this.collectPriceData(ticker)
    ]);
    
    // RAW mentions (unweighted)
    const rawMentions = {
      reddit: reddit.mentions,
      bluesky: bluesky.mentions,
      stocktwits: stocktwits.mentions,
      news: news.news * 5, // News gets 5x multiplier
      trends: Math.round(trends.interest * 0.5) // Trends scaled down
    };
    
    // Total raw mentions
    const totalRawMentions = Object.values(rawMentions).reduce((sum, val) => sum + val, 0);
    
    const sentiment = stocktwits.bullish + stocktwits.bearish > 0
      ? stocktwits.bullish / (stocktwits.bullish + stocktwits.bearish)
      : 0.5;
    
    const tickerData = {
      ticker,
      rawMentions: totalRawMentions,
      reddit_mentions: reddit.mentions,
      bluesky_mentions: bluesky.mentions,
      stocktwits_mentions: stocktwits.mentions,
      stocktwits_bullish: stocktwits.bullish,
      stocktwits_bearish: stocktwits.bearish,
      news_count: news.news,
      trends_interest: trends.interest,
      sentiment_score: sentiment,
      currentPrice: priceData?.price || 0,
      previousClose: priceData?.previousClose || 0,
      volume: priceData?.volume || 0,
      lastUpdated: new Date().toISOString()
    };
    
    this.liveData.set(ticker, tickerData);
    
    console.log(`  ✅ ${ticker}: ${totalRawMentions} raw (R:${reddit.mentions} B:${bluesky.mentions} ST:${stocktwits.mentions} N:${news.news} GT:${trends.interest})`);
    
    return tickerData;
  }

  // RELATIVE HYPE CALCULATION
  calculateRelativeHype() {
    const allData = Array.from(this.liveData.values());
    
    if (allData.length === 0) return;
    
    // Calculate market-wide averages
    const avgMentions = allData.reduce((sum, d) => sum + d.rawMentions, 0) / allData.length;
    const avgVolume = allData.reduce((sum, d) => sum + (d.volume || 0), 0) / allData.length;
    
    // Calculate hype for each ticker RELATIVE to market
    for (const [ticker, data] of this.liveData.entries()) {
      // Relative to market average
      const mentionRatio = avgMentions > 0 ? data.rawMentions / avgMentions : 1;
      const volumeRatio = avgVolume > 0 ? (data.volume || 0) / avgVolume : 1;
      
      // Get price change
      const priceChange = this.getPriceChange(ticker, 60);
      const absPriceChange = Math.abs(priceChange.changePercent || 0);
      
      // Calculate average price volatility across all stocks
      const avgVolatility = allData.reduce((sum, d) => {
        const pc = this.getPriceChange(d.ticker, 60);
        return sum + Math.abs(pc.changePercent || 0);
      }, 0) / allData.length;
      
      const volatilityRatio = avgVolatility > 0 ? absPriceChange / avgVolatility : 1;
      
      // RELATIVE HYPE SCORE (0-100)
      let hype = 0;
      
      // Mentions component (0-40): Relative to market average
      hype += Math.min(Math.log10(mentionRatio + 1) * 30, 40);
      
      // Volume component (0-30): Relative to market average  
      hype += Math.min(Math.log10(volumeRatio + 1) * 25, 30);
      
      // Volatility component (0-30): Relative to market average
      hype += Math.min(volatilityRatio * 15, 30);
      
      // Sentiment extremity bonus (0-10)
      const sentimentExtremity = Math.abs(data.sentiment_score - 0.5) * 2;
      hype += sentimentExtremity * 10;
      
      // Update with relative hype score
      data.hypeScore = Math.min(Math.round(hype), 100);
      data.mentionRatio = mentionRatio.toFixed(2);
      data.volumeRatio = volumeRatio.toFixed(2);
      data.volatilityRatio = volatilityRatio.toFixed(2);
    }
  }

  getPriceChange(ticker, windowMinutes) {
    const history = this.priceSnapshots.get(ticker);
    const data = this.liveData.get(ticker);
    
    if (!history || history.length < 2) {
      if (data?.currentPrice && data?.previousClose && data.currentPrice > 0 && data.previousClose > 0) {
        const change = data.currentPrice - data.previousClose;
        const changePercent = (change / data.previousClose) * 100;
        return { change, changePercent };
      }
      return { change: null, changePercent: null };
    }
    
    const targetTime = Date.now() - (windowMinutes * 60 * 1000);
    const sorted = [...history].sort((a, b) => 
      Math.abs(a.timestamp - targetTime) - Math.abs(b.timestamp - targetTime)
    );
    
    const oldPrice = sorted[0].price;
    const currentPrice = history[history.length - 1].price;
    
    if (oldPrice > 0 && currentPrice > 0) {
      const change = currentPrice - oldPrice;
      const changePercent = (change / oldPrice) * 100;
      return { change, changePercent };
    }
    
    return { change: null, changePercent: null };
  }

  async startCollection() {
    console.log(`\n🚀 HypeMeter v4.0 - Relative Scoring + Backfill`);
    console.log(`📊 Tracking ${this.trackedTickers.size} tickers\n`);
    
    // Step 1: Backfill price history for all tickers
    console.log('📈 Backfilling 24h price history...\n');
    for (const ticker of this.trackedTickers) {
      await this.backfillPriceHistory(ticker);
      await new Promise(r => setTimeout(r, 500));
    }
    console.log('\n✅ Backfill complete!\n');
    
    // Step 2: Start collection
    console.log('🔄 Starting data collection...\n');
    await this.collectAll();
    
    // Step 3: Collect every 5 minutes
    setInterval(() => {
      this.collectAll();
    }, 5 * 60 * 1000);
  }

  async collectAll() {
    const time = new Date().toLocaleTimeString();
    console.log(`\n⏰ ${time} - Collecting...\n`);
    
    for (const ticker of this.trackedTickers) {
      await this.collectTicker(ticker);
      await new Promise(r => setTimeout(r, 800));
    }
    
    // Calculate relative hype after collecting all data
    this.calculateRelativeHype();
    
    console.log(`\n✅ Complete. Sources: Reddit:${this.redditWorking ? '✓' : '✗'} Bluesky:${this.blueskyWorking ? '✓' : '✗'}\n`);
  }

  addTicker(ticker) {
    if (!this.trackedTickers.has(ticker)) {
      this.trackedTickers.add(ticker);
      console.log(`➕ ${ticker} added`);
      this.backfillPriceHistory(ticker).then(() => {
        this.collectTicker(ticker).then(() => {
          this.calculateRelativeHype();
        });
      });
    }
  }

  getData(ticker) {
    return this.liveData.get(ticker) || null;
  }

  getStats() {
    return {
      version: '4.0.0',
      tracked: this.trackedTickers.size,
      cached: this.liveData.size,
      sources: {
        reddit: this.redditWorking ? 'working' : 'unavailable',
        bluesky: this.blueskyWorking ? 'working' : 'unavailable',
        stocktwits: 'working',
        finnhub: 'working',
        google_trends: 'working'
      }
    };
  }
}

const collector = new BackgroundCollector();

app.use(cors({
  origin: ['https://hypemeter.ai', 'https://www.hypemeter.ai', 'https://cooldude-ai.github.io', 'http://localhost:3000', 'http://localhost:8000'],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ...collector.getStats() });
});

app.get('/api/hype', async (req, res) => {
  try {
    const { tickers, window = 60 } = req.query;
    if (!tickers) return res.status(400).json({ error: 'Tickers required' });

    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = {};
    
    tickerList.forEach(t => collector.addTicker(t));
    
    for (const ticker of tickerList) {
      const data = collector.getData(ticker);
      
      if (!data) {
        results[ticker] = { symbol: ticker, hypeScore: 0, mentions: 0, loading: true };
        continue;
      }
      
      const priceChange = collector.getPriceChange(ticker, parseInt(window));
      
      results[ticker] = {
        symbol: ticker,
        hypeScore: data.hypeScore || 0,
        mentions: data.rawMentions,
        reddit_mentions: data.reddit_mentions,
        bluesky_mentions: data.bluesky_mentions,
        stocktwits_mentions: data.stocktwits_mentions,
        news_count: data.news_count,
        trends_interest: data.trends_interest,
        mentionRatio: data.mentionRatio,
        volumeRatio: data.volumeRatio,
        volatilityRatio: data.volatilityRatio,
        sentiment: data.sentiment_score > 0.6 ? 'Bullish' : data.sentiment_score < 0.4 ? 'Bearish' : 'Neutral',
        price: data.currentPrice || null,
        change: priceChange.change,
        changePercent: priceChange.changePercent,
        volume: data.volume || 0,
        name: ticker,
        timestamp: data.lastUpdated
      };
    }
    
    res.json(results);
  } catch (error) {
    console.error('Hype error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/quotes', (req, res) => {
  try {
    const { tickers } = req.query;
    if (!tickers) return res.status(400).json({ error: 'Tickers required' });
    
    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = {};
    
    for (const ticker of tickerList) {
      const data = collector.getData(ticker);
      if (data && data.currentPrice) {
        results[ticker] = {
          symbol: ticker,
          currentPrice: data.currentPrice,
          previousClose: data.previousClose,
          change: data.currentPrice - data.previousClose,
          changePercent: ((data.currentPrice - data.previousClose) / data.previousClose) * 100,
          volume: data.volume
        };
      }
    }
    
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    message: 'HypeMeter v4.0 - Relative Scoring + Backfill',
    ...collector.getStats()
  });
});

app.get('/keepalive', (req, res) => {
  res.json({ alive: true });
});

if (process.env.NODE_ENV === 'production') {
  setInterval(async () => {
    try {
      await fetch(`${process.env.RENDER_EXTERNAL_URL || 'https://hypemeter.onrender.com'}/keepalive`);
    } catch (e) {}
  }, 14 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 HypeMeter v4.0.0 - Port ${PORT}`);
  console.log(`📡 Relative scoring enabled`);
  console.log(`📈 Price backfill enabled\n`);
  
  collector.startCollection();
});
