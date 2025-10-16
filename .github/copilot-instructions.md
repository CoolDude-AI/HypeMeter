# GitHub Copilot Instructions for HypeMeter

## Project Overview
HypeMeter is a real-time stock hype tracking application that monitors social media mentions across multiple platforms (Reddit, Bluesky, StockTwits) and combines them with price data to calculate hype scores for stocks.

### Architecture
- **Frontend**: Static HTML/CSS/JavaScript (index.html) - hosted on GitHub Pages
- **Backend**: Node.js Express API (backend/server.js) - deployed on Render
- **Main Components**:
  - BackgroundCollector class: Handles data collection from multiple sources
  - Express API endpoints: Serves hype scores and health status
  - Frontend UI: Displays real-time stock hype metrics

## Coding Standards

### JavaScript/Node.js Style
- Use modern ES6+ syntax (const/let, arrow functions, async/await)
- Use semicolons to end statements
- Use single quotes for strings unless interpolating
- Use 2-space indentation
- Prefer arrow functions for callbacks
- Use template literals for string interpolation

### Error Handling
- Always use try-catch blocks for async operations
- Return meaningful error messages
- Log errors to console with context
- Never expose internal error details to API responses
- Handle API failures gracefully with fallback values

### API Design
- All API endpoints should return JSON
- Use appropriate HTTP status codes (200, 400, 500)
- Include CORS headers for frontend access
- Validate all query parameters before use
- Use descriptive parameter names

## Security Practices

### Environment Variables
- **Never commit** API keys, passwords, or secrets to the repository
- All sensitive configuration must be in environment variables
- Reference `.env.example` for required variables
- Required variables:
  - `FINNHUB_API_KEY`: Stock price data API key
  - `REDDIT_CLIENT_ID` & `REDDIT_CLIENT_SECRET`: Reddit API credentials (optional)
  - `BLUESKY_USERNAME` & `BLUESKY_PASSWORD`: Bluesky credentials (optional)
  - `NODE_ENV`: Environment (development/production)
  - `PORT`: Server port (default: 3000)

### API Key Handling
- Check for API key presence before making API calls
- Handle missing API keys gracefully (return empty data, not errors)
- Use appropriate User-Agent headers for API requests
- Implement rate limiting delays between API calls

### CORS Configuration
- Only allow specified origins in production
- Current allowed origins: `hypemeter.ai`, `www.hypemeter.ai`, `cooldude-ai.github.io`, `localhost:3000`
- Include credentials support for authenticated requests

## Data Collection

### Source Priority
1. **Finnhub** (required): Primary source for stock prices and news
2. **StockTwits** (no auth): Real-time stock sentiment
3. **Reddit** (optional auth): Social media mentions and sentiment
4. **Bluesky** (optional auth): Alternative social platform

### Rate Limiting
- Wait at least 200-700ms between API calls to the same service
- Use exponential backoff for retries
- Don't overwhelm free-tier API limits

### Data Processing
- Store timestamped mentions for time-weighted calculations
- Calculate hype scores relative to market averages
- Use exponential decay for time-weighted mentions
- Keep price history (288 data points max, ~24 hours at 5-min intervals)

## Testing

### Current State
- No automated tests currently configured (test script exits with error)
- Manual testing via diagnostic scripts:
  - `diagnostic.js`: Test API connectivity
  - `test-reddit.js`: Test Reddit API integration

### Testing Guidelines
- When adding tests, use Jest for Node.js backend
- Test all API endpoints with various input scenarios
- Mock external API calls in unit tests
- Include edge cases: missing data, API failures, invalid inputs
- Ensure tests can run without API keys (use mocks)

## Building and Running

### Local Development
```bash
# Backend
cd backend
npm install
cp .env.example .env  # Edit with your API keys
npm run dev  # Start with nodemon (auto-reload)
```

