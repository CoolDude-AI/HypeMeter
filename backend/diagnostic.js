// Run this in Render console or locally to test all APIs
// Usage: node diagnostic.js

const fetch = require('node-fetch');

async function testRedditOAuth() {
  console.log('\n=== TESTING REDDIT OAUTH ===');
  
  const clientId = process.env.REDDIT_CLIENT_ID || 'jLr6qOrGk7WI8dGdb0r1og';
  const clientSecret = process.env.REDDIT_CLIENT_SECRET || '-qH-H-2df25nKeBAwlE_RCRIinXybw';
  
  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    
    console.log('Getting token...');
    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'HypeMeter/3.1'
      },
      body: 'grant_type=client_credentials'
    });
    
    console.log(`Status: ${response.status}`);
    const data = await response.json();
    console.log('Response:', JSON.stringify(data, null, 2));
    
    if (data.access_token) {
      console.log('✅ Token obtained!');
      
      // Test actual API call
      console.log('\nTesting search for TSLA...');
      const searchResponse = await fetch(
        'https://oauth.reddit.com/r/wallstreetbets/search?q=TSLA&restrict_sr=1&sort=new&limit=10&t=day',
        {
          headers: {
            'Authorization': `Bearer ${data.access_token}`,
            'User-Agent': 'HypeMeter/3.1'
          }
        }
      );
      
      console.log(`Search status: ${searchResponse.status}`);
      const searchData = await searchResponse.json();
      
      if (searchData.data?.children) {
        console.log(`✅ Found ${searchData.data.children.length} posts`);
        console.log('First post:', searchData.data.children[0]?.data?.title || 'None');
      } else {
        console.log('❌ No data in response');
        console.log('Response:', JSON.stringify(searchData, null, 2).substring(0, 500));
      }
      
    } else {
      console.log('❌ No token received');
    }
    
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function testStocktwits() {
  console.log('\n=== TESTING STOCKTWITS ===');
  
  try {
    const response = await fetch('https://api.stocktwits.com/api/2/streams/symbol/TSLA.json');
    console.log(`Status: ${response.status}`);
    
    const data = await response.json();
    
    if (data.messages) {
      console.log(`✅ Found ${data.messages.length} messages`);
      
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      const recent = data.messages.filter(m => 
        new Date(m.created_at).getTime() > oneHourAgo
      );
      
      console.log(`Recent (last hour): ${recent.length} messages`);
    } else {
      console.log('❌ No messages in response');
    }
    
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function testAlphaVantage() {
  console.log('\n=== TESTING ALPHA VANTAGE ===');
  
  const apiKey = process.env.ALPHA_VANTAGE_KEY || 'ROOZA3T38O56RCVL';
  
  try {
    const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=TSLA&apikey=${apiKey}&limit=10`;
    console.log('URL:', url);
    
    const response = await fetch(url);
    console.log(`Status: ${response.status}`);
    
    const data = await response.json();
    console.log('Response keys:', Object.keys(data));
    
    if (data.feed) {
      console.log(`✅ Found ${data.feed.length} articles`);
      console.log('First article:', data.feed[0]?.title?.substring(0, 100));
    } else if (data.Note) {
      console.log('⚠️ Rate limit message:', data.Note);
    } else if (data.Information) {
      console.log('⚠️ Info:', data.Information);
    } else {
      console.log('❌ Unexpected response:', JSON.stringify(data, null, 2).substring(0, 300));
    }
    
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function testFinnhub() {
  console.log('\n=== TESTING FINNHUB ===');
  
  const apiKey = process.env.FINNHUB_API_KEY;
  
  if (!apiKey) {
    console.log('❌ No Finnhub API key in environment');
    return;
  }
  
  try {
    // Test quote
    console.log('Testing quote...');
    const quoteResponse = await fetch(`https://finnhub.io/api/v1/quote?symbol=TSLA&token=${apiKey}`);
    console.log(`Quote status: ${quoteResponse.status}`);
    const quoteData = await quoteResponse.json();
    console.log('Quote data:', quoteData);
    
    // Test news
    console.log('\nTesting news...');
    const dateStr = new Date().toISOString().split('T')[0];
    const newsUrl = `https://finnhub.io/api/v1/company-news?symbol=TSLA&from=${dateStr}&to=${dateStr}&token=${apiKey}`;
    console.log('News URL:', newsUrl);
    
    const newsResponse = await fetch(newsUrl);
    console.log(`News status: ${newsResponse.status}`);
    const newsData = await newsResponse.json();
    
    if (Array.isArray(newsData)) {
      console.log(`✅ Found ${newsData.length} articles`);
      if (newsData.length > 0) {
        console.log('First article:', newsData[0].headline?.substring(0, 100));
      }
    } else {
      console.log('❌ Not an array:', newsData);
    }
    
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

async function runAllTests() {
  console.log('🔍 API DIAGNOSTICS\n');
  console.log('Environment:');
  console.log('  REDDIT_CLIENT_ID:', process.env.REDDIT_CLIENT_ID ? 'SET' : 'NOT SET');
  console.log('  REDDIT_CLIENT_SECRET:', process.env.REDDIT_CLIENT_SECRET ? 'SET' : 'NOT SET');
  console.log('  ALPHA_VANTAGE_KEY:', process.env.ALPHA_VANTAGE_KEY ? 'SET' : 'NOT SET');
  console.log('  FINNHUB_API_KEY:', process.env.FINNHUB_API_KEY ? 'SET' : 'NOT SET');
  
  await testRedditOAuth();
  await new Promise(r => setTimeout(r, 2000));
  
  await testStocktwits();
  await new Promise(r => setTimeout(r, 2000));
  
  await testAlphaVantage();
  await new Promise(r => setTimeout(r, 2000));
  
  await testFinnhub();
  
  console.log('\n✅ Diagnostics complete\n');
}

runAllTests();
