const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const app = express();

// Multi-Source Hype Calculator
// Sources: Reddit OAuth, Stocktwits, Alpha Vantage, Finnhub
class MultiSourceHypeCalculator {
  constructor() {
    this.cache = new Map();
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    this.redditToken = null;
    this.redditTokenExpiry = 0;
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

  // REDDIT OAUTH TOKEN
  async getRedditToken() {
    if (this.redditToken && Date.now() < this.redditTokenExpiry) {
      return this.redditToken;
    }

    const clientId = process.env.REDDIT_CLIENT_ID;
    const clientSecret = process.env.REDDIT_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return null;
    }

    try {
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      
      const response = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'HypeMeter/3.0'
        },
        body: 'grant_type=client_credentials'
      });

      const data = await response.json();
      
      if (data.access_token) {
        this.redditToken = data.access_token;
        this.redditTokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
        console.log('✅ Reddit OAuth token obtained');
        return this.redditToken;
      }
    } catch (error) {
      console.error('❌ Reddit OAuth:', error.message);
    }
    return null;
  }

  // 1. REDDIT MENTIONS
  async getRedditMentions(tickerList, windowMinutes) {
    const results = {};
    const token = await this.getRedditToken();
    
    if (!token) {
      console.log('⚠️  Reddit unavailable');
      tickerList.forEach(t => results[t] = { mentions: 0, posts: 0 });
      return results;
    }

    const subreddits = ['wallstreetbets', 'stocks', 'investing', 'stockmarket'];
    console.log(`\n📱 Reddit: ${tickerList.join(', ')}`);
    
    for (const ticker of tickerList) {
      let totalMentions = 0;
      let totalPosts = 0;
      const timeThreshold = Math.floor((Date.now() - (windowMinutes * 60 * 1000)) / 1000);
      
      for (const subreddit of subreddits) {
        try {
          const url = `https://oauth.reddit.com/r/${subreddit}/search?q=${ticker}&restrict_sr=1&sort=new&limit=100&t=day`;
          
          const response = await fetch(url, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'User-Agent': 'HypeMeter/3.0'
            }
          });

          if (response.ok) {
            const data = await response.json();
            
            if (data?.data?.children) {
              const recentPosts = data.data.children.filter(p => p.data.created_utc > timeThreshold);
              totalPosts += recentPosts.length;
              
              recentPosts.forEach(post => {
                const text = `${post.data.title} ${post.data.selftext}`.toUpperCase();
                const regex = new RegExp(`\\b${ticker}\\b`, 'g');
                const matches = text.match(regex) || [];
                totalMentions += matches.length;
              });
            }
          }
          await new Promise(r => setTimeout(r, 300));
        } catch (e) {
          console.log(`  r/${subreddit} error`);
        }
      }
      
      results[ticker] = { mentions: totalMentions, posts: totalPosts };
      console.log(`  ${ticker}: ${totalMentions} mentions in ${totalPosts} posts`);
    }
    
    return results;
  }

  // 2. STOCKTWITS
  async getStocktwitsMentions(tickerList, windowMinutes) {
    const results = {};
    console.log(`\n💬 Stocktwits: ${tickerList.join(', ')}`);
    
    for (const ticker of tickerList) {
      try {
        const response = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`);
        
        if (response.ok) {
          const data = await response.json();
          const timeThreshold = Date.now() - (windowMinutes * 60 * 1000);
          
          const recent = data.messages?.filter(m => 
            new Date(m.created_at).getTime() > timeThreshold
          ) || [];
          
          let bullish = 0, bearish = 0;
          recent.forEach(m => {
            if (m.entities?.sentiment?.basic === 'Bullish') bullish++;
            if (m.entities?.sentiment?.basic === 'Bearish') bearish++;
          });
          
          results[ticker] = {
            mentions: recent.length,
            bullish,
            bearish,
            sentiment: bullish + bearish > 0 ? bullish / (bullish + bearish) : 0.5
          };
          
          console.log(`  ${ticker}: ${recent.length} messages (${bullish}↑ ${bearish}↓)`);
        } else {
          results[ticker] = { mentions: 0, bullish: 0, bearish: 0, sentiment: 0.5 };
        }
        
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        results[ticker] = { mentions: 0, bullish: 0, bearish: 0, sentiment: 0.5 };
      }
    }
    
    return results;
  }

  // 3. ALPHA VANTAGE NEWS SENTIMENT
  async getAlphaVantageNews(tickerList) {
    const results = {};
    const apiKey = process.env.ALPHA_VANTAGE_KEY;
    
    if (!apiKey) {
      tickerList.forEach(t => results[t] = { news: 0, sentiment: 0 });
      return results;
    }
    
    console.log(`\n📰 Alpha Vantage News: ${tickerList.join(', ')}`);
    
    for (const ticker of tickerList) {
      try {
        const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${ticker}&apikey=${apiKey}&limit=50`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.feed) {
          const oneHourAgo = Date.now() - (60 * 60 * 1000);
          const recentNews = data.feed.filter(article => {
            const articleTime = new Date(article.time_published.replace(
              /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/,
              '$1-$2-$3T$4:$5:$6'
            )).getTime();
            return articleTime > oneHourAgo;
          });
          
          let totalSentiment = 0;
          recentNews.forEach(article => {
            const tickerSentiment = article.ticker_sentiment?.find(
              ts => ts.ticker === ticker
            );
            if (tickerSentiment) {
              totalSentiment += parseFloat(tickerSentiment.ticker_sentiment_score || 0);
            }
          });
          
          const avgSentiment = recentNews.length > 0 ? totalSentiment / recentNews.length : 0;
          
          results[ticker] = {
            news: recentNews.length,
            sentiment: avgSentiment,
            sentiment_label: avgSentiment > 0.15 ? 'Bullish' : avgSentiment < -0.15 ? 'Bearish' : 'Neutral'
          };
          
          console.log(`  ${ticker}: ${recentNews.length} articles (sentiment: ${avgSentiment.toFixed(2)})`);
        } else {
          results[ticker] = { news: 0, sentiment: 0, sentiment_label: 'Neutral' };
        }
        
        await new Promise(r => setTimeout(r, 15000)); // Alpha Vantage rate limit
      } catch (e) {
        results[ticker] = { news: 0, sentiment: 0, sentiment_label: 'Neutral' };
      }
    }
    
    return results;
  }

  // 4. FINNHUB NEWS
  async getFinnhubNews(tickerList) {
    const results = {};
    const apiKey = process.env.FINNHUB_API_KEY;
    
    if (!apiKey) {
      tickerList.forEach(t => results[t] = { news: 0 });
      return results;
    }
    
    console.log(`\n📊 Finnhub News: ${tickerList.join(', ')}`);
    
    for (const ticker of tickerList) {
      try {
        const toDate = Math.floor(Date.now() / 1000);
        const fromDate = toDate - (24 * 60 * 60);
        const dateStr = new Date().toISOString().split('T')[0];
        
        const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${dateStr}&to=${dateStr}&token=${apiKey}`;
        
        const response = await fetch(url);
        const news = await response.json();
        
        if (Array.isArray(news)) {
          const oneHourAgo = Date.now() - (60 * 60 * 1000);
          const recent = news.filter(a => a.datetime * 1000 > oneHourAgo);
          
          results[ticker] = { news: recent.length };
          console.log(`  ${ticker}: ${recent.length} articles`);
        } else {
          results[ticker] = { news: 0 };
        }
        
        await new Promise(r => setTimeout(r, 1000));
      } catch (e) {
        results[ticker] = { news: 0 };
      }
    }
    
    return results;
  }

  // COMBINE ALL SOURCES
  async getAllMentions(tickerList, windowMinutes) {
    console.log(`\n🎯 Fetching from ALL sources...`);
    
    const [reddit, stocktwits, alphaNews, finnhubNews] = await Promise.all([
      this.getRedditMentions(tickerList, windowMinutes),
      this.getStocktwitsMentions(tickerList, windowMinutes),
      this.getAlphaVantageNews(tickerList),
      this.getFinnhubNews(tickerList)
    ]);
    
    const combined = {};
    
    for (const ticker of tickerList) {
      const r = reddit[ticker] || { mentions: 0, posts: 0 };
      const st = stocktwits[ticker] || { mentions: 0, sentiment: 0.5, bullish: 0, bearish: 0 };
      const av = alphaNews[ticker] || { news: 0, sentiment: 0 };
      const fh = finnhubNews[ticker] || { news: 0 };
      
      // Weighted combination
      // Reddit: 40%, Stocktwits: 35%, News: 25%
      const totalMentions = Math.round(
        (r.mentions * 0.40) +
        (st.mentions * 0.35) +
        ((av.news + fh.news) * 3 * 0.25) // News has 3x multiplier
      );
      
      // Combined sentiment
      const sentiment = (st.sentiment * 0.6) + ((av.sentiment + 1) / 2 * 0.4);
      
      combined[ticker] = {
        mentions: totalMentions,
        reddit_mentions: r.mentions,
        reddit_posts: r.posts,
        stocktwits_mentions: st.mentions,
        stocktwits_bullish: st.bullish,
        stocktwits_bearish: st.bearish,
        alpha_news: av.news,
        alpha_sentiment: av.sentiment,
        finnhub_news: fh.news,
        sentiment_score: sentiment,
        sentiment_label: sentiment > 0.6 ? 'Bullish' : sentiment < 0.4 ? 'Bearish' : 'Neutral',
        window: windowMinutes,
        timestamp: new Date().toISOString(),
        sources: ['reddit', 'stocktwits', 'alpha_vantage', 'finnhub']
      };
      
      console.log(`\n✅ ${ticker} TOTAL: ${totalMentions} mentions`);
      console.log(`   Reddit: ${r.mentions}, Stocktwits: ${st.mentions}, News: ${av.news + fh.news}`);
    }
    
    return combined;
  }

  // HYPE CALCULATION
  calculateHype(mentions, volume, priceChange, sentiment) {
    let score = 0;
    
    // Mentions (0-40)
    if (mentions > 0) {
      score += Math.min(Math.log10(mentions + 1) * 15, 40);
    }
    
    // Volume (0-30)
    if (volume > 0) {
      score += Math.min(Math.log10(volume / 1000000 + 1) * 20, 30);
    }
    
    // Price volatility (0-25)
    if (priceChange !== null && priceChange !== undefined) {
      score += Math.min(Math.abs(priceChange) * 3, 25);
    }
    
    // Sentiment bonus (0-5)
    const sentimentExtremity = Math.abs(sentiment - 0.5) * 2;
    score += sentimentExtremity * 5;
    
    return Math.round(score);
  }
}

const hypeCalc = new MultiSourceHypeCalculator();

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

// HEALTH
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    version: '3.0.0-multisource',
    sources: {
      reddit: !!process.env.REDDIT_CLIENT_ID,
      stocktwits: true,
      alpha_vantage: !!process.env.ALPHA_VANTAGE_KEY,
      finnhub: !!process.env.FINNHUB_API_KEY
    }
  });
});

// MENTIONS
app.get('/api/mentions', async (req, res) => {
  try {
    const { tickers, window = 60 } = req.query;
    
    if (!tickers) {
      return res.status(400).json({ error: 'Tickers required' });
    }

    const cacheKey = `mentions_${tickers}_${window}`;
    const cached = hypeCalc.getFromCache(cacheKey);
    if (cached) return res.json(cached);

    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = await hypeCalc.getAllMentions(tickerList, window);

    hypeCalc.setCache(cacheKey, results);
    res.json(results);
  } catch (error) {
    console.error('Mentions error:', error);
    res.status(500).json({ error: error.message });
  }
});

// QUOTES
app.get('/api/quotes', async (req, res) => {
  try {
    const { tickers } = req.query;
    const apiKey = process.env.FINNHUB_API_KEY;

    if (!apiKey || !tickers) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    const cacheKey = `quotes_${tickers}`;
    const cached = hypeCalc.getFromCache(cacheKey);
    if (cached) return res.json(cached);

    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    const results = {};

    const promises = tickerList.map(async (ticker) => {
      try {
        const response = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`);
        const data = await response.json();

        if (data.c && data.pc) {
          return {
            ticker,
            data: {
              symbol: ticker,
              currentPrice: data.c,
              previousClose: data.pc,
              change: data.c - data.pc,
              changePercent: ((data.c - data.pc) / data.pc) * 100,
              volume: data.v || 0
            }
          };
        }
      } catch (e) {
        return { ticker, data: { error: 'Failed' } };
      }
    });

    const responses = await Promise.all(promises);
    responses.forEach(({ ticker, data }) => results[ticker] = data);

    hypeCalc.setCache(cacheKey, results);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// HYPE
