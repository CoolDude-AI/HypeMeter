const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { BskyAgent } = require('@atproto/api');
const app = express();

class BackgroundCollector {
  constructor() {
    this.liveData = new Map();
    this.priceSnapshots = new Map();
    this.mentionTimestamps = new Map(); // Store when each mention occurred
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
      this.blueskyWorking = false;
      return;
    }

    try {
      this.blueskyAgent = new BskyAgent({ service: 'https://bsky.social' });
      await this.blueskyAgent.login({ identifier: username, password: password });
      this.blueskyWorking = true;
      console.log('✅ Bluesky:', username);
    } catch (e) {
      this.blueskyWorking = false;
    }
  }

  async backfillPriceHistory(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return;
    
    try {
      const to = Math.floor(Date.now() / 1000);
      const from = to - (24 * 60 * 60);
      
      const url = `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=5&from=${from}&to=${to}&token=${apiKey}`;
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.s === 'ok' && data.t && data.c) {
        const history = [];
        for (let i = 0; i < data.t.length; i++) {
          history.push({
            price: data.c[i],
            previousClose: i > 0 ? data.c[i-1] : data.c[i],
            volume: data.v[i] || 0,
            timestamp: data.t[i] * 1000
          });
        }
        this.priceSnapshots.set(ticker, history);
        console.log(`  ✅ ${ticker}: ${history.length} points`);
      }
    } catch (e) {}
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
          'User-Agent': 'HypeMeter/4.2'
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
    } catch (e) {}
    
    this.redditWorking = false;
    return null;
  }

  async collectReddit(ticker) {
    const token = await this.getRedditToken();
    if (!token) return { mentions: [], totalMentions: 0 };

    // More stock-focused subreddits
    const subreddits = [
      'wallstreetbets', 'stocks', 'investing', 'stockmarket',
      'options', 'thetagang', 'Daytrading', 'ValueInvesting',
      'pennystocks', 'RobinHood', 'SwingTrading'
    ];
    
    const allMentions = [];
    
    for (const sub of subreddits) {
      try {
        // Get NEW posts (fresh discussion)
        const url = `https://oauth.reddit.com/r/${sub}/new?limit=100`;
        
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'HypeMeter/4.2'
          }
        });

        if (response.ok) {
          const data = await response.json();
          
          if (data?.data?.children) {
            for (const post of data.data.children) {
              const postTime = post.data.created_utc * 1000;
              const title = (post.data.title || '').toUpperCase();
              const text = (post.data.selftext || '').toUpperCase();
              const combined = `${title} ${text}`;
              
              // Check if ticker mentioned in post
              const patterns = [
                new RegExp(`\\$${ticker}\\b`, 'gi'),
                new RegExp(`\\b${ticker}\\b`, 'gi')
              ];
              
              let postHasTicker = false;
              patterns.forEach(p => {
                if (combined.match(p)) {
                  postHasTicker = true;
                }
              });
              
              if (postHasTicker) {
                // Count post title/body mentions
                patterns.forEach(p => {
                  const matches = combined.match(p) || [];
                  matches.forEach(() => {
                    allMentions.push({ timestamp: postTime, source: 'reddit_post' });
                  });
                });
                
                // FETCH COMMENTS for this post
                try {
                  const commentsUrl = `https://oauth.reddit.com/r/${sub}/comments/${post.data.id}?limit=100`;
                  const commentsResponse = await fetch(commentsUrl, {
                    headers: {
                      'Authorization': `Bearer ${token}`,
                      'User-Agent': 'HypeMeter/4.2'
                    }
                  });
                  
                  if (commentsResponse.ok) {
                    const commentsData = await commentsResponse.json();
                    
                    // Comments are in second element
                    if (commentsData[1]?.data?.children) {
                      commentsData[1].data.children.forEach(comment => {
                        if (comment.data?.body) {
                          const commentBody = comment.data.body.toUpperCase();
                          const commentTime = comment.data.created_utc * 1000;
                          
                          patterns.forEach(p => {
                            const matches = commentBody.match(p) || [];
                            matches.forEach(() => {
                              allMentions.push({ timestamp: commentTime, source: 'reddit_comment' });
                            });
                          });
                        }
                      });
                    }
                  }
                  
                  await new Promise(r => setTimeout(r, 300)); // Rate limit
                } catch (commentError) {}
              }
            }
          }
        }
        
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {}
    }
    
    return { mentions: allMentions, totalMentions: allMentions.length };
  }

  async collectBluesky(ticker) {
    if (!this.blueskyAgent || !this.blueskyWorking) {
      return { mentions: [], totalMentions: 0 };
    }

    try {
      const allMentions = [];
      
      const result = await this.blueskyAgent.api.app.bsky.feed.searchPosts({
        q: `$${ticker}`,
        limit: 100
      });
      
      if (result.data?.posts) {
        result.data.posts.forEach(post => {
          const text = (post.record?.text || '').toUpperCase();
          const postTime = new Date(post.indexedAt).getTime();
          
          if (text.includes(`$${ticker}`) || text.includes(` ${ticker} `)) {
            allMentions.push({ timestamp: postTime, source: 'bluesky' });
          }
        });
      }
      
      return { mentions: allMentions, totalMentions: allMentions.length };
      
    } catch (e) {
      return { mentions: [], totalMentions: 0 };
    }
  }

  async collectStocktwits(ticker) {
    try {
      const response = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`);
      
      if (!response.ok) return { mentions: [], totalMentions: 0, bullish: 0, bearish: 0 };
      
      const data = await response.json();
      const allMentions = [];
      
      let bullish = 0, bearish = 0;
      
      if (data.messages) {
        data.messages.forEach(m => {
          const messageTime = new Date(m.created_at).getTime();
          allMentions.push({ timestamp: messageTime, source: 'stocktwits' });
          
          if (m.entities?.sentiment?.basic === 'Bullish') bullish++;
          if (m.entities?.sentiment?.basic === 'Bearish') bearish++;
        });
      }
      
      return { mentions: allMentions, totalMentions: allMentions.length, bullish, bearish };
    } catch (e) {
      return { mentions: [], totalMentions: 0, bullish: 0, bearish: 0 };
    }
  }

  async collectFinnhubNews(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return { mentions: [], totalMentions: 0 };
    
    try {
      const today = new Date();
      const weekAgo = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000));
      
      const toDate = today.toISOString().split('T')[0];
      const fromDate = weekAgo.toISOString().split('T')[0];
      
      const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${fromDate}&to=${toDate}&token=${apiKey}`;
      
      const response = await fetch(url);
      const news = await response.json();
      
      const allMentions = [];
      
      if (Array.isArray(news)) {
        news.forEach(article => {
          const articleTime = article.datetime * 1000;
          // Each article counts as 5 mentions (news is more significant)
          for (let i = 0; i < 5; i++) {
            allMentions.push({ timestamp: articleTime, source: 'news' });
          }
        });
      }
      
      return { mentions: allMentions, totalMentions: allMentions.length };
    } catch (e) {}
    return { mentions: [], totalMentions: 0 };
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
    } catch (e) {}
    return null;
  }

  async collectTicker(ticker) {
    console.log(`🔄 ${ticker}...`);
    
    const [reddit, bluesky, stocktwits, news, priceData] = await Promise.all([
      this.collectReddit(ticker),
      this.collectBluesky(ticker),
      this.collectStocktwits(ticker),
      this.collectFinnhubNews(ticker),
      this.collectPriceData(ticker)
    ]);
    
    // Combine all timestamped mentions
    const allMentions = [
      ...reddit.mentions,
      ...bluesky.mentions,
      ...stocktwits.mentions,
      ...news.mentions
    ];
    
    // Store mentions with timestamps
    this.mentionTimestamps.set(ticker, allMentions);
    
    const totalRawMentions = allMentions.length;
    
    const sentiment = stocktwits.bullish + stocktwits.bearish > 0
      ? stocktwits.bullish / (stocktwits.bullish + stocktwits.bearish)
      : 0.5;
    
    const tickerData = {
      ticker,
      rawMentions: totalRawMentions,
      reddit_mentions: reddit.totalMentions,
      bluesky_mentions: bluesky.totalMentions,
      stocktwits_mentions: stocktwits.totalMentions,
      stocktwits_bullish: stocktwits.bullish || 0,
      stocktwits_bearish: stocktwits.bearish || 0,
      news_count: news.totalMentions / 5, // Convert back to article count
      sentiment_score: sentiment,
      currentPrice: priceData?.price || 0,
      previousClose: priceData?.previousClose || 0,
      volume: priceData?.volume || 0,
      lastUpdated: new Date().toISOString()
    };
    
    this.liveData.set(ticker, tickerData);
    
    console.log(`  ✅ ${ticker}: ${totalRawMentions} raw (R:${reddit.totalMentions} B:${bluesky.totalMentions} ST:${stocktwits.totalMentions} N:${Math.round(news.totalMentions/5)})`);
    
    return tickerData;
  }

  // Calculate weighted mentions with exponential decay
  calculateWeightedMentions(ticker, windowMinutes) {
    const mentions = this.mentionTimestamps.get(ticker) || [];
    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    const cutoffTime = now - windowMs;
    
    let weightedSum = 0;
    let rawCount = 0;
    
    mentions.forEach(mention => {
      if (mention.timestamp > cutoffTime) {
        rawCount++;
        
        // Exponential decay: weight = e^(-age/window)
        const age = now - mention.timestamp;
        const weight = Math.exp(-age / windowMs);
        
        weightedSum += weight;
      }
    });
    
    return {
      weighted: weightedSum,
      raw: rawCount
    };
  }

  calculateRelativeHype(windowMinutes) {
    const allData = Array.from(this.liveData.values());
    
    if (allData.length === 0) return;
    
    // Calculate weighted mentions for each ticker
    const weightedMentions = new Map();
    for (const [ticker, data] of this.liveData.entries()) {
      const weighted = this.calculateWeightedMentions(ticker, windowMinutes);
      weightedMentions.set(ticker, weighted);
    }
    
    // Calculate market averages
    const avgWeightedMentions = Array.from(weightedMentions.values())
      .reduce((sum, m) => sum + m.weighted, 0) / allData.length;
    
    const avgVolume = allData.reduce((sum, d) => sum + (d.volume || 0), 0) / allData.length;
    
    // Calculate average volatility
    const avgVolatility = allData.reduce((sum, d) => {
      const pc = this.getPriceChange(d.ticker, windowMinutes);
      return sum + Math.abs(pc.changePercent || 0);
    }, 0) / allData.length;
    
    // Calculate relative hype for each ticker
    for (const [ticker, data] of this.liveData.entries()) {
      const weighted = weightedMentions.get(ticker);
      const mentionRatio = avgWeightedMentions > 0 ? weighted.weighted / avgWeightedMentions : 1;
      const volumeRatio = avgVolume > 0 ? (data.volume || 0) / avgVolume : 1;
      
      const priceChange = this.getPriceChange(ticker, windowMinutes);
      const absPriceChange = Math.abs(priceChange.changePercent || 0);
      const volatilityRatio = avgVolatility > 0 ? absPriceChange / avgVolatility : 1;
      
      let hype = 0;
      hype += Math.min(Math.log10(mentionRatio + 1) * 30, 40);
      hype += Math.min(Math.log10(volumeRatio + 1) * 25, 30);
      hype += Math.min(volatilityRatio * 15, 30);
      
      const sentimentExtremity = Math.abs(data.sentiment_score - 0.5) * 2;
      hype += sentimentExtremity * 10;
      
      data.hypeScore = Math.min(Math.round(hype), 100);
      data.weightedMentions = Math.round(weighted.weighted);
      data.rawMentionsInWindow = weighted.raw;
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
    const olderSnapshots = history.filter(s => s.timestamp <= targetTime);
    
    if (olderSnapshots.length === 0) {
      const oldPrice = history[0].price;
      const currentPrice = history[history.length - 1].price;
      
      if (oldPrice > 0 && currentPrice > 0) {
        return {
          change: currentPrice - oldPrice,
          changePercent: ((currentPrice - oldPrice) / oldPrice) * 100
        };
      }
      return { change: null, changePercent: null };
    }
    
    const oldSnapshot = olderSnapshots[olderSnapshots.length - 1];
    const currentPrice = history[history.length - 1].price;
    const oldPrice = oldSnapshot.price;
    
    if (oldPrice > 0 && currentPrice > 0) {
      return {
        change: currentPrice - oldPrice,
        changePercent: ((currentPrice - oldPrice) / oldPrice) * 100
      };
    }
    
    return { change: null, changePercent: null };
  }

  async startCollection() {
    console.log(`\n🚀 HypeMeter v4.2 - Time-Weighted Mentions`);
    console.log(`📊 Tracking ${this.trackedTickers.size} tickers\n`);
    
    console.log('📈 Backfilling...\n');
    for (const ticker of this.trackedTickers) {
      await this.backfillPriceHistory(ticker);
      await new Promise(r => setTimeout(r, 400));
    }
    console.log('\n✅ Backfill done!\n');
    
    await this.collectAll();
    
    setInterval(() => {
      this.collectAll();
    }, 5 * 60 * 1000);
  }

  async collectAll() {
    const time = new Date().toLocaleTimeString();
    console.log(`\n⏰ ${time}\n`);
    
    for (const ticker of this.trackedTickers) {
      await this.collectTicker(ticker);
      await new Promise(r => setTimeout(r, 700));
    }
    
    // Calculate relative hype with default window
    this.calculateRelativeHype(60);
    
    console.log(`\n✅ Done. R:${this.redditWorking ? '✓' : '✗'} B:${this.blueskyWorking ? '✓' : '✗'}\n`);
  }

  addTicker(ticker) {
    if (!this.trackedTickers.has(ticker)) {
      this.trackedTickers.add(ticker);
      this.backfillPriceHistory(ticker).then(() => {
        this.collectTicker(ticker).then(() => {
          this.calculateRelativeHype(60);
        });
      });
    }
  }

  getData(ticker) {
    return this.liveData.get(ticker) || null;
  }

  getStats() {
    return {
      version: '4.2.0',
      tracked: this.trackedTickers.size,
      cached: this.liveData.size,
      sources: {
        reddit: this.redditWorking,
        bluesky: this.blueskyWorking,
        stocktwits: true,
        finnhub: true
      }
    };
  }
}

