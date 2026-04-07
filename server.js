const http = require('http');
const https = require('https');
const fs = require('fs');
const nodePath = require('path');

// Load .env file for local development
try { require('dotenv').config(); } catch(e) { /* dotenv optional */ }

const PORT = process.env.PORT || 3001;
const FANTRAX_HOST = 'www.fantrax.com';

const IS_PRODUCTION = !!process.env.RAILWAY_PUBLIC_DOMAIN || !!process.env.ALLOWED_ORIGIN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

function setCORS(res, reqOrigin) {
  if(IS_PRODUCTION && ALLOWED_ORIGIN) {
    // In production lock to specific origin
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
  } else {
    // Locally allow everything (file://, localhost, etc.)
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
  });
}

// FIX #1: Added reqOrigin parameter to fix undefined variable bug
function proxyRequest(hostname, path, method, headers, body, res, reqOrigin) {
  const options = { hostname, port: 443, path, method, headers };
  if (body) options.headers['Content-Length'] = Buffer.byteLength(body);

  const proxy = https.request(options, (upstream) => {
    console.log(`[proxy] ${hostname} responded ${upstream.statusCode}`);
    let responseBody = '';
    upstream.on('data', chunk => responseBody += chunk);
    upstream.on('end', () => {
      // Log errors from upstream for debugging
      if (upstream.statusCode >= 400) {
        console.log(`[proxy] error body: ${responseBody.slice(0, 500)}`);
      }
      // Set CORS headers
      setCORS(res, reqOrigin);
      res.writeHead(upstream.statusCode, {
        'Content-Type': upstream.headers['content-type'] || 'application/json',
      });
      res.end(responseBody);
    });
  });

  proxy.on('error', (err) => {
    console.error('[proxy] request error:', err.message);
    setCORS(res, reqOrigin);  // FIX: Now reqOrigin is in scope
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });

  if (body) proxy.write(body);
  proxy.end();
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

// FIX #7: Photo cache with size limit
const MAX_PHOTO_CACHE_SIZE = 500;
function addToPhotoCache(server, playerId, data, type) {
  if(!server._photoCache) server._photoCache = {};
  
  // Evict oldest entries if cache is full
  const keys = Object.keys(server._photoCache);
  if(keys.length >= MAX_PHOTO_CACHE_SIZE) {
    // Remove first 50 entries (simple FIFO eviction)
    keys.slice(0, 50).forEach(k => delete server._photoCache[k]);
    console.log('[proxy] photo cache evicted 50 entries');
  }
  
  server._photoCache[playerId] = { data, type, ts: Date.now() };
}

const server = http.createServer(async (req, res) => {
  const reqOrigin = req.headers.origin || '';
  setCORS(res, reqOrigin);

  const path = req.url?.split('?')[0] || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // /fangraphs/* -> fangraphs.com
  if (path.startsWith('/fangraphs/')) {
    const fgPath = req.url.replace('/fangraphs', '');
    const body = await readBody(req);
    console.log(`[proxy] GET https://www.fangraphs.com${fgPath}`);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/csv,text/html,application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    proxyRequest('www.fangraphs.com', fgPath, 'GET', headers, '', res, reqOrigin);
    return;
  }

  // /savant-stats -> fetch & aggregate pitcher K%, BB%, Whiff% from statcast
  if (path.startsWith('/savant-stats')) {
    const params = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
    const year = params.get('year') || String(new Date().getFullYear());
    const statcastUrl = `/statcast_search/csv?all=true&hfGT=R%7C&hfSea=${year}%7C&player_type=pitcher&group_by=name&min_pitches=1&min_pas=1&sort_col=pitches&sort_order=desc&type=details&csv=true`;
    console.log(`[proxy] fetching statcast ${year} pitcher data...`);
    const opts = {
      hostname: 'baseballsavant.mlb.com', port: 443, path: statcastUrl, method: 'GET',
      headers: {'User-Agent':'Mozilla/5.0','Accept':'text/csv,*/*'}
    };
    const pr = https.request(opts, sr => {
      let body = '';
      sr.on('data', c => body += c);
      sr.on('end', () => {
        const lines = body.trim().split('\n');
        if(lines.length < 2){ res.writeHead(500); res.end('{}'); return; }

        const headers = parseCSVLine(lines[0]).map(h => h.replace(/^\uFEFF/,'').replace(/^﻿/,''));
        const col = name => headers.indexOf(name);
        const iName   = col('player_name');
        const iPitcherId = col('pitcher');
        const iEvents = col('events');
        const iDesc   = col('description');
        const iOuts   = col('outs_when_up');
        const iTeam   = col('home_team');
        const iAwayTeam = col('away_team');
        const iPitch  = col('pitch_name');
        
        // Aggregate per pitcher
        const pitchers = {};
        for(let i = 1; i < lines.length; i++){
          if(!lines[i].trim()) continue;
          const row = parseCSVLine(lines[i]);
          const name = row[iName] || '';
          if(!name) continue;
          if(!pitchers[name]) pitchers[name] = {pitches:0, swstr:0, bf:0, k:0, bb:0, outs:0, teams:{}, pitchTypes:{}, mlbId:''};
          if(iPitcherId >= 0 && row[iPitcherId] && !pitchers[name].mlbId) pitchers[name].mlbId = row[iPitcherId].trim();
          const p = pitchers[name];
          p.pitches++;
          const pitchType = iPitch >= 0 ? (row[iPitch]||'').trim() : '';
          if(pitchType && pitchType !== 'null') {
            p.pitchTypes[pitchType] = (p.pitchTypes[pitchType]||0) + 1;
          }
          const desc = row[iDesc] || '';
          const ev   = row[iEvents] || '';
          if(desc === 'swinging_strike' || desc === 'swinging_strike_blocked') p.swstr++;
          if(ev && ev !== 'null') {
            p.bf++;
            if(ev === 'strikeout' || ev === 'strikeout_double_play') { p.k++; p.outs++; }
            else if(ev === 'walk' || ev === 'intent_walk' || ev === 'hit_by_pitch') {} // no out
            else if(ev === 'field_out' || ev === 'grounded_into_double_play' || ev === 'double_play'
                 || ev === 'force_out' || ev === 'fielders_choice_out' || ev === 'other_out'
                 || ev === 'sac_fly' || ev === 'sac_bunt' || ev === 'triple_play') { p.outs++; }
            if(ev === 'walk' || ev === 'intent_walk') p.bb++;
          }
          // Track both home and away teams, pick most frequent = pitcher's team
          const ht = row[iTeam] || '';
          const at = iAwayTeam >= 0 ? (row[iAwayTeam]||'') : '';
          if(ht){ p.teams = p.teams||{}; p.teams[ht] = (p.teams[ht]||0)+1; }
          if(at){ p.teams = p.teams||{}; p.teams[at] = (p.teams[at]||0)+1; }
        }

        // Compute rates
        const result = {};
        Object.entries(pitchers).forEach(([name, p]) => {
          if(p.bf < 1) return;
          // Normalize name: "Last, First" -> "First Last"
          const normalized = name.includes(',')
            ? name.split(',').map(s=>s.trim()).reverse().join(' ')
            : name;
          const pitchMix = {};
          Object.entries(p.pitchTypes||{}).forEach(([type, count]) => {
            pitchMix[type] = parseFloat((count / p.pitches * 100).toFixed(1));
          });

          const totalOuts = p.outs || 0;
          const ipWhole = Math.floor(totalOuts / 3);
          const ipRem   = totalOuts % 3;
          const ipStr   = `${ipWhole}.${ipRem}`;
          const ipDec   = ipWhole + ipRem / 3;

          result[normalized.toLowerCase()] = {
            name: normalized,
            mlbId: p.mlbId || '',
            ip: ipStr,
            ipNum: parseFloat(ipDec.toFixed(3)),
            k_pct: p.bf > 0 ? parseFloat((p.k / p.bf * 100).toFixed(1)) : 0,
            bb_pct: p.bf > 0 ? parseFloat((p.bb / p.bf * 100).toFixed(1)) : 0,
            kbb: p.bf > 0 ? parseFloat(((p.k - p.bb) / p.bf * 100).toFixed(1)) : 0,
            whiff_pct: p.pitches > 0 ? parseFloat((p.swstr / p.pitches * 100).toFixed(1)) : 0,
            bf: p.bf,
            team: p.teams ? Object.entries(p.teams).sort((a,b)=>b[1]-a[1])[0]?.[0] || '' : '',
            pitchMix,
          };
        });

        setCORS(res, reqOrigin);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(result));
      });
    });
    pr.on('error', e => {
      console.error('[proxy] statcast error:', e.message);
      res.writeHead(502); res.end('{}');
    });
    pr.end();
    return;
  }

  // /savant-contact -> fetch contact quality metrics (hard hit%, barrel%, avg EV) for pitchers
  if (path.startsWith('/savant-contact')) {
    const params = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
    const year = params.get('year') || String(new Date().getFullYear());
    // Use statcast leaderboard for exit velocity and barrels (pitcher view)
    const statcastUrl = `/leaderboard/statcast?type=pitcher&year=${year}&position=&team=&min=1&csv=true`;
    console.log(`[proxy] fetching statcast contact quality ${year}...`);
    const opts = {
      hostname: 'baseballsavant.mlb.com', port: 443, path: statcastUrl, method: 'GET',
      headers: {'User-Agent':'Mozilla/5.0','Accept':'text/csv,*/*'}
    };
    const pr = https.request(opts, sr => {
      let body = '';
      sr.on('data', c => body += c);
      sr.on('end', () => {
        const lines = body.trim().split('\n');
        if(lines.length < 2){ 
          console.log('[proxy] savant-contact: no data or bad response');
          setCORS(res, reqOrigin);
          res.writeHead(200); res.end('{}'); 
          return; 
        }

        const headers = parseCSVLine(lines[0]).map(h => h.replace(/^\uFEFF/,'').replace(/^﻿/,'').trim().toLowerCase());
        console.log('[proxy] savant-contact headers:', headers.join(', '));
        
        const col = name => headers.indexOf(name);
        const iName = col('last_name, first_name') >= 0 ? col('last_name, first_name') : col('player_name');
        const iPlayerId = col('player_id');
        const iAvgEV = col('avg_hit_speed') >= 0 ? col('avg_hit_speed') : col('exit_velocity');
        const iHardHit = col('hard_hit_percent') >= 0 ? col('hard_hit_percent') : col('hardhit%');
        const iBarrel = col('barrel_batted_rate') >= 0 ? col('barrel_batted_rate') : col('barrel%');
        const iBBE = col('batted_ball_events') >= 0 ? col('batted_ball_events') : col('bbe');

        const result = {};
        for(let i = 1; i < lines.length; i++){
          const cols = parseCSVLine(lines[i]);
          let name = cols[iName] || '';
          // Convert "Last, First" to "First Last"
          if(name.includes(',')) {
            name = name.split(',').map(s=>s.trim()).reverse().join(' ');
          }
          if(!name) continue;
          
          const playerId = cols[iPlayerId] || '';
          const avgEV = iAvgEV >= 0 ? parseFloat(cols[iAvgEV]) || null : null;
          const hardHit = iHardHit >= 0 ? parseFloat(cols[iHardHit]) || null : null;
          const barrel = iBarrel >= 0 ? parseFloat(cols[iBarrel]) || null : null;
          const bbe = iBBE >= 0 ? parseInt(cols[iBBE]) || 0 : 0;
          
          result[name.toLowerCase()] = {
            name,
            mlbId: playerId,
            avgEV,
            hardHit,
            barrel,
            bbe,
          };
        }

        console.log(`[proxy] savant-contact: ${Object.keys(result).length} pitchers with contact data`);
        setCORS(res, reqOrigin);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(result));
      });
    });
    pr.on('error', e => {
      console.error('[proxy] savant-contact error:', e.message);
      res.writeHead(502); res.end('{}');
    });
    pr.end();
    return;
  }

  // FIX #2: /savant-recent -> fetch & aggregate last 7 days pitcher stats (dynamic year)
  if (path.startsWith('/savant-recent')) {
    const today = new Date();
    const sevenDaysAgo = new Date(today - 7 * 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().split('T')[0];
    const startDate = fmt(sevenDaysAgo);
    const endDate = fmt(today);
    const currentYear = String(today.getFullYear());  // FIX: Dynamic year instead of hardcoded 2026
    const statcastUrl = `/statcast_search/csv?all=true&hfGT=R%7C&hfSea=${currentYear}%7C&player_type=pitcher&group_by=name&min_pitches=1&min_pas=1&game_date_gt=${startDate}&game_date_lt=${endDate}&sort_col=pitches&sort_order=desc&type=details&csv=true`;
    console.log(`[proxy] fetching last 7 days statcast (${startDate} to ${endDate})...`);

    const opts = {
      hostname: 'baseballsavant.mlb.com', port: 443, path: statcastUrl, method: 'GET',
      headers: {'User-Agent':'Mozilla/5.0','Accept':'text/csv,*/*'}
    };
    const pr = https.request(opts, sr => {
      let body = '';
      sr.on('data', c => body += c);
      sr.on('end', () => {
        const lines = body.trim().split('\n');
        if(lines.length < 2){ res.writeHead(200); res.end('{}'); return; }

        const headers = parseCSVLine(lines[0]).map(h => h.replace(/^\uFEFF/,''));
        const col = name => headers.indexOf(name);
        const iName   = col('player_name');
        const iPitcherId = col('pitcher');
        const iEvents = col('events');
        const iDesc   = col('description');
        const iOuts   = col('outs_when_up');
        const iTeam   = col('home_team');
        const iAway   = col('away_team');

        const pitchers = {};
        for(let i = 1; i < lines.length; i++){
          if(!lines[i].trim()) continue;
          const row = parseCSVLine(lines[i]);
          const name = row[iName] || '';
          if(!name) continue;
          if(!pitchers[name]) pitchers[name] = {pitches:0, swstr:0, bf:0, k:0, bb:0, teams:{}};
          const p = pitchers[name];
          p.pitches++;
          const desc = row[iDesc] || '';
          const ev   = row[iEvents] || '';
          if(desc === 'swinging_strike' || desc === 'swinging_strike_blocked') p.swstr++;
          if(ev && ev !== 'null'){
            p.bf++;
            if(ev === 'strikeout' || ev === 'strikeout_double_play') p.k++;
            if(ev === 'walk' || ev === 'intent_walk') p.bb++;
          }
          const ht = row[iTeam]||''; const at = row[iAway]||'';
          if(ht) p.teams[ht] = (p.teams[ht]||0)+1;
          if(at) p.teams[at] = (p.teams[at]||0)+1;
        }

        const result = {};
        Object.entries(pitchers).forEach(([name, p]) => {
          if(p.bf < 1) return;
          const normalized = name.includes(',')
            ? name.split(',').map(s=>s.trim()).reverse().join(' ')
            : name;
          const team = Object.entries(p.teams).sort((a,b)=>b[1]-a[1])[0]?.[0]||'';
          result[normalized.toLowerCase()] = {
            name: normalized,
            k_pct:    p.bf > 0 ? parseFloat((p.k/p.bf*100).toFixed(1)) : 0,
            bb_pct:   p.bf > 0 ? parseFloat((p.bb/p.bf*100).toFixed(1)) : 0,
            kbb:      p.bf > 0 ? parseFloat(((p.k-p.bb)/p.bf*100).toFixed(1)) : 0,
            whiff_pct:p.pitches>0?parseFloat((p.swstr/p.pitches*100).toFixed(1)):0,
            bf: p.bf,
            team,
            dateRange: `${startDate} to ${endDate}`,
          };
        });

        console.log(`[proxy] 7-day: aggregated ${Object.keys(result).length} pitchers`);
        setCORS(res, reqOrigin);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(result));
      });
    });
    pr.on('error', e => { res.writeHead(502); res.end('{}'); });
    pr.end();
    return;
  }

  // /pitcher-rest -> get days since each pitcher last appeared (for streaming recommendations)
  if (path === '/pitcher-rest') {
    const today = new Date();
    const tenDaysAgo = new Date(today - 10 * 24 * 60 * 60 * 1000);
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000); // Include today's games
    const fmt = d => d.toISOString().split('T')[0];
    const startDate = fmt(tenDaysAgo);
    const endDate = fmt(tomorrow); // Use tomorrow to include today (game_date_lt is exclusive)
    const currentYear = String(today.getFullYear());
    
    // Fetch game_date for each pitch in last 10 days
    const statcastUrl = `/statcast_search/csv?all=true&hfGT=R%7C&hfSea=${currentYear}%7C&player_type=pitcher&group_by=name&min_pitches=1&game_date_gt=${startDate}&game_date_lt=${endDate}&sort_col=pitches&sort_order=desc&type=details&csv=true`;
    console.log(`[proxy] fetching pitcher rest data (${startDate} to ${endDate})...`);

    const opts = {
      hostname: 'baseballsavant.mlb.com', port: 443, path: statcastUrl, method: 'GET',
      headers: {'User-Agent':'Mozilla/5.0','Accept':'text/csv,*/*'}
    };
    
    const pr = https.request(opts, sr => {
      let body = '';
      sr.on('data', c => body += c);
      sr.on('end', () => {
        const lines = body.trim().split('\n');
        if(lines.length < 2){ res.writeHead(200); res.end('{}'); return; }

        const headers = parseCSVLine(lines[0]).map(h => h.replace(/^\uFEFF/,''));
        const col = name => headers.indexOf(name);
        const iName = col('player_name');
        const iDate = col('game_date');
        const iPitcherId = col('pitcher');

        // Helper to strip accents for matching
        const stripAccents = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        
        // Normalize name to match dashboard's normName function
        const normName = s => s.toLowerCase()
          .replace(/\./g, '')           // A.J. -> AJ
          .replace(/\s+/g, ' ')         // multiple spaces -> one
          .replace(/ jr$| sr$| ii$| iii$/, '') // remove suffixes
          .trim();

        const pitchers = {};
        for(let i = 1; i < lines.length; i++){
          if(!lines[i].trim()) continue;
          const row = parseCSVLine(lines[i]);
          const name = row[iName] || '';
          const gameDate = row[iDate] || '';
          const pitcherId = row[iPitcherId] || '';
          if(!name || !gameDate) continue;
          
          // Normalize name (Last, First -> First Last)
          const normalized = name.includes(',')
            ? name.split(',').map(s=>s.trim()).reverse().join(' ')
            : name;
          // Apply same normalization as dashboard
          const key = stripAccents(normName(normalized));
          
          // Track most recent game date
          if(!pitchers[key] || gameDate > pitchers[key].lastDate) {
            pitchers[key] = { 
              name: normalized, 
              lastDate: gameDate,
              mlbId: pitcherId
            };
          }
        }

        // Calculate days rest for each pitcher
        const todayStr = fmt(today);
        const result = {};
        Object.entries(pitchers).forEach(([key, p]) => {
          const lastGame = new Date(p.lastDate + 'T12:00:00');
          const todayNoon = new Date(todayStr + 'T12:00:00');
          const daysRest = Math.floor((todayNoon - lastGame) / (24 * 60 * 60 * 1000));
          result[key] = {
            name: p.name,
            lastDate: p.lastDate,
            daysRest: daysRest,
            mlbId: p.mlbId
          };
        });

        console.log(`[proxy] pitcher-rest: found ${Object.keys(result).length} pitchers`);
        setCORS(res, reqOrigin);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(result));
      });
    });
    pr.on('error', e => { res.writeHead(502); res.end('{}'); });
    pr.end();
    return;
  }

  // /savant-debuts -> detect pitchers appearing in current year Statcast for first time
  if (path === '/savant-debuts') {
    const currentYear = new Date().getFullYear();
    const knownFile = nodePath.join(__dirname, `known-pitchers-${currentYear}.json`);

    // Load previously seen pitchers
    let knownPitchers = {};
    try { knownPitchers = JSON.parse(fs.readFileSync(knownFile, 'utf8')); } catch(e) {}

    // Fetch current year pitcher list
    const statcastUrl = `/statcast_search/csv?all=true&hfGT=R%7C&hfSea=${currentYear}%7C&player_type=pitcher&group_by=name&min_pitches=1&min_pas=1&sort_col=pitches&sort_order=desc&type=details&csv=true`;
    const opts = {
      hostname: 'baseballsavant.mlb.com', port: 443, path: statcastUrl, method: 'GET',
      headers: {'User-Agent':'Mozilla/5.0','Accept':'text/csv,*/*'}
    };

    const pr = https.request(opts, sr => {
      let body = '';
      sr.on('data', c => body += c);
      sr.on('end', () => {
        const lines = body.trim().split('\n');
        if(lines.length < 2){ res.writeHead(200); res.end('{}'); return; }

        const headers = parseCSVLine(lines[0]).map(h=>h.replace(/^\uFEFF/,''));
        const iName = headers.indexOf('player_name');

        // Build current pitcher set with BF counts
        const current = {};
        const bfCounts = {};
        for(let i = 1; i < lines.length; i++){
          if(!lines[i].trim()) continue;
          const row = parseCSVLine(lines[i]);
          const rawName = row[iName] || '';
          if(!rawName) continue;
          const name = rawName.includes(',')
            ? rawName.split(',').map(s=>s.trim()).reverse().join(' ')
            : rawName;
          current[name.toLowerCase()] = name;
          bfCounts[name.toLowerCase()] = (bfCounts[name.toLowerCase()]||0) + 1;
        }

        // Find debuts — in current but not in known
        const debuts = [];
        Object.entries(current).forEach(([lname, name]) => {
          if(!knownPitchers[lname]) {
            debuts.push({ name, lname, bf: bfCounts[lname] || 0 });
          }
        });

        // Save updated known list
        Object.assign(knownPitchers, current);
        try { fs.writeFileSync(knownFile, JSON.stringify(knownPitchers, null, 2)); }
        catch(e) { console.error('[proxy] could not save known pitchers:', e.message); }

        console.log(`[proxy] debuts: ${debuts.length} new pitchers found in ${currentYear}`);
        setCORS(res, reqOrigin);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(debuts));
      });
    });
    pr.on('error', e => { res.writeHead(502); res.end('[]'); });
    pr.end();
    return;
  }

  // Helper: baseball IP notation to decimal (4.2 -> 4.667)
  const ipToDecimal = ip => { const p = String(ip).split('.'); return (parseInt(p[0])||0) + ((parseInt(p[1])||0)/3); };

  // /mlb-stats -> fetch MLB pitching traditional stats (WHIP, K/9, BB/9, GB%, IP)
  if (path.startsWith('/mlb-stats')) {
    const mlbYear = req.url.includes('year=2025') ? '2025' : String(new Date().getFullYear());
    const fetchPage = (offset) => new Promise((resolve) => {
      const mlbPath = `/api/v1/stats?stats=season&group=pitching&gameType=R&season=${mlbYear}&sportIds=1&limit=500&offset=${offset}&sortStat=strikeOuts&order=desc&hydrate=person,team`;
      const opts = {hostname:'statsapi.mlb.com',port:443,path:mlbPath,method:'GET',headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'}};
      const pr = https.request(opts, sr => {
        let body=''; sr.on('data',c=>body+=c);
        sr.on('end',()=>{ try { resolve(JSON.parse(body).stats?.[0]?.splits||[]); } catch(e){ resolve([]); } });
      });
      pr.on('error',()=>resolve([]));
      pr.end();
    });

    Promise.all([fetchPage(0), fetchPage(500)]).then(([page1, page2]) => {
      const splits = [...page1, ...page2];
      // Dedup by player ID — prefer highest IP entry (cumulative season total over per-team splits)
      const bestByPlayer = {};
      splits.forEach(s => {
        const id = s.player?.id;
        if(!id) return;
        const ip = parseFloat(s.stat?.inningsPitched||'0');
        if(!bestByPlayer[id] || ip > parseFloat(bestByPlayer[id].stat?.inningsPitched||'0')) {
          bestByPlayer[id] = s;
        }
      });
      const result = {};
      Object.values(bestByPlayer).forEach(s => {
        const name = s.player?.fullName || '';
        if(!name) return;
        const st = s.stat || {};
        const ipRawM = st.inningsPitched || '0';
        const ipM    = ipToDecimal(ipRawM);
        const k   = st.strikeOuts || 0;
        const bb  = st.baseOnBalls || 0;
        const go  = st.groundOuts || 0;
        const ao  = st.airOuts || 0;
        result[name.toLowerCase()] = {
          name,
          era:   parseFloat(st.era)  || null,
          whip:  parseFloat(st.whip) || null,
          ip: ipRawM, ipNum: ipM,
          k9:    ipM > 0 ? parseFloat((k/ipM*9).toFixed(1)) : null,
          bb9:   ipM > 0 ? parseFloat((bb/ipM*9).toFixed(1)) : null,
          gbPct: (go+ao) > 0 ? parseFloat((go/(go+ao)*100).toFixed(1)) : null,
          saves: st.saves || 0,
          holds: st.holds || 0,
          gamesPlayed: st.gamesPlayed || 0,
          gamesFinished: st.gamesFinished || 0,
        };
      });
      console.log(`[proxy] MLB stats ${mlbYear}: ${Object.keys(result).length} pitchers`);
      setCORS(res, reqOrigin);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(result));
    }).catch(()=>{ res.writeHead(200); res.end('{}'); });
    return;
  }

  // /aaa-stats -> fetch AAA pitching leaderboard from MLB Stats API
  if (path.startsWith('/aaa-stats')) {
    const aaaYear = req.url.includes('year=2025') ? '2025' : String(new Date().getFullYear());
    const fetchPage = (offset) => new Promise((resolve) => {
      const mlbPath = `/api/v1/stats?stats=season&group=pitching&gameType=R&season=${aaaYear}&sportIds=11&limit=500&offset=${offset}&sortStat=strikeOuts&order=desc&hydrate=person,team`;
      const opts = {hostname:'statsapi.mlb.com',port:443,path:mlbPath,method:'GET',headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'}};
      const pr = https.request(opts, sr => {
        let body=''; sr.on('data',c=>body+=c);
        sr.on('end',()=>{ try { resolve(JSON.parse(body).stats?.[0]?.splits||[]); } catch(e){ resolve([]); } });
      });
      pr.on('error',()=>resolve([]));
      pr.end();
    });

    Promise.all([fetchPage(0), fetchPage(500)]).then(([page1, page2]) => {
      const splits = [...page1, ...page2];
      console.log(`[proxy] AAA ${aaaYear}: ${splits.length} total splits`);
      try {
        const seen = new Set();
        const unique = splits.filter(s => {
          const id = s.player?.id;
          if(!id || seen.has(id)) return false;
          const sportId = s.team?.sport?.id;
          if(sportId && sportId !== 11) return false;
          seen.add(id);
          return true;
        });
        const result = {};
        unique.forEach(s => {
          const name = s.player?.fullName || '';
          if(!name) return;
          const st = s.stat || {};
          const bf = st.battersFaced || 0;
          const k  = st.strikeOuts || 0;
          const bb = st.baseOnBalls || 0;
          const ipRaw = st.inningsPitched || '0';
          const ip    = ipToDecimal(ipRaw);
          const ipDisplay = ipRaw;
          const gs = st.gamesStarted || 0;
          const gp = st.gamesPlayed || 0;
          const kpct  = bf > 0 ? parseFloat((k/bf*100).toFixed(1)) : 0;
          const bbpct = bf > 0 ? parseFloat((bb/bf*100).toFixed(1)) : 0;
          const kbb   = bf > 0 ? parseFloat(((k-bb)/bf*100).toFixed(1)) : 0;
          const k9    = ip > 0 ? parseFloat((k/ip*9).toFixed(1)) : 0;
          const bb9   = ip > 0 ? parseFloat((bb/ip*9).toFixed(1)) : 0;
          const go    = st.groundOuts || 0;
          const ao    = st.airOuts    || 0;
          const gbPct = (go + ao) > 0 ? parseFloat((go/(go+ao)*100).toFixed(1)) : null;
          result[name.toLowerCase()] = {
            name,
            mlbId:     String(s.player?.id || ''),
            mlbOrg:    s.team?.parentOrgName || '',
            aaaTeam:   s.team?.abbreviation  || '',
            role:      gs > 0 ? 'SP' : 'RP',
            era:       parseFloat(st.era)  || null,
            whip:      parseFloat(st.whip) || null,
            ip: ipDisplay, ipNum: ip, bf, k, bb,
            k_pct: kpct, bb_pct: bbpct, kbb,
            k9, bb9, gbPct,
            gp, gs,
          };
        });
        console.log(`[proxy] AAA ${aaaYear}: ${Object.keys(result).length} pitchers after dedup`);
        setCORS(res, reqOrigin);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify(result));
      } catch(e) {
        console.error('[proxy] AAA parse error:', e.message);
        res.writeHead(200); res.end('{}');
      }
    }).catch(e=>{ res.writeHead(200); res.end('{}'); });
    return;
  }

  // /forty-man -> all 30 MLB 40-man rosters from MLB Stats API
  if (path === '/forty-man') {
    const TEAM_IDS = [
      {id:133,abbr:'ATH'},{id:134,abbr:'PIT'},{id:135,abbr:'SD'},{id:136,abbr:'SEA'},
      {id:137,abbr:'SF'},{id:138,abbr:'STL'},{id:139,abbr:'TB'},{id:140,abbr:'TEX'},
      {id:141,abbr:'TOR'},{id:142,abbr:'MIN'},{id:143,abbr:'PHI'},{id:144,abbr:'ATL'},
      {id:145,abbr:'CWS'},{id:146,abbr:'MIA'},{id:147,abbr:'NYY'},{id:158,abbr:'MIL'},
      {id:108,abbr:'LAA'},{id:109,abbr:'AZ'},{id:110,abbr:'BAL'},{id:111,abbr:'BOS'},
      {id:112,abbr:'CHC'},{id:113,abbr:'CIN'},{id:114,abbr:'CLE'},{id:115,abbr:'COL'},
      {id:116,abbr:'DET'},{id:117,abbr:'HOU'},{id:118,abbr:'KC'},{id:119,abbr:'LAD'},
      {id:120,abbr:'WSH'},{id:121,abbr:'NYM'},
    ];

    function fetchTeamRoster(teamId, abbr) {
      return new Promise((resolve) => {
        const opts = {
          hostname: 'statsapi.mlb.com', port: 443,
          path: `/api/v1/teams/${teamId}/roster/40Man`,
          method: 'GET',
          headers: {'User-Agent':'Mozilla/5.0','Accept':'application/json'}
        };
        const pr = https.request(opts, sr => {
          let body = '';
          sr.on('data', c => body += c);
          sr.on('end', () => {
            try {
              const data = JSON.parse(body);
              const players = {};
              (data.roster||[]).forEach(p => {
                const name = (p.person?.fullName||'').toLowerCase();
                if(name) players[name] = {
                  name: p.person.fullName,
                  pos: p.position?.abbreviation||'?',
                  abbr,
                  jerseyNumber: p.jerseyNumber||'',
                  age: p.person?.currentAge || null,
                };
              });
              resolve(players);
            } catch(e) { resolve({}); }
          });
        });
        pr.on('error', () => resolve({}));
        pr.end();
      });
    }

    console.log('[proxy] fetching all 30 MLB 40-man rosters...');
    Promise.all(TEAM_IDS.map(t => fetchTeamRoster(t.id, t.abbr))).then(rosters => {
      const fortyMan = Object.assign({}, ...rosters);
      console.log(`[proxy] 40-man: ${Object.keys(fortyMan).length} players across 30 teams`);
      setCORS(res, reqOrigin);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify(fortyMan));
    }).catch(e => { res.writeHead(200); res.end('{}'); });
    return;
  }

  // /savant/* -> baseballsavant.mlb.com
  if (path.startsWith('/savant/')) {
    const savantPath = req.url.replace('/savant', '');
    const body = await readBody(req);
    console.log(`[proxy] GET https://baseballsavant.mlb.com${savantPath}`);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (compatible; ScoutProxy/1.0)',
      'Accept': 'text/csv,application/json,*/*',
    };
    proxyRequest('baseballsavant.mlb.com', savantPath, 'GET', headers, '', res, reqOrigin);
    return;
  }

  // Serve static assets (favicon, meta images)
  const staticFiles = {
    '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
    '/favicon.ico': { file: 'favicon.svg', type: 'image/svg+xml' },
    '/apple-touch-icon.svg': { file: 'apple-touch-icon.svg', type: 'image/svg+xml' },
    '/apple-touch-icon.png': { file: 'apple-touch-icon.svg', type: 'image/svg+xml' },
    '/og-image.svg': { file: 'og-image.svg', type: 'image/svg+xml' },
  };
  if (staticFiles[path]) {
    try {
      const { file, type } = staticFiles[path];
      const content = fs.readFileSync(nodePath.join(__dirname, file), 'utf8');
      setCORS(res, reqOrigin);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
      res.end(content);
    } catch(e) {
      res.writeHead(404); res.end('File not found');
    }
    return;
  }

  // Serve dashboard.html at root
  if (path === '/' || path === '/dashboard.html') {
    try {
      const file = fs.readFileSync(nodePath.join(__dirname, 'dashboard.html'), 'utf8');
      setCORS(res, reqOrigin);
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      res.end(file);
    } catch(e) {
      res.writeHead(404); res.end('dashboard.html not found');
    }
    return;
  }

  // /explore/[endpoint] -> proxy to Fantrax and return raw JSON for exploration
  if (path.startsWith('/explore/')) {
    const fxPath = req.url.replace('/explore', '/fxea/general');
    const body = await readBody(req);
    console.log(`[explore] ${req.method} https://${FANTRAX_HOST}${fxPath}`);
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; FantraxProxy/1.0)',
      ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}),
    };
    proxyRequest(FANTRAX_HOST, fxPath, req.method, headers, body, res, reqOrigin);
    return;
  }

  // /clear-cache -> clear all server-side caches (for debugging)
  if (path === '/clear-cache') {
    server._bpCache = null;
    server._photoCache = {};
    // Also clear injury tracking file
    const injuryCacheFile = nodePath.join(__dirname, '.injury-first-seen.json');
    try {
      fs.writeFileSync(injuryCacheFile, '{}');
      console.log('[proxy] Injury cache file cleared');
    } catch(e) {
      console.log('[proxy] Could not clear injury cache file:', e.message);
    }
    console.log('[proxy] All caches cleared');
    setCORS(res, reqOrigin);
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ success: true, message: 'All caches cleared (including injury tracking)' }));
    return;
  }

  // /bullpen-watch -> all 30 MLB teams bullpen data with saves, holds, injury status, prior year
  if (path.startsWith('/bullpen-watch')) {
    // Server-side cache — 2 hour TTL
    const BP_CACHE_TTL = 2 * 60 * 60 * 1000;
    if(server._bpCache && (Date.now() - server._bpCache.ts) < BP_CACHE_TTL) {
      console.log('[proxy] bullpen-watch: serving from cache');
      setCORS(res, reqOrigin);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(server._bpCache.data);
      return;
    }
    server._bpCache = null;
    const bpYear = new Date().getFullYear();
    const bpPrevYear = bpYear - 1;
    
    // Injury first-seen tracking — only highlight cards for 3 days after detection
    const INJURY_CACHE_FILE = nodePath.join(__dirname, '.injury-first-seen.json');
    const INJURY_HIGHLIGHT_DAYS = 1;
    const INJURY_HIGHLIGHT_MS = INJURY_HIGHLIGHT_DAYS * 24 * 60 * 60 * 1000;
    
    // Load existing injury timestamps
    let injuryFirstSeen = {};
    try { 
      injuryFirstSeen = JSON.parse(fs.readFileSync(INJURY_CACHE_FILE, 'utf8')); 
    } catch(e) { /* file doesn't exist yet */ }
    
    // Track which players are currently injured (to clean up old cache entries later)
    const currentlyInjuredIds = new Set();

    const fetchStats = (year, offset) => new Promise((resolve) => {
      const mlbPath = `/api/v1/stats?stats=season&group=pitching&gameType=R&season=${year}&sportIds=1&limit=500&offset=${offset}&sortStat=saves&order=desc&hydrate=person,team`;
      const opts = {hostname:'statsapi.mlb.com',port:443,path:mlbPath,method:'GET',headers:{'User-Agent':'Mozilla/5.0'}};
      const pr = https.request(opts, sr => {
        let body=''; sr.on('data',c=>body+=c);
        sr.on('end',()=>{ try { resolve(JSON.parse(body).stats?.[0]?.splits||[]); } catch(e){ resolve([]); } });
      });
      pr.on('error',()=>resolve([])); pr.end();
    });

    const fetchInjuries = () => Promise.resolve([]);

    const bpStart = Date.now();
    Promise.all([
      fetchStats(bpYear, 0), fetchStats(bpYear, 500),
      fetchStats(bpPrevYear, 0), fetchStats(bpPrevYear, 500),
      fetchInjuries()
    ]).then(([cur1, cur2, prev1, prev2, injuries]) => {
      console.log(`[proxy] bullpen-watch: all fetches done in ${Date.now()-bpStart}ms`);
      const curSplits  = [...cur1,  ...cur2];
      const prevSplits = [...prev1, ...prev2];

      const injuredIds = new Set();
      const injuryDates = {};

      // Build prior year saves lookup (use string keys for consistency with mlbId)
      const prevSaves = {};
      const prevTeamLeader = {};
      prevSplits.forEach(s => {
        const pid = s.player?.id;
        if(!pid) return;
        const sv = s.stat?.saves || 0;
        prevSaves[String(pid)] = sv;
        const tid = s.team?.id;
        if(tid && (!prevTeamLeader[tid] || sv > prevTeamLeader[tid].saves)) {
          prevTeamLeader[tid] = { pid: String(pid), saves: sv, name: s.player?.fullName };
        }
      });

      // Group current year by MLB team
      // Use LAST split seen (most recent team) rather than most IP
      const bestCur = {};
      curSplits.forEach(s => {
        const pid = s.player?.id;
        if(!pid) return;
        // Always overwrite with latest split — traded players will end up on current team
        bestCur[pid] = s;
      });
      const teams = {};
      Object.values(bestCur).forEach(s => {
        const pid = s.player?.id;
        const st = s.stat || {};
        const saves = st.saves || 0;
        const holds = st.holds || 0;
        const gf    = st.gamesFinished || 0;
        const gp    = st.gamesPlayed || 0;
        const gs    = st.gamesStarted || 0;
        // Filter out starters (more than half games started)
        if(gs > gp * 0.5) return;
        // Require at least 1 game played (loosened from requiring SV/HLD/GF)
        if(gp === 0) return;
        const teamName = s.team?.name || '';
        const teamAbbr = s.team?.abbreviation || '';
        const teamId   = String(s.team?.id || '');
        if(!teamName) return;
        if(!teams[teamId]) teams[teamId] = { name: teamName, abbr: teamAbbr, id: teamId, pitchers: [] };
        const ipRaw = st.inningsPitched || '0';
        teams[teamId].pitchers.push({
          name:      s.player?.fullName || '',
          mlbId:     String(pid),
          saves, holds, gf, gp,
          blownSaves: st.blownSaves || 0,
          ip:        ipRaw,
          era:       parseFloat(st.era) || null,
          whip:      parseFloat(st.whip) || null,
          injured:   injuredIds.has(pid),
          prevSaves: prevSaves[String(pid)] || 0,
        });
      });

      // Check for prior year leaders missing from current splits
      const currentPlayerIds = new Set(Object.values(bestCur).map(s => String(s.player?.id)));
      const prevTeamMeta = {};
      prevSplits.forEach(s => {
        const tid = String(s.team?.id);
        if(!prevTeamMeta[tid]) prevTeamMeta[tid] = { name: s.team?.name||'', id: Number(tid) };
      });

      Object.entries(prevTeamLeader).forEach(([tid, leader]) => {
        if(leader.saves < 8) return;
        if(currentPlayerIds.has(String(leader.pid))) return;

        if(!teams[tid]) {
          const meta = prevTeamMeta[tid] || {};
          teams[tid] = { name: meta.name||leader.team||'', id: Number(tid), pitchers: [], situation: 'NO_SAVES' };
          console.log(`[proxy] created team entry for ${meta.name} (no current RP data)`);
        }
        teams[tid].pitchers.unshift({
          name: leader.name,
          mlbId: String(leader.pid),
          saves: 0, holds: 0, gf: 0, gp: 0,
          ip: '0.0', era: null, whip: null,
          injured: true,
          isPriorCloser: true,
          prevSaves: leader.saves,
        });
      });

      // Classify each team
      Object.entries(teams).forEach(([tid, t]) => {
        t.pitchers.sort((a,b) => (b.saves - a.saves) || (b.holds - a.holds));

        const prevLeader = prevTeamLeader[tid];
        const healthyWithSaves = t.pitchers.filter(p => p.saves > 0 && !p.injured);
        const allWithSaves     = t.pitchers.filter(p => p.saves > 0);

        const priorCloser = t.pitchers.find(p => prevLeader && String(p.mlbId) === String(prevLeader.pid));
        const priorCloserIsInjured = priorCloser?.injured || false;
        const priorCloserHadDominantYear = priorCloser && (priorCloser.prevSaves >= 8);

        if(priorCloser) priorCloser.isPriorCloser = true;

        const currentLeader = allWithSaves[0];
        const currentLeaderPrevSaves = currentLeader ? (prevSaves[currentLeader.mlbId] || 0) : 0;
        const currentLeaderIsPriorCloser = currentLeaderPrevSaves >= 8;
        if(currentLeaderIsPriorCloser && currentLeader && !currentLeader.isPriorCloser) {
          currentLeader.isPriorCloser = true;
          currentLeader.prevSaves = currentLeaderPrevSaves;
        }

        const effectivePriorCloser = priorCloser || (currentLeaderIsPriorCloser ? currentLeader : null);
        const effectivePriorSaves = effectivePriorCloser
          ? (prevSaves[effectivePriorCloser.mlbId] || 0)
          : 0;
        const effectivelyDominant = effectivePriorSaves >= 8;
        const effectivelyInjured = effectivePriorCloser?.injured || false;

        const isCurrentYearInjury = effectivePriorCloser?.gp === 0;
        
        // Track injury timing — only highlight for first 3 days
        let isRecentInjury = false;
        if(isCurrentYearInjury && effectivePriorCloser) {
          const playerId = effectivePriorCloser.mlbId;
          currentlyInjuredIds.add(playerId);
          
          const now = Date.now();
          if(!injuryFirstSeen[playerId]) {
            // First time seeing this injury — record timestamp
            injuryFirstSeen[playerId] = now;
            isRecentInjury = true;
            console.log(`[proxy] New injury detected: ${effectivePriorCloser.name} (${playerId})`);
          } else {
            // Check if within 3-day window
            const daysSinceDetection = (now - injuryFirstSeen[playerId]) / (24 * 60 * 60 * 1000);
            isRecentInjury = daysSinceDetection <= INJURY_HIGHLIGHT_DAYS;
          }
        }

        if(effectivelyDominant && !effectivelyInjured) {
          t.situation = 'LOCKED';
          t.lockedPitcher = effectivePriorCloser.name;
        } else if(effectivelyDominant && effectivelyInjured) {
          // Check if any healthy save-getter is a prior closer (traded in, like Helsley)
          const healthyPriorClosers = healthyWithSaves
            .filter(p => (prevSaves[p.mlbId] || 0) >= 8)
            .sort((a, b) => {
              // Most prior saves first
              const prevDiff = (prevSaves[b.mlbId] || 0) - (prevSaves[a.mlbId] || 0);
              if (prevDiff !== 0) return prevDiff;
              // Tiebreaker: most current saves
              return (b.saves || 0) - (a.saves || 0);
            });
          
          if(healthyPriorClosers.length === 1) {
            // One clear prior closer available — he's the guy
            t.situation = 'LOCKED';
            t.lockedPitcher = healthyPriorClosers[0].name;
            t.closerName = healthyPriorClosers[0].name;
          } else if(healthyPriorClosers.length >= 2) {
            // Two+ prior closers — tag as EMERGING, top guy gets nod
            t.situation = 'EMERGING';
            t.closerName = healthyPriorClosers[0].name;
          } else if(healthyWithSaves.length === 0) {
            t.situation = 'NO_SAVES';
          } else if(healthyWithSaves.length >= 2) {
            t.situation = 'COMMITTEE';
          } else {
            t.situation = 'EMERGING';
          }
          
          if(isCurrentYearInjury) t.injuredCloser = effectivePriorCloser.name;
          t.recentInjury = isRecentInjury;
        } else {
          if(allWithSaves.length === 0) t.situation = 'NO_SAVES';
          else if(allWithSaves.length >= 3) t.situation = 'COMMITTEE';
          else if(allWithSaves.length === 2 && Math.abs(allWithSaves[0].saves - allWithSaves[1].saves) <= 2) t.situation = 'COMMITTEE';
          else if(allWithSaves.length === 1 && allWithSaves[0].saves >= 3) t.situation = 'LOCKED';
          else t.situation = 'EMERGING';
        }

        // Determine closer tag using "Closer Score" — not just saves
        // This catches guys like Palencia who are finishing games but haven't converted saves yet
        
        // Helper to convert IP string to decimal
        const ipToDec = ip => { 
          const p = String(ip).split('.'); 
          return (parseInt(p[0])||0) + ((parseInt(p[1])||0)/3); 
        };
        
        // Calculate closer score for each pitcher
        const closerCandidates = t.pitchers
          .filter(p => !p.injured)
          .map(p => {
            const ipNum = ipToDec(p.ip);
            const ipPerGame = p.gp > 0 ? ipNum / p.gp : 0;
            
            // Filter out starters (high IP/game) and low-activity guys
            const isRelieverProfile = ipPerGame > 0 && ipPerGame < 2.0;
            const hasActivity = p.gf >= 1 || p.saves >= 1;
            
            if(!isRelieverProfile || !hasActivity) return null;
            
            // ===== CLOSER SCORE CALCULATION =====
            // Base score: GF + Saves - Holds
            const priorCloserBonus = (prevSaves[p.mlbId] || 0) >= 8 ? 10 : 0;
            let closerScore = (p.gf * 2) + (p.saves * 3) - (p.holds * 0.5) + priorCloserBonus;
            
            // ===== PENALTIES =====
            const penalties = {};
            
            // Long reliever penalty: high IP/game indicates bulk/mop-up role, not closer
            // True closers average ~1.0 IP/game, long relievers average 1.5-2.0
            if(ipPerGame > 1.3) {
              // Reduce GF credit for long relievers (they finish blowouts, not save situations)
              const longRelieverPenalty = Math.round((ipPerGame - 1.0) * p.gf * 1.5);
              penalties.longReliever = longRelieverPenalty;
              closerScore -= longRelieverPenalty;
            }
            
            // Blown saves penalty: -4 per BS (huge red flag for closer role)
            const bs = p.blownSaves || 0;
            if(bs > 0) {
              penalties.blownSaves = bs * 4;
              closerScore -= penalties.blownSaves;
            }
            
            // High ERA penalty: if ERA > 6.0 and has saves, penalize
            // (guys getting save chances but blowing up)
            if(p.saves >= 1 && p.era && p.era > 6.0) {
              penalties.era = Math.min(Math.round((p.era - 5.0) * 1.5), 8);
              closerScore -= penalties.era;
            }
            
            // ===== RED FLAGS (for display) =====
            const redFlags = [];
            if(ipPerGame > 1.4) redFlags.push({ type: 'longRP', value: ipPerGame.toFixed(1), msg: 'Long relief role' });
            if(bs >= 2) redFlags.push({ type: 'BS', value: bs, msg: `${bs} blown saves` });
            else if(bs === 1) redFlags.push({ type: 'BS', value: bs, msg: '1 blown save' });
            
            // ERA red flag: require 4+ IP to avoid one bad outing skewing everything
            // (e.g., 4 ER in 1 IP = 36.00 ERA, but with 3 other clean IP it's only 9.00)
            if(p.era && p.era > 8.0 && ipNum >= 4.0) {
              redFlags.push({ type: 'ERA', value: p.era.toFixed(2), msg: `${p.era.toFixed(2)} ERA` });
            }
            
            // ===== EMERGING SIGNALS (positives for non-closers) =====
            const emergingSignals = [];
            if(p.holds >= 3 && p.saves === 0) {
              emergingSignals.push({ type: 'holds', value: p.holds, msg: `${p.holds} holds (setup role)` });
            }
            if(p.gf >= 3 && p.saves === 0) {
              emergingSignals.push({ type: 'GF', value: p.gf, msg: `${p.gf} games finished` });
            }
            
            // Flag long relievers (not real closer candidates)
            const isLongReliever = ipPerGame > 1.4;
            
            return { ...p, closerScore, ipPerGame, penalties, redFlags, emergingSignals, isLongReliever };
          })
          .filter(Boolean)
          .sort((a, b) => b.closerScore - a.closerScore);
        
        // Find top closer candidate (skip long relievers - they finish blowouts, not save situations)
        const realCloserCandidates = closerCandidates.filter(c => !c.isLongReliever);
        const topCloser = realCloserCandidates[0] || closerCandidates[0]; // Fallback if all are long relievers
        const runnerUp = realCloserCandidates[1] || closerCandidates[1];
        
        // Determine if top closer has clear lead
        const scoregap = topCloser && runnerUp 
          ? topCloser.closerScore - runnerUp.closerScore 
          : (topCloser?.closerScore || 0);
        const topIsPriorCloser = topCloser 
          ? (prevSaves[topCloser.mlbId] || 0) >= 8 
          : false;
        const topHasClearLead = topCloser && (
          closerCandidates.length === 1 ||  // Only candidate
          scoregap >= 4 ||                   // Clear score gap
          topIsPriorCloser                   // Prior closer (8+ saves), trust the role
        );
        
        // Minimum threshold: at least 2 GF or 1 save or prior closer (8+ saves)
        const topMeetsMinimum = topCloser && (topCloser.gf >= 2 || topCloser.saves >= 1 || topIsPriorCloser);
        
        // ===== VOLATILE DETECTION =====
        // Flag situations where top closer has significant red flags
        const topHasRedFlags = topCloser?.redFlags?.length >= 1;
        const topCloserIp = topCloser ? ipToDec(topCloser.ip) : 0;
        const topHasSeriousRedFlags = topCloser?.redFlags?.length >= 2 || 
          (topCloser?.blownSaves >= 2) ||
          (topCloser?.era && topCloser.era > 10.0 && topCloserIp >= 4.0); // Require 4+ IP
        
        // Find emerging arm: someone with strong signals but no saves
        const emergingArm = closerCandidates.find(p => 
          p.saves === 0 && 
          p.emergingSignals?.length >= 1 &&
          p.redFlags?.length === 0
        );
        
        if(topCloser && (t.situation === 'LOCKED' || (t.situation === 'EMERGING' && topHasClearLead && topMeetsMinimum))) {
          t.closerName = topCloser.name;
          t.closerScore = topCloser.closerScore;
          t.closerRedFlags = topCloser.redFlags || [];
          t.closerBlownSaves = topCloser.blownSaves || 0;
          
          // If top closer has serious red flags, mark as volatile
          if(topHasSeriousRedFlags) {
            t.volatile = true;
            t.volatileReason = topCloser.redFlags.map(f => f.msg).join(', ');
          }
        } else {
          t.closerName = null;
        }
        
        // Include emerging arm info if found
        if(emergingArm && (t.situation === 'COMMITTEE' || t.volatile)) {
          t.emergingArm = emergingArm.name;
          t.emergingSignals = emergingArm.emergingSignals || [];
        }
        
        // Store all closer candidates for dashboard (top 4)
        t.closerCandidates = closerCandidates.slice(0, 4).map(c => ({
          name: c.name,
          mlbId: c.mlbId,
          saves: c.saves,
          holds: c.holds,
          gf: c.gf,
          blownSaves: c.blownSaves || 0,
          era: c.era,
          closerScore: c.closerScore,
          redFlags: c.redFlags || [],
          emergingSignals: c.emergingSignals || [],
          isLongReliever: c.isLongReliever || false,
        }));
      });
      
      // Clean up injury cache — remove players who are no longer injured (returned from IL)
      const oldCacheKeys = Object.keys(injuryFirstSeen);
      let cacheUpdated = false;
      oldCacheKeys.forEach(pid => {
        if(!currentlyInjuredIds.has(pid)) {
          console.log(`[proxy] Injury cleared: player ${pid} no longer injured, removing from cache`);
          delete injuryFirstSeen[pid];
          cacheUpdated = true;
        }
      });
      
      // Save updated injury cache
      if(currentlyInjuredIds.size > 0 || cacheUpdated) {
        try {
          fs.writeFileSync(INJURY_CACHE_FILE, JSON.stringify(injuryFirstSeen, null, 2));
        } catch(e) {
          console.error('[proxy] Failed to save injury cache:', e.message);
        }
      }

      const responseData = JSON.stringify(Object.values(teams).sort((a,b) => a.name.localeCompare(b.name)));
      server._bpCache = { data: responseData, ts: Date.now() };
      console.log('[proxy] bullpen-watch: cached result');
      setCORS(res, reqOrigin);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(responseData);
    });
    return;
  }

  // /debug-hader -> check bullpen data for Hader/Astros
  if (path === '/debug-hader') {
    const bpYear = new Date().getFullYear();
    const bpPrevYear = bpYear - 1;
    const fetchS = (year, offset) => new Promise(resolve => {
      const p = `/api/v1/stats?stats=season&group=pitching&gameType=R&season=${year}&sportIds=1&limit=500&offset=${offset}&sortStat=saves&order=desc&hydrate=person,team`;
      const o = {hostname:'statsapi.mlb.com',port:443,path:p,method:'GET',headers:{'User-Agent':'Mozilla/5.0'}};
      const pr = https.request(o, sr => { let b=''; sr.on('data',c=>b+=c); sr.on('end',()=>{ try{resolve(JSON.parse(b).stats?.[0]?.splits||[]);}catch(e){resolve([]);} }); });
      pr.on('error',()=>resolve([])); pr.end();
    });
    Promise.all([fetchS(bpYear,0),fetchS(bpYear,500),fetchS(bpPrevYear,0),fetchS(bpPrevYear,500)]).then(([c1,c2,p1,p2])=>{
      const cur = [...c1,...c2];
      const prev = [...p1,...p2];
      const haderCur = cur.filter(s=>(s.player?.fullName||'').toLowerCase().includes('hader'));
      const haderPrev = prev.filter(s=>(s.player?.fullName||'').toLowerCase().includes('hader'));
      const astrosCur = cur.filter(s=>s.team?.name?.includes('Astros') && (s.stat?.saves>0||s.stat?.holds>0||s.stat?.gamesFinished>0));
      const astrosPrev = prev.filter(s=>s.team?.name?.includes('Astros') && (s.stat?.saves>0));
      setCORS(res,reqOrigin); res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({
        haderCurrent: haderCur.map(s=>({name:s.player?.fullName,team:s.team?.name,ip:s.stat?.inningsPitched,saves:s.stat?.saves,gp:s.stat?.gamesPlayed})),
        haderPrev: haderPrev.map(s=>({name:s.player?.fullName,team:s.team?.name,saves:s.stat?.saves,ip:s.stat?.inningsPitched})),
        astrosCurrent: astrosCur.map(s=>({name:s.player?.fullName,sv:s.stat?.saves,hld:s.stat?.holds,gf:s.stat?.gamesFinished})),
        astrosPrevLeader: astrosPrev.sort((a,b)=>(b.stat?.saves||0)-(a.stat?.saves||0))[0] && {name:astrosPrev[0]?.player?.fullName,saves:astrosPrev[0]?.stat?.saves},
      },null,2));
    });
    return;
  }

  // /mlb-photo/:id -> proxy MLB headshot images with server-side cache
  if (path.startsWith('/mlb-photo/')) {
    const playerId = path.replace('/mlb-photo/', '').split('?')[0];
    // Serve from in-memory cache if available
    if(server._photoCache && server._photoCache[playerId]) {
      const cached = server._photoCache[playerId];
      res.writeHead(200, { 'Content-Type': cached.type, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
      res.end(cached.data);
      return;
    }
    const imgPath = `/mlb-photos/image/upload/w_60,d_people:generic:headshot:silo:current.png,q_auto:best,f_auto/v1/people/${playerId}/headshot/silo/current`;
    const opts = {
      hostname: 'img.mlbstatic.com', port: 443, path: imgPath, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }
    };
    const pr = https.request(opts, sr => {
      const chunks = [];
      sr.on('data', c => chunks.push(c));
      sr.on('end', () => {
        const data = Buffer.concat(chunks);
        const type = sr.headers['content-type'] || 'image/png';
        if(sr.statusCode === 200) {
          addToPhotoCache(server, playerId, data, type);  // FIX #7: Use bounded cache
        }
        res.writeHead(sr.statusCode, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      });
    });
    pr.on('error', () => { res.writeHead(404); res.end(); });
    pr.end();
    return;
  }

  // /fxea/* -> www.fantrax.com
  if (path.startsWith('/fxea/')) {
    const body = await readBody(req);
    const fullFxPath = req.url;
    console.log(`[proxy] ${req.method} https://${FANTRAX_HOST}${fullFxPath}`);

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; FantraxProxy/1.0)',
      ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}),
    };

    proxyRequest(FANTRAX_HOST, fullFxPath, req.method, headers, body, res, reqOrigin);
    return;
  }

  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unknown route.' }));
});

