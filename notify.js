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

// ── CONFIGURE THESE ──────────────────────────────────────────────────────────
const CONFIG = {
  ntfyTopic: 'jeffdynastyscout',
  fantraxSecretId: 'yrhnzbzbkyypk78k',
  fantraxLeagueId: 'bhbev187mhox8axz',
  proxyBase: 'http://localhost:3001',
};
// ─────────────────────────────────────────────────────────────────────────────

const PITCHER_POS = new Set(['SP','RP','P','CL','MR','LRP','SRP','CP']);

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('JSON parse failed for ' + url + ': ' + body.slice(0,100))); }
      });
    }).on('error', reject);
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
  const [leagueInfo, adpData, rosterData] = await Promise.all([
    fetchJSON(`${CONFIG.proxyBase}/fxea/general/getLeagueInfo?leagueId=${CONFIG.fantraxLeagueId}`),
    fetchJSON(`${CONFIG.proxyBase}/fxea/general/getAdp?sport=MLB`),
    fetchJSON(`${CONFIG.proxyBase}/fxea/general/getTeamRosters?leagueId=${CONFIG.fantraxLeagueId}`),
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
  const [stats26, stats25, xera26, xera25, recent] = await Promise.all([
    fetchJSON(`${CONFIG.proxyBase}/savant-stats?year=2026`),
    fetchJSON(`${CONFIG.proxyBase}/savant-stats?year=2025`),
    fetchXERA('2026'),
    fetchXERA('2025'),
    fetchJSON(`${CONFIG.proxyBase}/savant-recent`),
  ]);
  console.log(`Statcast loaded — 2026: ${Object.keys(stats26).length}, 2025: ${Object.keys(stats25).length}, L7: ${Object.keys(recent).length} pitchers`);

  // Check for new 40-man pitcher additions
  console.log('Checking 40-man roster additions...');
  const fortyManAdditions = await checkFortyManAdditions();

  // 3. Merge all stats per pitcher and find FA candidates
  const candidates = [];

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
    // 1. New call-up: appeared in 2026 (bf > 1) with elite K-BB% or xERA
    const isCallup = bf26 > 1 && bf26 < 40 && (
      (kbb26 != null && kbb26 >= 15) ||
      (xera26v != null && xera26v < 3.50)
    );
    // 2. Dominating reliever: meaningful 2026 sample, elite K-BB% + good xERA
    const isDominating = bf26 >= 15 && kbb26 >= 20 && (xera26v == null || xera26v < 3.75);
    // 3. Strong SP: good 2026 sample, solid across both metrics
    const isStrongSP   = bf26 >= 40 && kbb26 >= 15 && xera26v != null && xera26v < 3.75;
    // 4. Sleeper: no 2026 data yet but dominant 2025 season
    const isSleeper    = bf26 === 0 && bf25 >= 100 && kbb25 >= 18 && (xera25v == null || xera25v < 3.50);
    // 5. Trending up: last 7 days K-BB% significantly better than season avg
    const isTrending   = bf7 >= 5 && kbb7 != null && kbb26 != null && kbb7 > kbb26 + 5;
    // ────────────────────────────────────────────────────────────────

    if(!isCallup && !isDominating && !isStrongSP && !isSleeper && !isTrending) return;

    const label = isCallup     ? 'NEW'
                : isDominating ? 'HOT'
                : isTrending   ? 'TRENDING'
                : isStrongSP   ? 'SOLID'
                : 'SLEEPER';

    // Build stat string
    const statParts = [];
    if(kbb26 != null)   statParts.push(`K-BB:${kbb26}%`);
    if(kbb7 != null)    statParts.push(`L7:${kbb7}%`);
    if(xera26v != null) statParts.push(`xERA:${xera26v}`);
    if(bf26)            statParts.push(`${bf26}BF`);
    if(!statParts.length && kbb25 != null)  statParts.push(`'25:K-BB:${kbb25}%`);
    if(!statParts.length && xera25v != null) statParts.push(`'25:xERA:${xera25v}`);

    // Detect new pitch types vs 2025
    const mix26 = s26?.pitchMix || {};
    const mix25 = s25?.pitchMix || {};
    const newPitches = [];
    Object.entries(mix26).forEach(([pitch, pct26]) => {
      const pct25 = mix25[pitch] || 0;
      if(pct25 === 0 && pct26 >= 5) newPitches.push(`NEW:${pitch}(${pct26}%)`);
      else if(pct26 - pct25 >= 10) newPitches.push(`+${pitch}(${pct25}%→${pct26}%)`);
    });
    if(newPitches.length) statParts.push(newPitches.join(' '));

    candidates.push({ name, pos, label, statStr: statParts.join(' '), kbb26, xera26v, bf26 });
  });

  // Sort: dominating/callups first, then by K-BB%
  const labelOrder = { HOT: 0, NEW: 1, TRENDING: 2, SOLID: 3, SLEEPER: 4 };
  candidates.sort((a, b) => {
    if(labelOrder[a.label] !== labelOrder[b.label]) return labelOrder[a.label] - labelOrder[b.label];
    return (b.kbb26||0) - (a.kbb26||0);
  });

  console.log(`Found ${candidates.length} candidates`);

  // 4. Build notification message — keep short for ntfy (under 4KB)
  const top = candidates.slice(0, 5);
  const date = new Date().toLocaleDateString('en-US', {month:'short', day:'numeric'});
  const parts = [];

  if(fortyManAdditions.length > 0) {
    parts.push('40-MAN: ' + fortyManAdditions.slice(0,3).map(p=>`${p.name} (${p.abbr})`).join(', '));
  }

  top.forEach(c => {
    parts.push(`[${c.label}] ${c.name} ${c.statStr}`);
  });

  const message = parts.join('\n');

  console.log('\nMessage:\n' + message);

  // Don't send if nothing to report
  if(!fortyManAdditions.length && !candidates.length) {
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