app.get('/api/hype', async (req, res) => {
  try {
    const { tickers, window = 60 } = req.query;
    
    if (!tickers) {
      return res.status(400).json({ error: 'Tickers required' });
    }

    const cacheKey = `hype_${tickers}_${window}`;
    const cached = hypeCalc.getFromCache(cacheKey);
    if (cached) return res.json(cached);

    const tickerList = tickers.split(',').map(t => t.trim().toUpperCase());
    
    const [mentions, quotes] = await Promise.all([
      hypeCalc.getAllMentions(tickerList, window),
      fetch(`${req.protocol}://${req.get('host')}/api/quotes?tickers=${tickers}`).then(r => r.json())
    ]);

    const results = {};

    for (const ticker of tickerList) {
      const m = mentions[ticker] || {};
      const q = quotes[ticker] || {};

      const hype = hypeCalc.calculateHype(
        m.mentions || 0,
        q.volume || 0,
        q.changePercent,
        m.sentiment_score || 0.5
      );

      results[ticker] = {
        symbol: ticker,
        hypeScore: hype,
        mentions: m.mentions || 0,
        reddit_mentions: m.reddit_mentions || 0,
        stocktwits_mentions: m.stocktwits_mentions || 0,
        news_count: (m.alpha_news || 0) + (m.finnhub_news || 0),
        sentiment: m.sentiment_label || 'Neutral',
        sentiment_score: m.sentiment_score || 0.5,
        price: q.currentPrice || null,
        change: q.change || null,
        changePercent: q.changePercent || null,
        volume: q.volume || null,
        timestamp: new Date().toISOString()
      };
    }

    hypeCalc.setCache(cacheKey, results);
    res.json(results);
  } catch (error) {
    console.error('Hype error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ROOT
app.get('/', (req, res) => {
  res.json({
    message: 'HypeMeter Multi-Source API',
    version: '3.0.0',
    sources: ['Reddit OAuth', 'Stocktwits', 'Alpha Vantage', 'Finnhub'],
    endpoints: {
      mentions: '/api/mentions?tickers=NVDA,TSLA&window=60',
      quotes: '/api/quotes?tickers=NVDA,TSLA',
      hype: '/api/hype?tickers=NVDA,TSLA&window=60'
    }
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
  console.log(`\n🚀 HypeMeter Multi-Source API - Port ${PORT}`);
  console.log(`📡 Data Sources:`);
  console.log(`   ${process.env.REDDIT_CLIENT_ID ? '✅' : '❌'} Reddit OAuth`);
  console.log(`   ✅ Stocktwits`);
  console.log(`   ${process.env.ALPHA_VANTAGE_KEY ? '✅' : '❌'} Alpha Vantage`);
  console.log(`   ${process.env.FINNHUB_API_KEY ? '✅' : '❌'} Finnhub\n`);
});
