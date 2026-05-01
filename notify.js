/**
 * Dynasty Scout — Daily Notification Script
 * Sends push notification via ntfy.sh
 *
 * Sections:
 *   🔥 SAVE VULTURES — closers in volatile/committee situations (FA only)
 *   📊 MULTI-INNING STREAMERS — bulk relievers with good matchups
 *   📋 40-MAN ADDITIONS — new pitcher prospects added to rosters
 *
 * Setup:
 *   1. Install ntfy app on your phone, subscribe to your topic
 *   2. Make sure proxy is running: node server.js
 *   3. Run manually: node notify.js
 *   4. Schedule daily: crontab -e
 *      0 8 * * * cd ~/dynasty-scout && node notify.js >> ~/dynasty-scout/notify.log 2>&1
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Load .env file for local development
try { require('dotenv').config(); } catch(e) { /* dotenv optional */ }

// ── CREDENTIALS — must be set as environment variables ───────────────────────
const CONFIG = {
  ntfyTopic:       process.env.NTFY_TOPIC        || 'jeffdynastyscout',
  fantraxSecretId: process.env.FANTRAX_SECRET_ID || '',
  fantraxLeagueId: process.env.FANTRAX_LEAGUE_ID || '',
  proxyBase:       process.env.PROXY_BASE        || 'http://localhost:3001',
};

if(!CONFIG.fantraxSecretId || !CONFIG.fantraxLeagueId) {
  console.error('ERROR: FANTRAX_SECRET_ID and FANTRAX_LEAGUE_ID must be set as environment variables.');
  process.exit(1);
}
// ─────────────────────────────────────────────────────────────────────────────

const PITCHER_POS = new Set(['SP','RP','P','CL','MR','LRP','SRP','CP']);
const PITCHER_POS_40 = new Set(['P','SP','RP','CL']);

