// Reddit OAuth Debug Script
const fetch = require('node-fetch');

async function debugRedditAuth() {
  console.log('\n🔍 REDDIT OAUTH DEBUG\n');
  
  const clientId = process.env.REDDIT_CLIENT_ID || 'jLr6qOrGk7WI8dGdb0r1og';
  const clientSecret = process.env.REDDIT_CLIENT_SECRET || '-qH-H-2df25nKeBAwlE_RCRIinXybw';
  
  console.log('Client ID:', clientId);
  console.log('Client Secret:', clientSecret.substring(0, 5) + '...' + clientSecret.substring(clientSecret.length - 5));
  console.log('Client ID length:', clientId.length);
  console.log('Client Secret length:', clientSecret.length);
  
  // Check for whitespace issues
  if (clientId !== clientId.trim()) {
    console.log('⚠️  WARNING: Client ID has whitespace!');
  }
  if (clientSecret !== clientSecret.trim()) {
    console.log('⚠️  WARNING: Client Secret has whitespace!');
  }
  
  // Try auth
  console.log('\n--- Attempting OAuth ---\n');
  
  const auth = Buffer.from(`${clientId.trim()}:${clientSecret.trim()}`).toString('base64');
  console.log('Auth header (first 20 chars):', auth.substring(0, 20) + '...');
  
  try {
    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'HypeMeter/3.2'
      },
      body: 'grant_type=client_credentials'
    });
    
    console.log('Status:', response.status);
    console.log('Status Text:', response.statusText);
    
    const responseText = await response.text();
    console.log('\nRaw Response:');
    console.log(responseText);
    
    try {
      const data = JSON.parse(responseText);
      console.log('\nParsed Response:');
      console.log(JSON.stringify(data, null, 2));
      
      if (data.access_token) {
        console.log('\n✅ SUCCESS! Got token:', data.access_token.substring(0, 20) + '...');
        console.log('Token type:', data.token_type);
        console.log('Expires in:', data.expires_in, 'seconds');
        
        // Test actual API call
        console.log('\n--- Testing API Call ---\n');
        
        const testResponse = await fetch(
          'https://oauth.reddit.com/r/wallstreetbets/hot?limit=5',
          {
            headers: {
              'Authorization': `Bearer ${data.access_token}`,
              'User-Agent': 'HypeMeter/3.2'
            }
          }
        );
        
        console.log('API Test Status:', testResponse.status);
        
        if (testResponse.ok) {
          const testData = await testResponse.json();
          if (testData.data?.children) {
            console.log(`✅ API WORKS! Got ${testData.data.children.length} posts`);
            console.log('First post:', testData.data.children[0]?.data?.title?.substring(0, 80));
          }
        } else {
          const errorText = await testResponse.text();
          console.log('❌ API call failed:', errorText);
        }
        
      } else if (data.error) {
        console.log('\n❌ Error:', data.error);
        console.log('Message:', data.message);
        
        if (data.error === 401 || response.status === 401) {
          console.log('\n💡 POSSIBLE FIXES:');
          console.log('1. Double-check Client ID and Secret in Render (no extra spaces)');
          console.log('2. Make sure app type is "web app" not "script"');
          console.log('3. Try deleting and recreating the Reddit app');
          console.log('4. Check if Reddit app is for the correct Reddit account');
        }
      }
      
    } catch (parseError) {
      console.log('Failed to parse response as JSON');
    }
    
  } catch (error) {
    console.log('\n❌ Request failed:', error.message);
  }
  
  console.log('\n--- Debug Complete ---\n');
}

debugRedditAuth();
