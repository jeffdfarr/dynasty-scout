# Dynasty Scout — Pitcher Stash Dashboard

A CORS proxy and dashboard for tracking free agent pitchers, bullpen situations, and AAA prospects across your Fantrax dynasty baseball league.

## Features

- **FA Pitchers Tab**: View all available pitchers with Statcast metrics (K%, BB%, Whiff%, K-BB%)
- **Bullpen Watch**: Track closer situations across all 30 MLB teams (LOCKED/EMERGING/COMMITTEE)
- **AAA Prospects**: Monitor top minor league pitchers approaching the majors
- **40-Man Tracking**: Get alerts when pitching prospects are added to 40-man rosters
- **Daily Notifications**: Push notifications via ntfy.sh for new FA targets and roster moves

## Setup

### Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```

3. Start the server:
   ```bash
   npm start
   ```

4. Open http://localhost:3001 in your browser

### Cloud Deployment (Railway)

1. Connect your GitHub repo to Railway
2. Set environment variables in Railway dashboard:
   - `FANTRAX_SECRET_ID`
   - `FANTRAX_LEAGUE_ID`
   - `NTFY_TOPIC`
   - `ENABLE_CRON=true`
3. Railway auto-sets `RAILWAY_PUBLIC_DOMAIN` which configures CORS

## Manual Notification Test

```bash
node notify.js
```

---

## Changelog — v1.0.1 Bug Fixes

### 🔴 Critical Fixes

1. **Fixed undefined `reqOrigin` in proxy error handler** (server.js)
   - The `proxyRequest` function's error handler referenced `reqOrigin` which wasn't in scope
   - Now passes `reqOrigin` as a parameter to `proxyRequest`

2. **Fixed hardcoded year "2026" in `/savant-recent`** (server.js:236)
   - The 7-day recent stats endpoint had a hardcoded year
   - Now uses `String(new Date().getFullYear())` dynamically

3. **Fixed notify.js module exports for cron job** (notify.js + server.js)
   - `notify.js` wasn't exporting `run()`, causing the cron job to fail
   - Added `module.exports = { run }` and wrapped auto-run in `require.main === module` check
   - Updated server.js to properly import and call `notify.run()`

### 🟡 Logic Fixes

4. **Removed duplicate code** (dashboard.html:710-726)
   - Duplicate `G.teams = teams; G.rosters = ...` and cache invalidation lines

5. **Improved CSV parser for escaped quotes** (server.js + notify.js)
   - `parseCSVLine()` now handles `""` escape sequences inside quoted fields

6. **Added dotenv support** (package.json + server.js + notify.js)
   - Added `dotenv` dependency for loading `.env` files locally
   - Added `try { require('dotenv').config(); } catch(e) {}` at startup

### 🟠 Improvements

7. **Added photo cache size limit** (server.js)
   - `server._photoCache` now evicts old entries when it exceeds 500 items
   - Prevents unbounded memory growth in long-running instances

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `/` | Dashboard UI |
| `/savant-stats?year=YYYY` | Aggregated pitcher Statcast data |
| `/savant-recent` | Last 7 days pitcher stats |
| `/mlb-stats` | Traditional MLB pitching stats |
| `/aaa-stats` | AAA pitching leaderboard |
| `/forty-man` | All 30 MLB 40-man rosters |
| `/bullpen-watch` | Bullpen situations by team |
| `/fxea/*` | Fantrax API proxy |

## License

MIT