const collector = new BackgroundCollector();

app.use(cors({
  origin: ['https://hypemeter.ai', 'https://www.hypemeter.ai', 'https://cooldude-ai.github.io', 'http://localhost:3000'],
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

    const windowMinutes = parseInt(window);
    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = {};
    
    tickerList.forEach(t => collector.addTicker(t));
    
    // Recalculate relative hype for THIS window
    collector.calculateRelativeHype(windowMinutes);
    
    for (const ticker of tickerList) {
      const data = collector.getData(ticker);
      
      if (!data) {
        results[ticker] = { symbol: ticker, hypeScore: 0, mentions: 0, loading: true };
        continue;
      }
      
      const priceChange = collector.getPriceChange(ticker, windowMinutes);
      
      results[ticker] = {
        symbol: ticker,
        hypeScore: data.hypeScore || 0,
        mentions: data.weightedMentions || 0,
        rawMentions: data.rawMentionsInWindow || 0,
        reddit_mentions: data.reddit_mentions,
        bluesky_mentions: data.bluesky_mentions,
        stocktwits_mentions: data.stocktwits_mentions,
        news_count: Math.round(data.news_count),
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

app.get('/', (req, res) => {
  res.json({
    message: 'HypeMeter v4.2 - Time-Weighted + Comments',
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
  console.log(`\n🚀 HypeMeter v4.2.0\n`);
  collector.startCollection();
});