### Production Deployment
- Platform: Render (render.yaml configuration)
- Build: `npm install`
- Start: `npm start` (runs `node server.js`)
- Health check: `/health` endpoint
- Auto-deploy on push to main branch

### Frontend
- Static HTML file, no build process
- Deployed to GitHub Pages
- Edit `index.html` directly
- API_BASE_URL points to Render backend

## API Documentation

### Endpoints

#### GET /health
Returns API status and data source availability
```json
{
  "status": "ok",
  "version": "4.2.0",
  "tracked": 17,
  "sources": {
    "reddit": true/false,
    "bluesky": true/false,
    "stocktwits": true,
    "finnhub": true
  }
}
```

#### GET /api/hype?tickers=AAPL,NVDA&window=60
Returns hype scores for requested tickers
- Query params:
  - `tickers` (required): Comma-separated ticker symbols
  - `window` (optional): Time window in minutes (default: 60)
- Response: Object with ticker symbols as keys

## Frontend Guidelines

### UI/UX Principles
- Mobile-first responsive design
- Use gradient backgrounds for visual appeal
- Show loading states during API calls
- Display clear error messages to users
- Include timestamps for data freshness
- Auto-refresh capability with user control

### JavaScript Patterns
- Use async/await for API calls
- Handle errors gracefully with user-friendly messages
- Format numbers (K, M suffixes for large values)
- Format currency with proper locale
- Show loading spinners during async operations

### CSS Standards
- Use CSS Grid and Flexbox for layouts
- Maintain consistent border-radius (8px-15px)
- Use box-shadow for depth
- Smooth transitions (0.3s ease)
- Use CSS variables for consistent colors
- Gradient backgrounds for visual interest

## Version Control

### Commit Messages
- Use descriptive commit messages
- Include context about why changes were made
- Reference issue numbers when applicable

### Branch Strategy
- Main branch is production-ready
- Feature branches for new functionality
- Test changes before merging

## Dependencies

### Backend Dependencies
- `express`: Web framework
- `cors`: CORS middleware
- `node-fetch`: HTTP requests
- `@atproto/api`: Bluesky integration
- `google-trends-api`: (installed but not actively used)

### Adding New Dependencies
- Prefer well-maintained packages with active communities
- Check for security vulnerabilities before adding
- Document why the dependency is needed
- Update package.json with exact versions where stability is critical

## Performance Considerations

### Background Data Collection
- Runs every 5 minutes automatically
- Tracks 17 default tickers
- Dynamically adds requested tickers
- Maintains in-memory cache of live data
- Backfills 24 hours of price history on startup

### Memory Management
- Limit price history to 288 points per ticker
- Clean up old mention timestamps
- Use Map structures for efficient lookups

### Render Platform
- Free tier spins down after inactivity
- Keep-alive mechanism pings server every 14 minutes in production
- First request after spindown may be slow

## Common Patterns

### Adding a New Data Source
1. Create async collector method (e.g., `collectNewSource(ticker)`)
2. Return `{ mentions: [], totalMentions: 0 }` format
3. Add timestamp to each mention
4. Handle authentication if needed
5. Implement graceful failure (return empty data)
6. Add to `collectTicker` Promise.all
7. Update stats/health endpoint

### Adding a New API Endpoint
1. Define route with appropriate HTTP method
2. Validate query parameters
3. Use try-catch for error handling
4. Return JSON response
5. Include appropriate status codes
6. Update frontend to consume new endpoint

## Troubleshooting

### Common Issues
- **API keys not working**: Check .env file exists and has correct values
- **CORS errors**: Verify origin is in allowed list
- **No data returned**: Check if data sources are authenticated
- **Rate limiting**: Reduce request frequency or add delays
- **Frontend can't connect**: Verify API_BASE_URL in index.html

### Debugging
- Check console logs for data collection status
- Use `/health` endpoint to verify source availability
- Test individual collectors with diagnostic scripts
- Check Render logs for production issues