// ── CRON JOB — run daily notification at 8am Central Time ──────────────────
function scheduleDaily() {
  const now = new Date();
  const targetHour = parseInt(process.env.CRON_HOUR_UTC || '13');
  const next = new Date(now);
  next.setUTCHours(targetHour, 0, 0, 0);
  if(next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const ms = next - now;
  console.log(`[cron] Next notification scheduled in ${Math.round(ms/1000/60)} minutes`);
  setTimeout(async () => {
    console.log('[cron] Running daily scout notification...');
    try {
      // FIX #3: Properly import and call run()
      const notify = require('./notify.js');
      if(notify && typeof notify.run === 'function') {
        await notify.run();
      } else {
        throw new Error('notify.run not exported');
      }
    } catch(e) {
      console.error('[cron] notify.js error:', e.message);
      // Fallback to spawn if module import fails
      const { spawn } = require('child_process');
      const child = spawn('node', [nodePath.join(__dirname, 'notify.js')], { cwd: __dirname, stdio: 'inherit' });
      child.on('close', code => console.log('[cron] notify.js exited with code', code));
    }
    scheduleDaily();
  }, ms);
}

if(process.env.ENABLE_CRON === 'true') {
  scheduleDaily();
  console.log('[cron] Daily notification cron enabled');
}
// ────────────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Proxy running at http://localhost:' + PORT);
  console.log('  /fxea/*       -> https://www.fantrax.com');
  console.log('');
});
