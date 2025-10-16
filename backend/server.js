const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

// WORKING: Stocktwits + Finnhub (Reddit optional)
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

  // REDDIT TOKEN (Optional - won't break if it fails)
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
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const response = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'HypeMeter/3.2'
        },
        body: 'grant_type=client_credentials'
      });

      if (response.status === 401) {
        console.log('⚠️  Reddit OAuth: 401 Unauthorized - Check app setup');
        this.redditWorking = false;
        return null;
      }

      const data = await response.json();
      if (data.access_token) {
        this.redditToken = data.access_token;
        this.redditTokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
        this.redditWorking = true;
        console.log('✅ Reddit OAuth working');
        return this.redditToken;
      }
    } catch (e) {
      console.log('⚠️  Reddit OAuth error:', e.message);
      this.redditWorking = false;
    }
    return null;
  }

  // REDDIT (Optional - graceful degradation)
  async collectReddit(ticker) {
    const token = await this.getRedditToken();
    if (!token) return { mentions: 0, posts: 0 };

    const subreddits = [
      'wallstreetbets', 'stocks', 'investing', 'stockmarket', 
      'options', 'daytrading', 'SwingTrading'
    ];
    
    let totalMentions = 0;
    let totalPosts = 0;
    const oneHourAgo = Math.floor((Date.now() - (60 * 60 * 1000)) / 1000);
    
    for (const sub of subreddits) {
      try {
        const url = `https://oauth.reddit.com/r/${sub}/search?q=${ticker}&restrict_sr=1&sort=new&limit=250&t=week`;
        
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'HypeMeter/3.2'
          }
        });

        if (response.ok) {
          const data = await response.json();
          
          if (data?.data?.children) {
            const recent = data.data.children.filter(p => p.data.created_utc > oneHourAgo);
            totalPosts += recent.length;
            
            recent.forEach(post => {
              const text = `${post.data.title} ${post.data.selftext}`.toUpperCase();
              const patterns = [
                new RegExp(`\\$${ticker}\\b`, 'g'),
                new RegExp(`\\b${ticker}\\b`, 'g')
              ];
              
              patterns.forEach(p => {
                const matches = text.match(p) || [];
                totalMentions += matches.length;
              });
            });
          }
        }
        
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {}
    }
    
    return { mentions: totalMentions, posts: totalPosts };
  }

  // STOCKTWITS (Primary social source)
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

  // FINNHUB NEWS (Primary news source - working great!)
  async collectFinnhubNews(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return { news: 0, articles: [] };
    
    try {
      const dateStr = new Date().toISOString().split('T')[0];
      const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${dateStr}&to=${dateStr}&token=${apiKey}`;
      
      const response = await fetch(url);
      const news = await response.json();
      
      if (Array.isArray(news)) {
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        const recent = news.filter(a => a.datetime * 1000 > oneHourAgo);
        
        return { 
          news: recent.length,
          total_today: news.length,
          articles: recent.slice(0, 3).map(a => ({
            headline: a.headline,
            source: a.source,
            url: a.url
          }))
        };
      }
    } catch (e) {}
    return { news: 0, articles: [] };
  }

  // PRICE & VOLUME
  async collectPriceData(ticker) {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return null;
    
    try {
      const response = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`);
      const data = await response.json();
      
      if (data.c && data.pc) {
        const snapshot = {
          price: data.c,
          previousClose: data.pc,
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

  // COLLECT ALL FOR ONE TICKER
  async collectTicker(ticker) {
    console.log(`🔄 ${ticker}...`);
    
    const [reddit, stocktwits, news, priceData] = await Promise.all([
      this.collectReddit(ticker),
      this.collectStocktwits(ticker),
      this.collectFinnhubNews(ticker),
      this.collectPriceData(ticker)
    ]);
    
    // Combine mentions with proper weighting
    // If Reddit working: Reddit 40%, Stocktwits 35%, News 25%
    // If Reddit broken: Stocktwits 60%, News 40%
    let combinedMentions;
    if (this.redditWorking && reddit.mentions > 0) {
      combinedMentions = Math.round(
        (reddit.mentions * 0.40) +
        (stocktwits.mentions * 0.35) +
        (news.news * 4 * 0.25)
      );
    } else {
      // Reddit not working - boost other sources
      combinedMentions = Math.round(
        (stocktwits.mentions * 0.60) +
        (news.news * 5 * 0.40)
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
      news_today: news.total_today || 0,
      top_headlines: news.articles || [],
      sentiment_score: sentiment,
      currentPrice: priceData?.price || null,
      previousClose: priceData?.previousClose || null,
      volume: priceData?.volume || 0,
      lastUpdated: new Date().toISOString(),
      sources_working: {
        reddit: this.redditWorking && reddit.mentions > 0,
        stocktwits: stocktwits.mentions > 0,
        news: news.news > 0
      }
    };
    
    this.liveData.set(ticker, tickerData);
    
    const sourcesStr = this.redditWorking 
      ? `R:${reddit.mentions} ST:${stocktwits.mentions} N:${news.news}`
      : `ST:${stocktwits.mentions} N:${news.news} (Reddit: N/A)`;
    
    console.log(`  ✅ ${ticker}: ${combinedMentions} total (${sourcesStr}) Vol:${(priceData?.volume || 0).toLocaleString()}`);
    
    return tickerData;
  }

  // PRICE CHANGE FOR TIMEFRAME
  getPriceChange(ticker, windowMinutes) {
    const history = this.priceSnapshots.get(ticker);
    if (!history || history.length < 2) {
      const data = this.liveData.get(ticker);
      if (data?.currentPrice && data?.previousClose) {
        return {
          change: data.currentPrice - data.previousClose,
          changePercent: ((data.currentPrice - data.previousClose) / data.previousClose) * 100
        };
      }
      return { change: 0, changePercent: 0 };
    }
    
    const targetTime = Date.now() - (windowMinutes * 60 * 1000);
    const sorted = [...history].sort((a, b) => 
      Math.abs(a.timestamp - targetTime) - Math.abs(b.timestamp - targetTime)
    );
    
    const oldPrice = sorted[0].price;
    const currentPrice = history[history.length - 1].price;
    
    return {
      change: currentPrice - oldPrice,
      changePercent: ((currentPrice - oldPrice) / oldPrice) * 100
    };
  }

  // START BACKGROUND COLLECTION
  startCollection() {
    console.log(`\n🚀 Starting background collection for ${this.trackedTickers.size} tickers`);
    console.log(`📡 Sources: Stocktwits (primary) + Finnhub News${this.redditWorking ? ' + Reddit' : ''}\n`);
    
    this.collectAll();
    
    setInterval(() => {
      this.collectAll();
    }, 5 * 60 * 1000);
  }

  async collectAll() {
    const time = new Date().toLocaleTimeString();
    console.log(`\n⏰ ${time} - Collection starting...`);
    
    for (const ticker of this.trackedTickers) {
      await this.collectTicker(ticker);
      await new Promise(r => setTimeout(r, 1000));
    }
    
    console.log(`\n✅ Collection complete. ${this.liveData.size} tickers updated.\n`);
  }

  addTicker(ticker) {
    if (!this.trackedTickers.has(ticker)) {
      this.trackedTickers.add(ticker);
      console.log(`➕ Added ${ticker} to tracking`);
      this.collectTicker(ticker);
    }
  }

  getData(ticker) {
    return this.liveData.get(ticker) || null;
  }

  getStats() {
    return {
      version: '3.2.0',
      tracked_tickers: Array.from(this.trackedTickers),
      cached_tickers: Array.from(this.liveData.keys()),
      sources: {
        reddit: this.redditWorking ? 'working' : 'unavailable',
        stocktwits: 'working',
        finnhub: 'working'
      },
      last_update: this.liveData.size > 0 
        ? Array.from(this.liveData.values())[0].lastUpdated 
        : null
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

// INSTANT HYPE ENDPOINT
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
          loading: true
        };
        continue;
      }
      
      const priceChange = collector.getPriceChange(ticker, parseInt(window));
      
      let hype = 0;
      if (data.mentions > 0) hype += Math.min(Math.log10(data.mentions + 1) * 15, 40);
      if (data.volume > 0) hype += Math.min(Math.log10(data.volume / 1000000 + 1) * 20, 30);
      if (priceChange.changePercent) hype += Math.min(Math.abs(priceChange.changePercent) * 3, 25);
      const sentimentExtremity = Math.abs(data.sentiment_score - 0.5) * 2;
      hype += sentimentExtremity * 5;
      
      results[ticker] = {
        symbol: ticker,
        hypeScore: Math.round(hype),
        mentions: data.mentions,
        reddit_mentions: data.reddit_mentions,
        reddit_posts: data.reddit_posts,
        stocktwits_mentions: data.stocktwits_mentions,
        news_count: data.news_count,
        news_today: data.news_today,
        sentiment: data.sentiment_score > 0.6 ? 'Bullish' : data.sentiment_score < 0.4 ? 'Bearish' : 'Neutral',
        sentiment_score: data.sentiment_score,
        price: data.currentPrice,
        change: priceChange.change,
        changePercent: priceChange.changePercent,
        volume: data.volume,
        name: ticker,
        timestamp: data.lastUpdated,
        sources: data.sources_working
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
      if (data) {
        results[ticker] = {
          symbol: ticker,
          currentPrice: data.currentPrice,
          previousClose: data.previousClose,
          change: data.currentPrice - data.previousClose,
          changePercent: ((data.currentPrice - data.previousClose) / data.previousClose) * 100,
          volume: data.volume,
          timestamp: data.lastUpdated
        };
      }
    }
    
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/mentions', (req, res) => {
  try {
    const { tickers } = req.query;
    if (!tickers) return res.status(400).json({ error: 'Tickers required' });
    
    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = {};
    
    for (const ticker of tickerList) {
      const data = collector.getData(ticker);
      if (data) {
        results[ticker] = {
          mentions: data.mentions,
          reddit_mentions: data.reddit_mentions,
          stocktwits_mentions: data.stocktwits_mentions,
          news_count: data.news_count,
          timestamp: data.lastUpdated,
          sources: data.sources_working
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
    message: 'HypeMeter v3.2 - Stocktwits + Finnhub Focus',
    ...collector.getStats(),
    note: 'Reddit optional - works great without it!'
  });
});

app.get('/keepalive', (req, res) => {
  res.json({ alive: true, ...collector.getStats() });
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
  console.log(`\n🚀 HypeMeter v3.2.0 - Working Sources Focus`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`\n🔑 Sources:`);
  console.log(`   Stocktwits: ✅ (Primary social)`);
  console.log(`   Finnhub: ✅ (News + prices)`);
  console.log(`   Reddit: ${process.env.REDDIT_CLIENT_ID ? '🔧 (Will try)' : '⏭️  (Skipped)'}`);
  console.log(`\n📊 Background collection starts in 10 seconds...\n`);
  
  setTimeout(() => {
    collector.startCollection();
  }, 10000);
});
