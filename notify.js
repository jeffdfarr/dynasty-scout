/**
 * Pitcher Scout — Daily Notification Script
 * Sends push notification via ntfy.sh
 *
 * Setup:
 *   1. Install ntfy app on your phone, subscribe to your topic
 *   2. Make sure proxy is running: node server.js
 *   3. Run manually: node notify.js
 *   4. Schedule daily: crontab -e
 *      0 8 * * * cd ~/fantrax-proxy && node notify.js >> ~/fantrax-proxy/notify.log 2>&1
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
  console.error('Local: export FANTRAX_SECRET_ID=yourkey FANTRAX_LEAGUE_ID=yourid');
  process.exit(1);
}
// ─────────────────────────────────────────────────────────────────────────────

const CURRENT_YEAR = String(new Date().getFullYear());
const PREV_YEAR    = String(new Date().getFullYear() - 1);

const PITCHER_POS = new Set(['SP','RP','P','CL','MR','LRP','SRP','CP']);

function fetchJSON(url, timeoutMs=30000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('JSON parse failed for ' + url.split('?')[0] + ': ' + body.slice(0,100))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Timeout fetching: ' + url.split('?')[0]));
    });
  });
}

function fetchCSV(url, timeoutMs=60000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('CSV timeout: ' + url.split('?')[0])); });
  });
}

function normName(n) {
  return n.toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .replace(/ jr$| sr$| ii$| iii$/, '')
    .trim();
}

// FIX #5: Improved CSV parser that handles escaped quotes
function parseCSVLine(line) {
  const fields = [];
  let cur = '', inQ = false;
  for(let i = 0; i < line.length; i++){
    const ch = line[i];
    if(ch === '"'){
      // Handle escaped quotes ("") inside quoted fields
      if(inQ && line[i+1] === '"') {
        cur += '"';
        i++; // skip next quote
      } else {
        inQ = !inQ;
      }
    }
    else if(ch === ',' && !inQ){ fields.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  fields.push(cur.trim());
  return fields;
}

async function fetchXERA(year, timeoutMs=60000) {
  const url = `${CONFIG.proxyBase}/savant/leaderboard/expected_statistics?type=pitcher&year=${year}&position=&team=&min=1&csv=true`;
  const csv = await fetchCSV(url);
  const lines = csv.trim().split('\n');
  if(lines.length < 2) return {};

  const headers = parseCSVLine(lines[0]).map(h => h.replace(/^\uFEFF/, ''));
  const iLast  = headers.indexOf('last_name');
  const iFirst = headers.indexOf('first_name');
  const iXera  = headers.indexOf('xera');
  const iXba   = headers.indexOf('est_ba');
  const iPa    = headers.indexOf('pa');

  const result = {};
  for(let i = 1; i < lines.length; i++){
    const row = parseCSVLine(lines[i]);
    const name = `${row[iFirst]||''} ${row[iLast]||''}`.trim();
    if(!name) continue;
    result[normName(name)] = {
      name,
      xera: iXera >= 0 ? parseFloat(row[iXera]) || null : null,
      xba:  iXba  >= 0 ? parseFloat(row[iXba])  || null : null,
      pa:   iPa   >= 0 ? parseInt(row[iPa])      || 0   : 0,
    };
  }
  return result;
}

const FORTY_MAN_CACHE = path.join(__dirname, '.forty-man-cache.json');
const FORTY_MAN_SEEN_CACHE = path.join(__dirname, '.forty-man-seen.json');
const PITCHER_POS_40 = new Set(['P','SP','RP','CL']);
const FORTY_MAN_HIDE_DAYS = 14; // Hide notified players for 14 days

async function checkFortyManAdditions(stats25, stats26, mlbStats26) {
  try {
    const current = await fetchJSON(`${CONFIG.proxyBase}/forty-man`);

    // Helper to find stats with flexible name matching
    const findStats = (statsObj, name) => {
      if(!statsObj) return null;
      const nn = normName(name);
      return statsObj[nn] || statsObj[name.toLowerCase()] || 
             Object.entries(statsObj).find(([k]) => normName(k) === nn)?.[1] || null;
    };

    // Filter to pitchers only AND prospects (minimal MLB experience)
    const currentPitchers = {};
    Object.entries(current).forEach(([key, p]) => {
      if(!PITCHER_POS_40.has(p.pos)) return;
      
      // Check MLB experience from multiple sources
      const s25 = findStats(stats25, p.name);
      const s26 = findStats(stats26, p.name);
      const mlb = findStats(mlbStats26, p.name);
      
      // Use BF from Savant + games from MLB Stats API
      const totalBF = (s25?.bf || 0) + (s26?.bf || 0);
      const mlbGames = mlb?.gamesPlayed || 0;
      
      // Skip if significant MLB experience (15+ BF or 5+ games this year)
      if(totalBF >= 15 || mlbGames >= 5) {
        return;
      }
      
      currentPitchers[normName(p.name)] = p;
    });

    // Load "seen" cache — players we've already notified about
    let seenCache = {};
    const now = Date.now();
    const HIDE_MS = FORTY_MAN_HIDE_DAYS * 24 * 60 * 60 * 1000;
    try { 
      seenCache = JSON.parse(fs.readFileSync(FORTY_MAN_SEEN_CACHE, 'utf8')); 
      // Clean up expired entries
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

    // Find new additions: in current, not in previous, not recently seen
    const newAdditions = [];
    Object.entries(currentPitchers).forEach(([nn, p]) => {
      // Skip if in previous snapshot
      if(previous[nn]) return;
      // Skip if already notified recently
      if(seenCache[nn]) return;
      
      newAdditions.push(p);
      // Mark as seen
      seenCache[nn] = now;
    });

    // Save current roster as new snapshot
    fs.writeFileSync(FORTY_MAN_CACHE, JSON.stringify(currentPitchers, null, 2));
    // Save updated seen cache
    fs.writeFileSync(FORTY_MAN_SEEN_CACHE, JSON.stringify(seenCache, null, 2));

    if(newAdditions.length > 0) {
      console.log(`40-man additions: ${newAdditions.map(p=>p.name).join(', ')}`);
    } else {
      console.log(`No new 40-man pitcher additions (${Object.keys(currentPitchers).length} prospects tracked, ${Object.keys(seenCache).length} recently notified)`);
    }

    return newAdditions;
  } catch(e) {
    console.log('40-man check failed:', e.message);
    return [];
  }
}

async function run() {
  console.log(`[${new Date().toISOString()}] Starting daily scout...`);

  // 1. Fetch Fantrax data
  console.log('Fetching Fantrax league data...');
  const sid = CONFIG.fantraxSecretId;
  const lid = CONFIG.fantraxLeagueId;
  const [leagueInfo, adpData, rosterData] = await Promise.all([
    fetchJSON(`${CONFIG.proxyBase}/fxea/general/getLeagueInfo?leagueId=${lid}&userSecretId=${sid}`),
    fetchJSON(`${CONFIG.proxyBase}/fxea/general/getAdp?sport=MLB&userSecretId=${sid}`),
    fetchJSON(`${CONFIG.proxyBase}/fxea/general/getTeamRosters?leagueId=${lid}&userSecretId=${sid}`),
  ]);

  // Build id->name and position maps from ADP
  const idToName = {};
  const adpPosMap = {};
  Object.values(adpData).forEach(entry => {
    if(!entry?.id || !entry?.name) return;
    const raw = entry.name;
    const norm = raw.includes(',') ? raw.split(',').map(s=>s.trim()).reverse().join(' ') : raw;
    idToName[entry.id] = norm;
    if(entry.pos) adpPosMap[norm.toLowerCase()] = entry.pos;
  });

  // Build rostered names from rosters
  const rosteredNames = new Set();
  const rosterObj = rosterData.rosters || {};
  Object.values(rosterObj).forEach(team => {
    (team.rosterItems||[]).forEach(pid => {
      const name = idToName[pid] || '';
      if(name) rosteredNames.add(normName(name));
    });
  });

  // Build FA pitcher names from playerInfo
  const playerInfo = leagueInfo.playerInfo || {};
  const faNames = new Set();
  Object.entries(playerInfo).forEach(([pid, p]) => {
    const st = p.status || '';
    if(st === 'FA' || st === 'W') {
      const name = idToName[pid] || '';
      const nn = normName(name);
      // CRITICAL: Double-check they're not actually rostered
      if(name && !rosteredNames.has(nn)) faNames.add(nn);
    }
  });
  // Fallback: ADP minus rostered
  if(faNames.size < 10) {
    Object.values(adpData).forEach(entry => {
      if(!entry?.name) return;
      const raw = entry.name;
      const norm = raw.includes(',') ? raw.split(',').map(s=>s.trim()).reverse().join(' ') : raw;
      const nn = normName(norm);
      if(!rosteredNames.has(nn)) faNames.add(nn);
    });
  }
  console.log(`Found ${faNames.size} FA pitchers in pool (excluded ${rosteredNames.size} rostered)`);

  // 2. Fetch Statcast data (both years in parallel)
  console.log('Fetching Statcast data...');
  const [stats26, stats25, xera26, xera25, recent, aaaStats, mlbStats26] = await Promise.all([
    fetchJSON(`${CONFIG.proxyBase}/savant-stats?year=${CURRENT_YEAR}`, 120000),
    fetchJSON(`${CONFIG.proxyBase}/savant-stats?year=${PREV_YEAR}`, 120000),
    fetchXERA(CURRENT_YEAR),
    fetchXERA(PREV_YEAR),
    fetchJSON(`${CONFIG.proxyBase}/savant-recent`, 120000),
    fetchJSON(`${CONFIG.proxyBase}/aaa-stats`, 60000),
    fetchJSON(`${CONFIG.proxyBase}/mlb-stats?year=${CURRENT_YEAR}`, 60000),
  ]);
  console.log(`Statcast loaded — ${CURRENT_YEAR}: ${Object.keys(stats26).length}, ${PREV_YEAR}: ${Object.keys(stats25).length}, L7: ${Object.keys(recent).length}, AAA: ${Object.keys(aaaStats).length} pitchers`);

  // Check for new 40-man pitcher additions
  console.log('Checking 40-man roster additions...');
  const fortyManAdditions = await checkFortyManAdditions(stats25, stats26, mlbStats26);

  // 3. Merge all stats per pitcher and find FA candidates
  const candidates = [];

  // Load FA notification cache — skip pitchers seen in last 7 days
  const FA_CACHE = path.join(__dirname, '.fa-notify-cache.json');
  let faCacheData = {};
  try { faCacheData = JSON.parse(fs.readFileSync(FA_CACHE, 'utf8')); } catch(e) {}
  const now = Date.now();
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  Object.keys(faCacheData).forEach(k => { if(now - faCacheData[k] > SEVEN_DAYS) delete faCacheData[k]; });

  faNames.forEach(nn => {
    const adpPos = adpPosMap[nn] || '';
    const isPitcher = adpPos.split(',').some(p => PITCHER_POS.has(p.trim()));
    if(!isPitcher && adpPos) return;

    const s26 = stats26[nn] || Object.entries(stats26).find(([k])=>normName(k)===nn)?.[1];
    const s25 = stats25[nn] || Object.entries(stats25).find(([k])=>normName(k)===nn)?.[1];
    const x25 = xera25[nn]  || Object.entries(xera25).find(([k])=>k===nn)?.[1];
    const rec = recent[nn]  || Object.entries(recent).find(([k])=>normName(k)===nn)?.[1];

    if(!s26 && !s25) return;

    const kbb26   = s26?.kbb       ?? null;
    const kbb25   = s25?.kbb       ?? null;
    const kbb7    = rec?.kbb       ?? null;
    const whiff   = s26?.whiff_pct ?? null;
    const whiff25 = s25?.whiff_pct ?? null;
    const bf26    = s26?.bf        || 0;
    const bf25    = s25?.bf        || 0;
    const bf7     = rec?.bf        || 0;
    const name    = s26?.name || s25?.name || nn;
    const pos     = adpPos.split(',')[0] || '?';

    // Skip if notified in last 7 days
    if(faCacheData[nn]) return;

    // 🔥 HOT: dominant with real sample, whiff% is primary signal
    const isDominating = bf26 >= 15 && whiff >= 30 && kbb26 >= 15;
    // 🆕 NEW: fresh callup, high whiff% immediately
    const isCallup     = bf26 >= 4 && bf26 < 60 && whiff >= 28 && kbb26 >= 15;
    // 📈 TRENDING: last 7 days significantly better than season
    const isTrending   = bf7 >= 5 && kbb7 != null && kbb26 != null && kbb7 > kbb26 + 6;
    // ✅ SOLID: reliable option, good sample, decent whiff%
    const isStrongSP   = bf26 >= 8 && whiff >= 24 && kbb26 >= 15;
    // 💤 SLEEPER: great prior year whiff%, no current year data yet
    const isSleeper    = bf26 === 0 && bf25 >= 100 && whiff25 >= 28 && kbb25 >= 15;
    if(!isDominating && !isCallup && !isTrending && !isStrongSP && !isSleeper) return;

    const label = isDominating ? '🔥'
                : isCallup     ? '🆕'
                : isTrending   ? '📈'
                : isStrongSP   ? '✅'
                : '💤';

    // Build stat string
    const k_pct26  = s26?.k_pct  ?? null;
    const bb_pct26 = s26?.bb_pct ?? null;
    const k_pct25  = s25?.k_pct  ?? null;
    const bb_pct25 = s25?.bb_pct ?? null;
    const statParts = [];
    if(bf26)              statParts.push(`${(bf26/3).toFixed(1)}IP`);
    if(k_pct26 != null)   statParts.push(`${k_pct26}%K`);
    if(bb_pct26 != null)  statParts.push(`${bb_pct26}%BB`);
    if(whiff != null)     statParts.push(`${whiff}%Whiff`);
    if(!statParts.length && k_pct25 != null)  statParts.push(`${k_pct25}%K('25)`);
    if(!statParts.length && bb_pct25 != null) statParts.push(`${bb_pct25}%BB('25)`);

    candidates.push({ name, pos, label, statStr: statParts.join(' '), kbb26, whiff, bf26, nn });
  });

  // Load first-saves cache — skip pitchers we've already notified about
  const FIRST_SAVE_CACHE = path.join(__dirname, '.first-save-cache.json');
  let firstSaveSeen = {};
  const FIRST_SAVE_HIDE_DAYS = 14;
  const FIRST_SAVE_HIDE_MS = FIRST_SAVE_HIDE_DAYS * 24 * 60 * 60 * 1000;
  try { 
    firstSaveSeen = JSON.parse(fs.readFileSync(FIRST_SAVE_CACHE, 'utf8')); 
    // Clean up expired entries
    Object.keys(firstSaveSeen).forEach(k => { 
      if(now - firstSaveSeen[k] > FIRST_SAVE_HIDE_MS) delete firstSaveSeen[k]; 
    });
  } catch(e) { firstSaveSeen = {}; }

  // Check for first saves among FA pitchers
  const firstSaveCandidates = [];
  faNames.forEach(nn => {
    const adpPos = adpPosMap[nn] || '';
    const isPitcher = adpPos.split(',').some(p => PITCHER_POS.has(p.trim()));
    if(!isPitcher && adpPos) return;
    const mlb = mlbStats26[nn] || Object.entries(mlbStats26).find(([k])=>normName(k)===normName(nn))?.[1];
    if(!mlb) return;
    if(mlb.saves >= 1 && mlb.saves <= 3) {
      // Skip if already notified recently
      if(firstSaveSeen[nn]) return;
      
      const s26 = stats26[nn] || Object.entries(stats26).find(([k])=>normName(k)===nn)?.[1];
      firstSaveCandidates.push({
        name: mlb.name,
        nn,
        saves: mlb.saves,
        ip: mlb.ip,
        kbb:   s26?.kbb       || null,
        whiff: s26?.whiff_pct || null,
      });
    }
  });

  // Save first-saves seen cache
  firstSaveCandidates.forEach(c => { firstSaveSeen[c.nn] = now; });
  try { fs.writeFileSync(FIRST_SAVE_CACHE, JSON.stringify(firstSaveSeen, null, 2)); } catch(e) {}

  // Sort by label priority then K-BB%
  const labelOrder = {'🔥':0,'🆕':1,'📈':2,'✅':3,'💤':4};
  candidates.sort((a,b) => {
    const lo = (labelOrder[a.label]??9) - (labelOrder[b.label]??9);
    return lo !== 0 ? lo : (b.whiff||0) - (a.whiff||0);
  });

  // Save to FA cache — record timestamp for each candidate
  candidates.forEach(c => { faCacheData[c.nn] = now; });
  try { fs.writeFileSync(FA_CACHE, JSON.stringify(faCacheData, null, 2)); } catch(e) {}

  console.log(`Found ${candidates.length} candidates`);

  // 3b. Find AAA pitchers worth watching — composite filter, no repeats
  const AAA_CACHE = path.join(__dirname, '.aaa-notify-cache.json');
  let prevAAANames = new Set();
  try {
    const prev = JSON.parse(fs.readFileSync(AAA_CACHE, 'utf8'));
    prevAAANames = new Set(prev.names || []);
    // Expire cache after 3 days so guys re-appear if still dominant
    const age = Date.now() - (prev.timestamp || 0);
    if(age > 3 * 24 * 60 * 60 * 1000) prevAAANames = new Set();
  } catch(e) {}

  // Scale AAA thresholds by season progress
  const maxAAAIP = Math.max(...Object.values(aaaStats).map(s=>s.ip||0), 1);
  const aaaFactor = Math.min(1, maxAAAIP / 40);
  const minAAAIP  = Math.max(3,  Math.round(15 * aaaFactor));
  const minAAAK9  = Math.max(7.0, 8.0 * aaaFactor);

  const aaaCandidates = Object.values(aaaStats).filter(p => {
    if((p.ipNum || parseFloat(p.ip) || 0) < minAAAIP) return false;
    if(p.kbb  < 15)       return false;
    if(p.era  > 4.50)     return false;
    if(p.k9   < minAAAK9) return false;
    if(p.bb9  > 5.0)      return false;
    return true;
  }).sort((a, b) => {
    // Composite score: weight K-BB% most, then K/9, then ERA
    const scoreA = (a.kbb * 2) + (a.k9 * 1.5) + ((5.00 - (a.era||5)) * 10);
    const scoreB = (b.kbb * 2) + (b.k9 * 1.5) + ((5.00 - (b.era||5)) * 10);
    return scoreB - scoreA;
  });

  // Split into new finds vs returning
  const newAAA = aaaCandidates.filter(p => !prevAAANames.has(normName(p.name)));
  const aaaToReport = newAAA.length > 0 ? newAAA.slice(0,4) : [];

  // Update cache with current candidates
  try {
    fs.writeFileSync(AAA_CACHE, JSON.stringify({
      names: aaaCandidates.map(p => normName(p.name)),
      timestamp: Date.now()
    }, null, 2));
  } catch(e) { console.warn('AAA cache write failed:', e.message); }

  console.log(`AAA candidates: ${aaaCandidates.length} total, ${newAAA.length} new`);

  // 4. Build notification message — Option A style with dividers
  const top = candidates.slice(0, 4);
  const date = new Date().toLocaleDateString('en-US', {month:'short', day:'numeric'});
  const DIV = '━━━━━━━━━━━━';
  const parts = [`📅 ${date}`, ''];

  if(top.length) {
    parts.push('⚾ FA TARGETS');
    parts.push(DIV);
    top.forEach(c => {
      parts.push(`${c.label} ${c.name}`);
      const statParts = c.statStr.split(' ').filter(Boolean);
      parts.push('   ' + statParts.join('    '));
      parts.push('');
    });
  }

  if(fortyManAdditions.length > 0) {
    if(top.length) parts.push('');
    parts.push('📋 40-MAN ADDITION' + (fortyManAdditions.length > 1 ? 'S' : ''));
    parts.push(DIV);
    fortyManAdditions.slice(0,3).forEach(p => {
      parts.push(`  ➕ ${p.name} (${p.abbr})`);
      const aaa = Object.values(aaaStats).find(a => normName(a.name) === normName(p.name));
      if(aaa) parts.push(`     ${aaa.ip}IP    ${aaa.k_pct != null ? aaa.k_pct+'%K' : '—'}    ${aaa.bb_pct != null ? aaa.bb_pct+'%BB' : '—'}    ${aaa.era != null ? aaa.era.toFixed(2)+' ERA' : '—'}`);
      parts.push('');
    });
    parts.push('');
  }

  if(firstSaveCandidates.length > 0) {
    parts.push('');
    parts.push('💾 FIRST SAVES');
    parts.push(DIV);
    firstSaveCandidates.slice(0,3).forEach(p => {
      parts.push(`  🔐 ${p.name}`);
      parts.push(`  ${p.ip}IP${p.whiff ? '    ' + p.whiff + '%Whiff' : ''}${p.kbb ? '    ' + p.kbb + '%K-BB' : ''}`);
      parts.push('');
    });
  }

  if(aaaToReport.length > 0) {
    if(top.length || fortyManAdditions.length) parts.push('');
    parts.push('🌱 AAA WATCH');
    parts.push(DIV);
    aaaToReport.forEach(p => {
      const org = p.aaaTeam || p.mlbOrg.split(' ').pop();
      parts.push(`  ${p.name} (${org})`);
      parts.push(`  ${p.ip}IP    ${p.k_pct != null ? p.k_pct+'%K' : '—'}    ${p.bb_pct != null ? p.bb_pct+'%BB' : '—'}    ${p.era?.toFixed(2)||'—'} ERA`);
      parts.push('');
    });
  }

  const message = parts.join('\n').trimEnd();

  console.log('\nMessage:\n' + message);

  // Don't send if nothing to report
  if(!fortyManAdditions.length && !candidates.length && !aaaToReport.length && !firstSaveCandidates.length) {
    console.log('Nothing notable today — no notification sent.');
    return;
  }

  // 5. Send via ntfy.sh
  const body = Buffer.from(message, 'utf8');
  console.log(`Sending message (${body.length} bytes):\n${message}`);
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'ntfy.sh',
      port: 443,
      path: `/${CONFIG.ntfyTopic}`,
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        'X-Title': 'Pitcher Scout',
        'X-Priority': '3',
        'X-Tags': 'baseball',
      },
    }, res => {
      let rb = '';
      res.on('data', c => rb += c);
      res.on('end', () => {
        console.log(`ntfy status: ${res.statusCode} — ${rb.slice(0,80)}`);
        resolve();
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  console.log(`Notification sent to ntfy topic: ${CONFIG.ntfyTopic}`);
}

// FIX #3: Export run function for server.js cron job
module.exports = { run };

// FIX #3: Only auto-run when called directly (not when required)
if (require.main === module) {
  run().catch(e => {
    console.error('Error:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
}
