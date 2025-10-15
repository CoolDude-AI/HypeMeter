// Reddit API Diagnostic Tool
// Run this locally to see what Reddit actually returns

const fetch = require('node-fetch');

async function testRedditAPI() {
  const ticker = 'TSLA';
  const subreddit = 'wallstreetbets';
  
  console.log('\n=== REDDIT API DIAGNOSTIC ===\n');
  console.log(`Testing: ${ticker} in r/${subreddit}\n`);
  
  // Test 1: Basic search
  console.log('TEST 1: Basic search with no auth');
  const url1 = `https://www.reddit.com/r/${subreddit}/search.json?q=${ticker}&restrict_sr=1&sort=new&limit=10&t=day`;
  console.log(`URL: ${url1}\n`);
  
  try {
    const response1 = await fetch(url1, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    console.log(`Status: ${response1.status}`);
    console.log(`Headers:`, Object.fromEntries(response1.headers.entries()));
    
    const text1 = await response1.text();
    console.log(`\nRaw response length: ${text1.length} characters`);
    console.log(`First 500 chars:\n${text1.substring(0, 500)}\n`);
    
    try {
      const data1 = JSON.parse(text1);
      
      if (data1.error) {
        console.log(`❌ Reddit returned error: ${data1.error} - ${data1.message}`);
      } else if (data1.data && data1.data.children) {
        console.log(`✅ Success! Found ${data1.data.children.length} posts`);
        
        // Show first 3 posts
        console.log('\nFirst 3 posts:');
        data1.data.children.slice(0, 3).forEach((post, i) => {
          const p = post.data;
          console.log(`\n${i + 1}. ${p.title}`);
          console.log(`   Created: ${new Date(p.created_utc * 1000).toISOString()}`);
          console.log(`   Author: ${p.author}`);
          console.log(`   Score: ${p.score}`);
          console.log(`   URL: https://reddit.com${p.permalink}`);
        });
        
        // Count mentions
        const now = Date.now();
        const oneHourAgo = Math.floor((now - (60 * 60 * 1000)) / 1000);
        
        let mentions = 0;
        let recentPosts = 0;
        
        data1.data.children.forEach(post => {
          if (post.data.created_utc > oneHourAgo) {
            recentPosts++;
            const title = (post.data.title || '').toUpperCase();
            const text = (post.data.selftext || '').toUpperCase();
            const combined = `${title} ${text}`;
            
            const regex = new RegExp(`\\b${ticker}\\b`, 'gi');
            const matches = combined.match(regex) || [];
            mentions += matches.length;
          }
        });
        
        console.log(`\n📊 RESULTS:`);
        console.log(`   Total posts returned: ${data1.data.children.length}`);
        console.log(`   Posts in last hour: ${recentPosts}`);
        console.log(`   Mentions of ${ticker}: ${mentions}`);
        
      } else {
        console.log('❌ Unexpected response structure');
        console.log('Data structure:', JSON.stringify(data1, null, 2).substring(0, 1000));
      }
    } catch (parseError) {
      console.log(`❌ Failed to parse JSON: ${parseError.message}`);
    }
    
  } catch (error) {
    console.log(`❌ Request failed: ${error.message}`);
  }
  
  console.log('\n\n=== TEST 2: Try /r/wallstreetbets/new.json ===\n');
  
  // Test 2: Try getting new posts directly
  const url2 = `https://www.reddit.com/r/${subreddit}/new.json?limit=25`;
  console.log(`URL: ${url2}\n`);
  
  try {
    const response2 = await fetch(url2, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    console.log(`Status: ${response2.status}`);
    
    const data2 = await response2.json();
    
    if (data2.data && data2.data.children) {
      console.log(`✅ Got ${data2.data.children.length} recent posts`);
      
      // Search through them for ticker
      let found = 0;
      data2.data.children.forEach(post => {
        const title = (post.data.title || '').toUpperCase();
        if (title.includes(ticker)) {
          found++;
          console.log(`   Found: "${post.data.title}"`);
        }
      });
      
      console.log(`\nPosts mentioning ${ticker}: ${found}`);
    }
    
  } catch (error) {
    console.log(`❌ Request failed: ${error.message}`);
  }
  
  console.log('\n\n=== RECOMMENDATIONS ===\n');
  console.log('If you see HTTP 429: Reddit is rate limiting you');
  console.log('If you see HTTP 403: Try different User-Agent');
  console.log('If you see 0 posts: Reddit search might be broken, use /new.json instead');
  console.log('If parsing fails: Reddit might be returning HTML instead of JSON');
  console.log('\n');
}

// Run the diagnostic
testRedditAPI();