function fetchJSON(url, timeoutMs=30000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('JSON parse failed: ' + body.slice(0,100))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function normName(n) {
  return n.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .replace(/ jr$| sr$| ii$| iii$/, '')
    .trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: SAVE VULTURES
// Teams with volatile/committee/emerging closers where FA relievers could grab saves
// ═══════════════════════════════════════════════════════════════════════════

async function getSaveVultures(faNames) {
  console.log('Fetching bullpen-watch for save vultures...');
  const bpData = await fetchJSON(`${CONFIG.proxyBase}/bullpen-watch`);
  
  const vultures = [];
  
  bpData.forEach(team => {
    // Only interested in volatile/committee/emerging situations
    if(!['VOLATILE', 'COMMITTEE', 'EMERGING'].includes(team.situation)) return;
    
    // Find FA relievers on this team with closer potential
    const faCandidates = (team.closerCandidates || []).filter(p => {
      const nn = normName(p.name);
      return faNames.has(nn);
    });
    
    if(faCandidates.length === 0) return;
    
    // Get the top FA candidate
    const top = faCandidates[0];
    const recentBS = top.recentBlownSaves || 0;
    const seasonBS = top.blownSaves || 0;
    
    vultures.push({
      team: team.name.replace(/^(Los Angeles|San Francisco|San Diego|New York|Kansas City|St. Louis|Tampa Bay) /, '').replace(/ (Red Sox|White Sox|Blue Jays)$/, ' $1'),
      situation: team.situation,
      volatile: team.volatile,
      name: top.name,
      saves: top.saves,
      holds: top.holds,
      gf: top.gf,
      recentBS,
      seasonBS,
      closerScore: top.closerScore,
      // Include current closer info for context
      currentCloser: team.closerName,
      closerRecentBS: team.closerRecentBS || 0,
    });
  });
  
  // Sort: VOLATILE first, then by closer score
  vultures.sort((a, b) => {
    if(a.volatile && !b.volatile) return -1;
    if(!a.volatile && b.volatile) return 1;
    const sitOrder = { VOLATILE: 0, COMMITTEE: 1, EMERGING: 2 };
    const sitDiff = (sitOrder[a.situation] || 3) - (sitOrder[b.situation] || 3);
    if(sitDiff !== 0) return sitDiff;
    return (b.closerScore || 0) - (a.closerScore || 0);
  });
  
  console.log(`Found ${vultures.length} save vulture opportunities`);
  return vultures.slice(0, 5);
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: MULTI-INNING STREAMERS
// Bulk relievers with good stuff facing weak offenses
// ═══════════════════════════════════════════════════════════════════════════

async function getMultiInningStreamers(faNames) {
  console.log('Fetching data for multi-inning streamers...');
  
  const [bpData, offense, schedules, restData, savantStats] = await Promise.all([
    fetchJSON(`${CONFIG.proxyBase}/bullpen-watch`),
    fetchJSON(`${CONFIG.proxyBase}/team-offense`),
    fetchJSON(`${CONFIG.proxyBase}/team-schedules`),
    fetchJSON(`${CONFIG.proxyBase}/pitcher-rest`),
    fetchJSON(`${CONFIG.proxyBase}/savant-contact`),
  ]);
  
  const today = new Date().toISOString().split('T')[0];
  
  // Get team abbreviation
  const getTeamAbbr = (teamName) => {
    const abbrevMap = {
      'Arizona Diamondbacks':'ARI','Atlanta Braves':'ATL','Baltimore Orioles':'BAL',
      'Boston Red Sox':'BOS','Chicago Cubs':'CHC','Chicago White Sox':'CWS',
      'Cincinnati Reds':'CIN','Cleveland Guardians':'CLE','Colorado Rockies':'COL',
      'Detroit Tigers':'DET','Houston Astros':'HOU','Kansas City Royals':'KC',
      'Los Angeles Angels':'LAA','Los Angeles Dodgers':'LAD','Miami Marlins':'MIA',
      'Milwaukee Brewers':'MIL','Minnesota Twins':'MIN','New York Mets':'NYM',
      'New York Yankees':'NYY','Oakland Athletics':'OAK','Philadelphia Phillies':'PHI',
      'Pittsburgh Pirates':'PIT','San Diego Padres':'SD','San Francisco Giants':'SF',
      'Seattle Mariners':'SEA','St. Louis Cardinals':'STL','Tampa Bay Rays':'TB',
      'Texas Rangers':'TEX','Toronto Blue Jays':'TOR','Washington Nationals':'WSH'
    };
    return abbrevMap[teamName] || teamName.slice(0,3).toUpperCase();
  };
  
  // Get upcoming games for a team
  const getUpcomingGames = (teamAbbr, numDays = 4) => {
    if(!teamAbbr || !schedules[teamAbbr]) return [];
    const todayDate = new Date();
    const upcoming = [];
    
    for(let i = 0; i < numDays; i++) {
      const checkDate = new Date(todayDate);
      checkDate.setDate(todayDate.getDate() + i);
      const dateStr = checkDate.toISOString().split('T')[0];
      const game = schedules[teamAbbr]?.find(g => g.date === dateStr);
      
      if(game) {
        const oppData = offense[game.opponent] || {};
        upcoming.push({
          opponent: game.opponent,
          wrcPlus: oppData.wrcPlus || null,
          rank: oppData.offenseRank || 15,
        });
      }
    }
    return upcoming;
  };
  
  const streamers = [];
  
  bpData.forEach(team => {
    const teamAbbr = getTeamAbbr(team.name);
    const upcoming = getUpcomingGames(teamAbbr, 4);
    if(upcoming.length === 0) return;
    
    // Calculate avg opponent wRC+
    const withWrc = upcoming.filter(g => g.wrcPlus != null);
    const avgWrcPlus = withWrc.length > 0 
      ? Math.round(withWrc.reduce((sum, g) => sum + g.wrcPlus, 0) / withWrc.length)
      : null;
    
    (team.pitchers || []).forEach(p => {
      const nn = normName(p.name);
      if(!faNames.has(nn)) return;
      if(p.injured) return;
      
      // Parse IP
      const ipParts = String(p.ip || '0').split('.');
      const ipNum = (parseInt(ipParts[0]) || 0) + ((parseInt(ipParts[1]) || 0) / 3);
      const gp = parseInt(p.gp) || 0;
      if(ipNum < 3 || gp < 2) return;
      
      const ipPerGame = gp > 0 ? ipNum / gp : 0;
      if(ipPerGame < 1.4) return;
      
      // Get Savant stats
      const sv = savantStats[nn] || {};
      const k9 = sv.k9 || 0;
      const xwoba = sv.xwoba || null;
      const whip = p.whip || null;
      
      // Filter: K/9 >= 7.5, xwOBA <= .320, WHIP <= 1.20
      if(k9 < 7.5) return;
      if(xwoba != null && xwoba > 0.320) return;
      if(whip != null && whip > 1.20) return;
      
      // Get rest
      const restInfo = restData[nn];
      const daysRest = restInfo?.daysRest ?? null;
      if(daysRest !== null && daysRest < 2) return;
      
      streamers.push({
        name: p.name,
        team: teamAbbr,
        ipPerGame: ipPerGame.toFixed(1),
        k9: k9.toFixed(1),
        xwoba: xwoba ? '.' + String(xwoba).split('.')[1]?.slice(0,3) : null,
        whip: whip?.toFixed(2),
        daysRest,
        avgWrcPlus,
        upcoming: upcoming.slice(0, 3).map(g => g.opponent).join('/'),
      });
    });
  });
  
  // Sort by avg wRC+ (lower = easier matchups = better)
  streamers.sort((a, b) => (a.avgWrcPlus || 100) - (b.avgWrcPlus || 100));
  
  console.log(`Found ${streamers.length} multi-inning streamers`);
  return streamers.slice(0, 5);
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: 40-MAN ADDITIONS
// New pitcher prospects added to 40-man rosters
// ═══════════════════════════════════════════════════════════════════════════

const FORTY_MAN_CACHE = path.join(__dirname, '.forty-man-cache.json');
const FORTY_MAN_SEEN_CACHE = path.join(__dirname, '.forty-man-seen.json');
const FORTY_MAN_HIDE_DAYS = 14;

async function getFortyManAdditions() {
  console.log('Checking 40-man roster additions...');
  
  try {
    const current = await fetchJSON(`${CONFIG.proxyBase}/forty-man`);
    const now = Date.now();
    const HIDE_MS = FORTY_MAN_HIDE_DAYS * 24 * 60 * 60 * 1000;
    
    // Filter to pitchers only
    const currentPitchers = {};
    Object.entries(current).forEach(([key, p]) => {
      if(!PITCHER_POS_40.has(p.pos)) return;
      currentPitchers[normName(p.name)] = p;
    });
    
    // Load "seen" cache
    let seenCache = {};
    try { 
      seenCache = JSON.parse(fs.readFileSync(FORTY_MAN_SEEN_CACHE, 'utf8')); 
      Object.keys(seenCache).forEach(k => { 
        if(now - seenCache[k] > HIDE_MS) delete seenCache[k]; 
      });
    } catch(e) { seenCache = {}; }
    
    // Load previous roster snapshot
    let previous = {};
    if(fs.existsSync(FORTY_MAN_CACHE)) {
      try { previous = JSON.parse(fs.readFileSync(FORTY_MAN_CACHE, 'utf8')); }
      catch(e) { previous = {}; }
    }
    
    // Find new additions
    const newAdditions = [];
    Object.entries(currentPitchers).forEach(([nn, p]) => {
      if(previous[nn]) return;
      if(seenCache[nn]) return;
      newAdditions.push(p);
      seenCache[nn] = now;
    });
    
    // Save caches
    fs.writeFileSync(FORTY_MAN_CACHE, JSON.stringify(currentPitchers, null, 2));
    fs.writeFileSync(FORTY_MAN_SEEN_CACHE, JSON.stringify(seenCache, null, 2));
    
    console.log(`Found ${newAdditions.length} new 40-man additions`);
    return newAdditions.slice(0, 4);
  } catch(e) {
    console.log('40-man check failed:', e.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function run() {
  console.log(`[${new Date().toISOString()}] Starting daily scout...`);
  
  // 1. Fetch Fantrax FA list
  console.log('Fetching Fantrax league data...');
  const faUrl = `${CONFIG.proxyBase}/fantrax/freeAgents?leagueId=${CONFIG.fantraxLeagueId}`;
  const faData = await fetchJSON(faUrl);
  
  const faNames = new Set();
  (faData.responses?.[0]?.data?.rows || []).forEach(row => {
    const name = row.cells?.['1']?.content || '';
    if(name) faNames.add(normName(name));
  });
  console.log(`Found ${faNames.size} free agents in league`);
  
  // 2. Fetch all sections in parallel
  const [vultures, streamers, fortyMan] = await Promise.all([
    getSaveVultures(faNames),
    getMultiInningStreamers(faNames),
    getFortyManAdditions(),
  ]);
  
  // 3. Build notification message
  const date = new Date().toLocaleDateString('en-US', {month:'short', day:'numeric'});
  const DIV = '━━━━━━━━━━━━';
  const parts = [`📅 ${date}`, ''];
  
  // Save Vultures
  if(vultures.length > 0) {
    parts.push('🔥 SAVE VULTURES');
    parts.push(DIV);
    vultures.forEach(v => {
      const sitEmoji = v.volatile ? '⚠️' : (v.situation === 'COMMITTEE' ? '🔄' : '📈');
      parts.push(`${sitEmoji} ${v.name} (${v.team})`);
      const stats = [`${v.saves}SV`, `${v.holds}HLD`, `${v.gf}GF`];
      if(v.recentBS > 0) stats.push(`${v.recentBS}BS`);
      parts.push(`   ${stats.join('  ')}`);
      if(v.currentCloser && v.closerRecentBS > 0) {
        parts.push(`   ↳ ${v.currentCloser}: ${v.closerRecentBS}BS (14d)`);
      }
      parts.push('');
    });
  }
  
  // Multi-Inning Streamers
  if(streamers.length > 0) {
    if(vultures.length > 0) parts.push('');
    parts.push('📊 MULTI-INNING STREAMERS');
    parts.push(DIV);
    streamers.forEach(s => {
      parts.push(`⚾ ${s.name} (${s.team})`);
      const stats = [`${s.ipPerGame}IP/G`, `${s.k9}K/9`];
      if(s.xwoba) stats.push(`${s.xwoba}xwOBA`);
      if(s.daysRest !== null) stats.push(`${s.daysRest}d rest`);
      parts.push(`   ${stats.join('  ')}`);
      parts.push(`   vs ${s.upcoming} (${s.avgWrcPlus || '?'} wRC+)`);
      parts.push('');
    });
  }
  
  // 40-Man Additions
  if(fortyMan.length > 0) {
    if(vultures.length > 0 || streamers.length > 0) parts.push('');
    parts.push('📋 40-MAN ADDITIONS');
    parts.push(DIV);
    fortyMan.forEach(p => {
      parts.push(`➕ ${p.name} (${p.abbr})`);
      parts.push('');
    });
  }
  
  const message = parts.join('\n').trimEnd();
  
  // Don't send if nothing to report
  if(vultures.length === 0 && streamers.length === 0 && fortyMan.length === 0) {
    console.log('Nothing notable today — no notification sent.');
    return;
  }
  
  console.log('\nMessage:\n' + message);
  
  // 4. Send via ntfy.sh
  const body = Buffer.from(message, 'utf8');
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'ntfy.sh',
      port: 443,
      path: `/${CONFIG.ntfyTopic}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        'X-Title': 'Dynasty Scout',
        'X-Priority': '3',
        'X-Tags': 'baseball',
      },
    }, res => {
      let rb = '';
      res.on('data', c => rb += c);
      res.on('end', () => {
        console.log(`ntfy status: ${res.statusCode}`);
        resolve();
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  
  console.log(`Notification sent to ntfy topic: ${CONFIG.ntfyTopic}`);
}

module.exports = { run };

if (require.main === module) {
  run().catch(e => {
    console.error('Error:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
}
