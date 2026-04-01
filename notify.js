/**
 * Dynasty Pitcher Scout — Daily Notification Script
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

// ── CREDENTIALS — must be set as environment variables ───────────────────────
// Local: create a .env file or export them in your shell
// Cloud: set in Railway dashboard under Variables
const CONFIG = {
  ntfyTopic:       process.env.NTFY_TOPIC        || 'jeffdynastyscout', // ok to hardcode topic
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

function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    http.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function normName(n) {
  return n.toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .replace(/ jr$| sr$| ii$| iii$/, '')
    .trim();
}

function parseCSVLine(line) {
  const fields = [];
  let cur = '', inQ = false;
  for(let i = 0; i < line.length; i++){
    const ch = line[i];
    if(ch === '"'){ inQ = !inQ; }
    else if(ch === ',' && !inQ){ fields.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  fields.push(cur.trim());
  return fields;
}

async function fetchXERA(year) {
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
const PITCHER_POS_40 = new Set(['P','SP','RP','CL']);

async function checkFortyManAdditions() {
  try {
    const current = await fetchJSON(`${CONFIG.proxyBase}/forty-man`);

    // Filter to pitchers only
    const currentPitchers = {};
    Object.entries(current).forEach(([key, p]) => {
      if(PITCHER_POS_40.has(p.pos)) currentPitchers[key] = p;
    });

    // Load previous snapshot
    let previous = {};
    if(fs.existsSync(FORTY_MAN_CACHE)) {
      try { previous = JSON.parse(fs.readFileSync(FORTY_MAN_CACHE, 'utf8')); }
      catch(e) { previous = {}; }
    }

    // Find new additions (in current but not in previous)
    const newAdditions = [];
    Object.entries(currentPitchers).forEach(([key, p]) => {
      if(!previous[key]) {
        newAdditions.push(p);
      }
    });

    // Save current as new cache
    fs.writeFileSync(FORTY_MAN_CACHE, JSON.stringify(currentPitchers, null, 2));

    if(newAdditions.length > 0) {
      console.log(`40-man additions: ${newAdditions.map(p=>p.name).join(', ')}`);
    } else {
      console.log('No new 40-man pitcher additions since last check');
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
      if(name) faNames.add(normName(name));
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
  console.log(`Found ${faNames.size} FA pitchers in pool`);

  // 2. Fetch Statcast data (both years in parallel)
  console.log('Fetching Statcast data...');
  const [stats26, stats25, xera26, xera25, recent, aaaStats] = await Promise.all([
    fetchJSON(`${CONFIG.proxyBase}/savant-stats?year=2026`),
    fetchJSON(`${CONFIG.proxyBase}/savant-stats?year=2025`),
    fetchXERA('2026'),
    fetchXERA('2025'),
    fetchJSON(`${CONFIG.proxyBase}/savant-recent`),
    fetchJSON(`${CONFIG.proxyBase}/aaa-stats`),
  ]);
  console.log(`Statcast loaded — 2026: ${Object.keys(stats26).length}, 2025: ${Object.keys(stats25).length}, L7: ${Object.keys(recent).length}, AAA: ${Object.keys(aaaStats).length} pitchers`);

  // Check for new 40-man pitcher additions
  console.log('Checking 40-man roster additions...');
  const fortyManAdditions = await checkFortyManAdditions();

  // 3. Merge all stats per pitcher and find FA candidates
  const candidates = [];

  // Calculate season progress factor once before loop
  const maxBF26 = Math.max(...Object.values(stats26).map(s=>s.bf||0), 1);
  console.log(`[notify] Season progress: max BF=${maxBF26}, factor=${Math.min(1, maxBF26/150).toFixed(2)}`);

  faNames.forEach(nn => {
    // Check if pitcher position
    const adpPos = adpPosMap[nn] || '';
    const isPitcher = adpPos.split(',').some(p => PITCHER_POS.has(p.trim()));
    if(!isPitcher && adpPos) return; // skip known non-pitchers

    // Match across all data sources by normalized name
    const s26    = stats26[nn]  || Object.entries(stats26).find(([k])=>normName(k)===nn)?.[1];
    const s25    = stats25[nn]  || Object.entries(stats25).find(([k])=>normName(k)===nn)?.[1];
    const x26    = xera26[nn]   || Object.entries(xera26).find(([k])=>k===nn)?.[1];
    const x25    = xera25[nn]   || Object.entries(xera25).find(([k])=>k===nn)?.[1];
    const rec    = recent[nn]   || Object.entries(recent).find(([k])=>normName(k)===nn)?.[1];

    if(!s26 && !s25 && !x26 && !x25) return; // no data at all

    const kbb26  = s26?.kbb      ?? null;
    const kbb25  = s25?.kbb      ?? null;
    const kbb7   = rec?.kbb      ?? null;
    const xera26v= x26?.xera     ?? null;
    const xera25v= x25?.xera     ?? null;
    const bf26   = s26?.bf       || 0;
    const bf25   = s25?.bf       || 0;
    const bf7    = rec?.bf       || 0;
    const name   = s26?.name || s25?.name || x26?.name || x25?.name || nn;
    const pos    = adpPos.split(',')[0] || '?';

    // ── ALERT CRITERIA ──────────────────────────────────────────────
    // Scale thresholds by season progress
    const earlyFactor = Math.min(1, maxBF26 / 150); // 0=opening day, 1=mid-season
    const minCallupBF  = Math.max(8,  Math.round(25  * earlyFactor));
    const minHotBF     = Math.max(15, Math.round(40  * earlyFactor));
    const minSolidBF   = Math.max(20, Math.round(60  * earlyFactor));
    const minKBBCallup = Math.max(18, Math.round(18  * earlyFactor));
    const minKBBHot    = Math.max(20, Math.round(22  * earlyFactor));
    const minTrendBF   = Math.max(5,  Math.round(15  * earlyFactor));
    const minTrendJump = Math.max(5,  Math.round(8   * earlyFactor));

    // 1. New call-up: small but meaningful sample, elite metrics
    const isCallup = bf26 >= minCallupBF && bf26 < 80 && (
      (kbb26 != null && kbb26 >= minKBBCallup) &&
      (xera26v != null && xera26v < 3.50)
    );
    // 2. HOT: dominating with meaningful sample, MUST have xERA to confirm it's real
    const isDominating = bf26 >= minHotBF && bf26 < 120 && kbb26 >= minKBBHot && xera26v != null && xera26v < 3.50;
    // 3. SOLID SP: larger sample, consistent across both metrics
    const isStrongSP   = bf26 >= minSolidBF && kbb26 >= 15 && xera26v != null && xera26v < 3.50;
    // 4. Sleeper: no 2026 data yet but dominant full 2025 season
    const isSleeper    = bf26 === 0 && bf25 >= 150 && kbb25 >= 20 && (xera25v == null || xera25v < 3.25);
    // 5. Trending up: hot last 7 days
    const isTrending   = bf7 >= minTrendBF && kbb7 != null && kbb26 != null && kbb7 > kbb26 + minTrendJump;
    
    // Early season debug
    if(earlyFactor < 0.3 && false) console.log(`[early season] factor:${earlyFactor.toFixed(2)} minCallupBF:${minCallupBF} minHotBF:${minHotBF}`);
    // ────────────────────────────────────────────────────────────────

    if(!isCallup && !isDominating && !isStrongSP && !isSleeper && !isTrending) return;

    const label = isCallup     ? '🆕'
                : isDominating ? '🔥'
                : isTrending   ? '📈'
                : isStrongSP   ? '✅'
                : '💤';

    // Build stat string
    const statParts = [];
    if(kbb26 != null)   statParts.push(`K-BB:${kbb26}%`);
    if(xera26v != null) statParts.push(`xERA:${xera26v}`);
    if(kbb7 != null && kbb26 != null && kbb7 > kbb26) statParts.push(`↑L7:${kbb7}%`);
    if(bf26)            statParts.push(`${bf26}BF`);
    if(!statParts.length && kbb25 != null)  statParts.push(`'25 K-BB:${kbb25}%`);
    if(!statParts.length && xera25v != null) statParts.push(`'25 xERA:${xera25v}`);

    candidates.push({ name, pos, label, statStr: statParts.join(' '), kbb26, xera26v, bf26 });
  });

  // Sort: dominating/callups first, then by K-BB%
  const labelOrder = { HOT: 0, NEW: 1, TRENDING: 2, SOLID: 3, SLEEPER: 4 };
  candidates.sort((a, b) => {
    if(labelOrder[a.label] !== labelOrder[b.label]) return labelOrder[a.label] - labelOrder[b.label];
    return (b.kbb26||0) - (a.kbb26||0);
  });

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
    if(p.ip   < minAAAIP) return false;
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
  const aaaToReport = newAAA.length > 0 ? newAAA.slice(0,4) : []; // only report new finds

  // Update cache with current candidates
  try {
    fs.writeFileSync(AAA_CACHE, JSON.stringify({
      names: aaaCandidates.map(p => normName(p.name)),
      timestamp: Date.now()
    }, null, 2));
  } catch(e) { console.warn('AAA cache write failed:', e.message); }

  console.log(`AAA candidates: ${aaaCandidates.length} total, ${newAAA.length} new`);

  // 4. Build notification message — keep short for ntfy (under 4KB)
  const top = candidates.slice(0, 4);
  const date = new Date().toLocaleDateString('en-US', {month:'short', day:'numeric'});
  const parts = [];

  if(fortyManAdditions.length > 0) {
    parts.push('📋 40-MAN ADDITION' + (fortyManAdditions.length > 1 ? 'S' : '') + ':');
    fortyManAdditions.slice(0,3).forEach(p => parts.push(`  ➕ ${p.name} (${p.abbr})`));
  }

  if(top.length) parts.push('⚾ FA TARGETS:');
  top.forEach(c => {
    parts.push(`${c.label} ${c.name} ${c.statStr}`);
  });

  if(aaaToReport.length > 0) {
    parts.push('');
    parts.push('🌱 AAA WATCH:');
    aaaToReport.forEach(p => {
      const org = p.aaaTeam || p.mlbOrg.split(' ').pop();
      parts.push(`  ${p.name} (${org}) K-BB:${p.kbb}% K/9:${p.k9} ERA:${p.era?.toFixed(2)||'—'} ${p.ip}IP`);
    });
  }

  const message = parts.join('\n');

  console.log('\nMessage:\n' + message);

  // Don't send if nothing to report
  if(!fortyManAdditions.length && !candidates.length && !aaaToReport.length) {
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
        'X-Title': 'Dynasty Scout',
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

run().catch(e => {
  console.error('Error:', e.message);
  console.error(e.stack);
});
