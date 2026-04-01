const http = require('http');
const https = require('https');
const fs = require('fs');
const nodePath = require('path');

const PORT = process.env.PORT || 3001;
const FANTRAX_HOST = 'www.fantrax.com';
const ANTHROPIC_HOST = 'api.anthropic.com';

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version, Authorization');
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
  });
}

function proxyRequest(hostname, path, method, headers, body, res) {
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
      // Set CORS headers directly in proxyRequest (reqOrigin not in scope here)
      if(IS_PRODUCTION && ALLOWED_ORIGIN) {
        res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version, Authorization');
      res.writeHead(upstream.statusCode, {
        'Content-Type': upstream.headers['content-type'] || 'application/json',
      });
      res.end(responseBody);
    });
  });

  proxy.on('error', (err) => {
    console.error('[proxy] request error:', err.message);
    setCORS(res, reqOrigin);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });

  if (body) proxy.write(body);
  proxy.end();
}

const requestCounts = {};
setInterval(() => { Object.keys(requestCounts).forEach(k => delete requestCounts[k]); }, 60000);

const server = http.createServer(async (req, res) => {
  const reqOrigin = req.headers.origin || '';
  setCORS(res, reqOrigin);

  // Basic rate limiting — 100 requests per minute per IP
  const ip = req.socket.remoteAddress || 'unknown';
  requestCounts[ip] = (requestCounts[ip] || 0) + 1;
  if(requestCounts[ip] > 100) {
    res.writeHead(429, {'Content-Type':'text/plain'});
    res.end('Too many requests');
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const path = req.url;

  // /anthropic/* -> api.anthropic.com
  if (path.startsWith('/anthropic/')) {
    const apiPath = path.replace('/anthropic', '');
    const body = await readBody(req);
    const apiKey = req.headers['x-api-key'] || '';

    console.log(`[proxy] POST https://${ANTHROPIC_HOST}${apiPath}`);
    console.log(`[proxy] api key present: ${apiKey ? 'yes (' + apiKey.slice(0,12) + '...)' : 'NO - missing!'}`);

    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
      'x-api-key': apiKey,
    };

    proxyRequest(ANTHROPIC_HOST, apiPath, 'POST', headers, body, res);
    return;
  }



  // /fangraphs/* -> fangraphs.com
  if (path.startsWith('/fangraphs/')) {
    const fgPath = path.replace('/fangraphs', '');
    const body = await readBody(req);
    console.log(`[proxy] GET https://www.fangraphs.com${fgPath}`);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/csv,text/html,application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    proxyRequest('www.fangraphs.com', fgPath, 'GET', headers, '', res);
    return;
  }

  // /savant-stats -> fetch & aggregate 2026 pitcher K%, BB%, Whiff% from statcast
  if (path.startsWith('/savant-stats')) {
    const params = new URLSearchParams(path.includes('?') ? path.split('?')[1] : '');
    const year = params.get('year') || String(new Date().getFullYear());
    const statcastUrl = `/statcast_search/csv?all=true&hfGT=R%7C&hfSea=${year}%7C&player_type=pitcher&group_by=name&min_pitches=1&min_pas=1&sort_col=pitches&sort_order=desc&type=details&csv=true`;
    console.log(`[proxy] fetching statcast ${year} pitcher data...`);
    console.log('[proxy] fetching statcast pitch data for aggregation...');
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

        // Proper CSV parser to handle quoted fields with embedded commas
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

        const headers = parseCSVLine(lines[0]).map(h => h.replace(/^\uFEFF/,'').replace(/^﻿/,''));
        const col = name => headers.indexOf(name);
        const iName   = col('player_name');
        const iEvents = col('events');
        const iDesc   = col('description');
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
          if(!pitchers[name]) pitchers[name] = {pitches:0, swstr:0, bf:0, k:0, bb:0, teams:{}, pitchTypes:{}};
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
            if(ev === 'strikeout' || ev === 'strikeout_double_play') p.k++;
            if(ev === 'walk' || ev === 'intent_walk') p.bb++;
          }
          // Track both home and away teams, pick most frequent = pitcher's team
          const ht = row[iTeam] || '';
          const at = iAwayTeam >= 0 ? (row[iAwayTeam]||'') : '';
          // We don't know if pitcher is home or away, track both and pick most common
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

          result[normalized.toLowerCase()] = {
            name: normalized,
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

  // /savant-recent -> fetch & aggregate last 7 days pitcher stats
  if (path.startsWith('/savant-recent')) {
    const today = new Date();
    const sevenDaysAgo = new Date(today - 7 * 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().split('T')[0];
    const startDate = fmt(sevenDaysAgo);
    const endDate = fmt(today);
    const statcastUrl = `/statcast_search/csv?all=true&hfGT=R%7C&hfSea=2026%7C&player_type=pitcher&group_by=name&min_pitches=1&min_pas=1&game_date_gt=${startDate}&game_date_lt=${endDate}&sort_col=pitches&sort_order=desc&type=details&csv=true`;
    console.log(`[proxy] fetching last 7 days statcast (${startDate} to ${endDate})...`);

    function parseCSVLine(line) {
      const fields = []; let cur = '', inQ = false;
      for(let i = 0; i < line.length; i++){
        const ch = line[i];
        if(ch === '"'){ inQ = !inQ; }
        else if(ch === ',' && !inQ){ fields.push(cur.trim()); cur = ''; }
        else { cur += ch; }
      }
      fields.push(cur.trim());
      return fields;
    }

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
        const iEvents = col('events');
        const iDesc   = col('description');
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



  // /savant-debuts -> detect pitchers appearing in 2026 Statcast for first time
  if (path === '/savant-debuts') {
    const knownFile = __dirname + `/known-pitchers-${new Date().getFullYear()}.json`;

    // Load previously seen pitchers
    let knownPitchers = {};
    try { knownPitchers = JSON.parse(fs.readFileSync(knownFile, 'utf8')); } catch(e) {}

    // Fetch current 2026 pitcher list (just names + BF)
    const statcastUrl = '/statcast_search/csv?all=true&hfGT=R%7C&hfSea=2026%7C&player_type=pitcher&group_by=name&min_pitches=1&min_pas=1&sort_col=pitches&sort_order=desc&type=details&csv=true';
    const opts = {
      hostname: 'baseballsavant.mlb.com', port: 443, path: statcastUrl, method: 'GET',
      headers: {'User-Agent':'Mozilla/5.0','Accept':'text/csv,*/*'}
    };

    function parseCSVLine(line) {
      const fields = []; let cur = '', inQ = false;
      for(let i = 0; i < line.length; i++){
        const ch = line[i];
        if(ch === '"'){ inQ = !inQ; }
        else if(ch === ',' && !inQ){ fields.push(cur.trim()); cur = ''; }
        else { cur += ch; }
      }
      fields.push(cur.trim()); return fields;
    }

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

        console.log(`[proxy] debuts: ${debuts.length} new pitchers found in ${new Date().getFullYear()}`);
        setCORS(res, reqOrigin);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(debuts));
      });
    });
    pr.on('error', e => { res.writeHead(502); res.end('[]'); });
    pr.end();
    return;
  }

  // /mlb-stats -> fetch MLB pitching traditional stats (WHIP, K/9, BB/9, GB%, IP)
  if (path.startsWith('/mlb-stats')) {
    const mlbYear = path.includes('year=2025') ? '2025' : String(new Date().getFullYear());
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
      const seen = new Set();
      const result = {};
      splits.filter(s => {
        const id = s.player?.id;
        if(!id || seen.has(id)) return false;
        seen.add(id); return true;
      }).forEach(s => {
        const name = s.player?.fullName || '';
        if(!name) return;
        const st = s.stat || {};
        const ip  = parseFloat(st.inningsPitched) || 0;
        const k   = st.strikeOuts || 0;
        const bb  = st.baseOnBalls || 0;
        const go  = st.groundOuts || 0;
        const ao  = st.airOuts || 0;
        result[name.toLowerCase()] = {
          name,
          whip:  parseFloat(st.whip) || null,
          ip,
          k9:    ip > 0 ? parseFloat((k/ip*9).toFixed(1)) : null,
          bb9:   ip > 0 ? parseFloat((bb/ip*9).toFixed(1)) : null,
          gbPct: (go+ao) > 0 ? parseFloat((go/(go+ao)*100).toFixed(1)) : null,
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
    const aaaYear = path.includes('year=2025') ? '2025' : String(new Date().getFullYear());
    // Fetch two pages of 500 to get all AAA pitchers
    // Sort by strikeOuts (counting stat — includes everyone, no min IP filter)
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
        // deduplicate by player id
        const seen = new Set();
        const unique = splits.filter(s => {
          const id = s.player?.id;
          if(!id || seen.has(id)) return false;
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
            const ip = parseFloat(st.inningsPitched) || 0;
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
              mlbOrg:    s.team?.parentOrgName || '',
              aaaTeam:   s.team?.abbreviation  || '',
              role:      gs > 0 ? 'SP' : 'RP',
              era:       parseFloat(st.era)  || null,
              whip:      parseFloat(st.whip) || null,
              ip, bf, k, bb,
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
    // All 30 MLB team IDs
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
    const savantPath = path.replace('/savant', '');
    const body = await readBody(req);
    console.log(`[proxy] GET https://baseballsavant.mlb.com${savantPath}`);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (compatible; ScoutProxy/1.0)',
      'Accept': 'text/csv,application/json,*/*',
    };
    proxyRequest('baseballsavant.mlb.com', savantPath, 'GET', headers, '', res);
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

  // /fxea/* -> www.fantrax.com
  if (path.startsWith('/fxea/')) {
    const body = await readBody(req);
    console.log(`[proxy] ${req.method} https://${FANTRAX_HOST}${path}`);

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; FantraxProxy/1.0)',
      ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}),
    };

    proxyRequest(FANTRAX_HOST, path, req.method, headers, body, res);
    return;
  }

  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Use /fxea/* for Fantrax or /anthropic/* for Claude API.' }));
});

// ── CRON JOB — run daily notification at 8am Central Time ──────────────────
function scheduleDaily() {
  const now = new Date();
  // 8am CT = 14:00 UTC (13:00 UTC during CDT)
  const targetHour = 13; // CDT (adjust to 14 for CST)
  const next = new Date(now);
  next.setUTCHours(targetHour, 0, 0, 0);
  if(next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const ms = next - now;
  console.log(`[cron] Next notification scheduled in ${Math.round(ms/1000/60)} minutes`);
  setTimeout(async () => {
    console.log('[cron] Running daily scout notification...');
    try {
      const { run } = require('./notify.js');
      if(run) await run();
    } catch(e) {
      // notify.js uses module.exports or runs directly — try spawning it
      const { spawn } = require('child_process');
      const child = spawn('node', [nodePath.join(__dirname, 'notify.js')], { cwd: __dirname, stdio: 'inherit' });
      child.on('close', code => console.log('[cron] notify.js exited with code', code));
    }
    scheduleDaily(); // schedule next day
  }, ms);
}

if(process.env.ENABLE_CRON === 'true') {
  scheduleDaily();
  console.log('[cron] Daily notification cron enabled');
}
// ────────────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('');
  console.log('  Proxy running at http://localhost:' + PORT);
  console.log('  /fxea/*       -> https://www.fantrax.com');
  console.log('  /anthropic/*  -> https://api.anthropic.com');
  console.log('');
});
