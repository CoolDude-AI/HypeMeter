const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

class BackgroundCollector {
  constructor() {
    this.liveData = new Map();
    this.priceSnapshots = new Map();
    this.redditToken = null;
    this.redditTokenExpiry = 0;
    this.redditWorking = false;
    
    this.trackedTickers = new Set([
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'NVDA', 'META', 'AMD',
      'GME', 'AMC', 'SPY', 'QQQ', 'COIN', 'NFLX', 'PLTR', 'MSTR', 'SOFI'
    ]);
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
          'User-Agent': 'HypeMeter/3.3'
        },
        body: 'grant_type=client_credentials'
      });

      if (!response.ok) {
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
      this.redditWorking = false;
    }
    return null;
  }

  // REDDIT - Use /new instead of /search (more reliable)
  async collectReddit(ticker) {
    const token = await this.getRedditToken();
    if (!token) return { mentions: 0, posts: 0 };

    const subreddits = [
      'wallstreetbets', 'stocks', 'investing', 'stockmarket', 
      'options', 'daytrading', 'SwingTrading', 'RobinHood'
    ];
    
    let totalMentions = 0;
    let totalPosts = 0;
    const oneHourAgo = Math.floor((Date.now() - (60 * 60 * 1000)) / 1000);
    
    for (const sub of subreddits) {
      try {
        // Get recent posts from /new (100 posts, most recent)
        const url = `https://oauth.reddit.com/r/${sub}/new?limit=100`;
        
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'HypeMeter/3.3'
          }
        });

        if (response.ok) {
          const data = await response.json();
          
          if (data?.data?.children) {
            // Filter to last hour and search for ticker
            const recent = data.data.children.filter(p => p.data.created_utc > oneHourAgo);
            
            recent.forEach(post => {
              const title = (post.data.title || '').toUpperCase();
              const text = (post.data.selftext || '').toUpperCase();
              const combined = `${title} ${text}`;
              
              // Check if ticker is mentioned
              const patterns = [
                new RegExp(`\\$${ticker}\\b`, 'g'),
                new RegExp(`\\b${ticker}\\b`, 'g'),
                new RegExp(`\\b${ticker}\\s`, 'g'),
                new RegExp(`\\s${ticker}\\b`, 'g')
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
        
        await new Promise(r => setTimeout(r, 150));
      } catch (e) {
        console.log(`  Reddit r/${sub} error:`, e.message);
      }
    }
    
    return { mentions: totalMentions, posts: totalPosts };
  }

  async collectStocktwits(ticker) {
    try {
      const response = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`);
      if (!response.ok) return { mentions: 0, bullish: 0, bearish: 0 };
      
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
      return { mentions: 0, bullish: 0, bearish: 0 };
    }
  }

  async collectFinnhubNews(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return { news: 0 };
    
    try {
      const dateStr = new Date().toISOString().split('T')[0];
      const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${dateStr}&to=${dateStr}&token=${apiKey}`;
      
      const response = await fetch(url);
      const news = await response.json();
      
      if (Array.isArray(news)) {
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        const recent = news.filter(a => a.datetime * 1000 > oneHourAgo);
        return { news: recent.length, total: news.length };
      }
    } catch (e) {}
    return { news: 0, total: 0 };
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
      console.log(`  Price error for ${ticker}:`, e.message);
    }
    return null;
  }

  async collectTicker(ticker) {
    console.log(`🔄 ${ticker}...`);
    
    const [reddit, stocktwits, news, priceData] = await Promise.all([
      this.collectReddit(ticker),
      this.collectStocktwits(ticker),
      this.collectFinnhubNews(ticker),
      this.collectPriceData(ticker)
    ]);
    
    // Combine with weights
    let combinedMentions;
    if (this.redditWorking && reddit.mentions > 0) {
      combinedMentions = Math.round(
        (reddit.mentions * 0.40) +
        (stocktwits.mentions * 0.35) +
        (news.news * 5 * 0.25)
      );
    } else {
      combinedMentions = Math.round(
        (stocktwits.mentions * 0.60) +
        (news.news * 6 * 0.40)
      );
    }
    
    const sentiment = stocktwits.bullish + stocktwits.bearish > 0
      ? stocktwits.bullish / (stocktwits.bullish + stocktwits.bearish)
      : 0.5;
    
    const tickerData = {
      ticker,
      mentions: combinedMentions,
      reddit_mentions: reddit.mentions,
      reddit_posts: reddit.posts,
      stocktwits_mentions: stocktwits.mentions,
      stocktwits_bullish: stocktwits.bullish,
      stocktwits_bearish: stocktwits.bearish,
      news_count: news.news,
      news_today: news.total || 0,
      sentiment_score: sentiment,
      currentPrice: priceData?.price || 0,
      previousClose: priceData?.previousClose || 0,
      volume: priceData?.volume || 0,
      lastUpdated: new Date().toISOString()
    };
    
    this.liveData.set(ticker, tickerData);
    
    const vol = priceData?.volume || 0;
    const volStr = vol > 0 ? (vol / 1000000).toFixed(1) + 'M' : '0';
    
    console.log(`  ✅ ${ticker}: ${combinedMentions} mentions (R:${reddit.mentions} ST:${stocktwits.mentions} N:${news.news}) Vol:${volStr} Price:$${priceData?.price || 0}`);
    
    return tickerData;
  }

  getPriceChange(ticker, windowMinutes) {
    const data = this.liveData.get(ticker);
    if (!data) return { change: null, changePercent: null };
    
    const history = this.priceSnapshots.get(ticker);
    
    // If we don't have enough history yet, use 24h change
    if (!history || history.length < 2) {
      if (data.currentPrice && data.previousClose && data.currentPrice > 0 && data.previousClose > 0) {
        const change = data.currentPrice - data.previousClose;
        const changePercent = (change / data.previousClose) * 100;
        return { change, changePercent };
      }
      return { change: null, changePercent: null };
    }
    
    // Find closest snapshot to windowMinutes ago
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

  startCollection() {
    console.log(`\n🚀 Background collector starting...`);
    console.log(`📊 Tracking ${this.trackedTickers.size} tickers`);
    console.log(`⚡ Initial collection starting NOW\n`);
    
    // Start immediately
    this.collectAll();
    
    // Then every 5 minutes
    setInterval(() => {
      this.collectAll();
    }, 5 * 60 * 1000);
  }

  async collectAll() {
    const time = new Date().toLocaleTimeString();
    console.log(`\n⏰ ${time} - Collecting data...\n`);
    
    for (const ticker of this.trackedTickers) {
      await this.collectTicker(ticker);
      await new Promise(r => setTimeout(r, 800));
    }
    
    const redditStatus = this.redditWorking ? '✅' : '⚠️';
    console.log(`\n${redditStatus} Collection complete. Reddit: ${this.redditWorking ? 'Working' : 'Unavailable'}\n`);
  }

  addTicker(ticker) {
    if (!this.trackedTickers.has(ticker)) {
      this.trackedTickers.add(ticker);
      console.log(`➕ ${ticker} added to tracking`);
      this.collectTicker(ticker);
    }
  }

  getData(ticker) {
    return this.liveData.get(ticker) || null;
  }

  getStats() {
    return {
      version: '3.3.0',
      tracked: this.trackedTickers.size,
      cached: this.liveData.size,
      reddit: this.redditWorking ? 'working' : 'unavailable'
    };
  }
}

const collector = new BackgroundCollector();

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
        results[ticker] = {
          symbol: ticker,
          hypeScore: 0,
          mentions: 0,
          price: null,
          volume: 0,
          loading: true
        };
        continue;
      }
      
      const priceChange = collector.getPriceChange(ticker, parseInt(window));
      
      let hype = 0;
      if (data.mentions > 0) hype += Math.min(Math.log10(data.mentions + 1) * 15, 40);
      if (data.volume > 0) hype += Math.min(Math.log10(data.volume / 1000000 + 1) * 20, 30);
      if (priceChange.changePercent !== null) {
        hype += Math.min(Math.abs(priceChange.changePercent) * 3, 25);
      }
      const sentimentExtremity = Math.abs(data.sentiment_score - 0.5) * 2;
      hype += sentimentExtremity * 5;
      
      results[ticker] = {
        symbol: ticker,
        hypeScore: Math.round(hype),
        mentions: data.mentions,
        reddit_mentions: data.reddit_mentions,
        stocktwits_mentions: data.stocktwits_mentions,
        news_count: data.news_count,
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
    message: 'HypeMeter v3.3 - Improved Reddit + Fast Start',
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
  console.log(`\n🚀 HypeMeter v3.3.0 - Port ${PORT}`);
  console.log(`📡 Reddit: ${process.env.REDDIT_CLIENT_ID ? 'Enabled' : 'Disabled'}`);
  console.log(`📡 Finnhub: ${process.env.FINNHUB_API_KEY ? 'Enabled' : 'Disabled'}\n`);
  
  // Start immediately (no delay)
  collector.startCollection();
});
