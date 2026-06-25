// Auto-update WC2026 scores + goalscorers into Supabase.
// Run by .github/workflows/update-scores.yml every 15 min in the cloud (no laptop required).
// Source: TheSportsDB v1 public test key "3" (free, no signup).
// Safety: never overwrites an existing FT score; only fills missing matches / missing scorers.

const SB_URL = 'https://bgmlunqrsoeozpqumfif.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnbWx1bnFyc29lb3pwcXVtZmlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NTQ1MDYsImV4cCI6MjA5NzQzMDUwNn0.FxNkK0K1077v-ZxOEbk0-iKWf7JzLjeTYJT_1CMaQKM';
const TSDB = 'https://www.thesportsdb.com/api/v1/json/3';
const REPO_HTML = 'https://raw.githubusercontent.com/Aubrey-claw/wc2026/main/index.html';
const NAME_MAP = { 'United States': 'USA', 'Bosnia & Herzegovina': 'Bosnia-Herzegovina', 'Curaçao': 'Curacao' };
const tsdb = t => NAME_MAP[t] || t;
const sb = (path, opts = {}) => fetch(SB_URL + '/rest/v1/' + path, {
  ...opts,
  headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) }
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseFixtures(html) {
  const out = [];
  // M('A','2026-06-11T20:00:00+01:00','Mexico','South Africa',...)
  for (const m of html.matchAll(/\bM\('([A-L])','([^']+)','([^']+)','([^']+)'/g)) {
    out.push({ group: m[1], dt: m[2], t1: m[3], t2: m[4], ko: false });
  }
  // K('Round of 32','M73','<dt>','<homeOrSlot>','<awayOrSlot>',...)
  for (const m of html.matchAll(/\bK\('([^']+)','(M\d+)','([^']+)','([^']+)','([^']+)'/g)) {
    out.push({ round: m[1], mno: m[2], dt: m[3], t1: m[4], t2: m[5], ko: true });
  }
  out.forEach(x => { x.id = `${x.dt}|${x.t1}|${x.t2}`; });
  return out;
}

function parseSquads(html) {
  const m = html.match(/const\s+SQUAD\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch { return {}; }
}

(async () => {
  const t0 = Date.now();
  const html = await fetch(REPO_HTML).then(r => r.text());
  const fixtures = parseFixtures(html);
  const squad = parseSquads(html);
  const teamReal = t => !!(squad[t] && squad[t].length);

  const existing = await sb('results?select=match_id,s1,s2,status,scorers').then(r => r.json());
  const have = {}; (existing || []).forEach(r => have[r.match_id] = { s1: r.s1, s2: r.s2, status: r.status, sc: r.scorers || '' });

  const now = Date.now();
  const cand = fixtures.filter(m => teamReal(m.t1) && teamReal(m.t2) && new Date(m.dt).getTime() <= now);
  const scCount = s => (s || '').split(',').map(x => x.trim()).filter(Boolean).length;
  const need = cand.filter(m => {
    const h = have[m.id]; if (!h) return true;
    if (h.status !== 'FT') return true;
    // FT but timeline still incomplete (fewer recorded scorers than goals) -> keep re-pulling until it fills in
    return scCount(h.sc) < (h.s1 + h.s2);
  });

  const wrote = [], skipped = [];
  for (const m of need) {
    try {
      const q = encodeURIComponent(`${tsdb(m.t1)}_vs_${tsdb(m.t2)}`);
      const j = await fetch(`${TSDB}/searchevents.php?e=${q}&s=2026`).then(r => r.json()).catch(() => null);
      const ev = (j && j.event || []).find(e => /world cup/i.test(e.strLeague || '')) || (j && j.event || [])[0];
      if (!ev || ev.strStatus !== 'FT' || ev.intHomeScore == null || ev.intAwayScore == null) {
        skipped.push(`${m.t1} v ${m.t2}: ${ev ? ev.strStatus : 'not found'}`); await sleep(450); continue;
      }
      const s1 = parseInt(ev.intHomeScore, 10), s2 = parseInt(ev.intAwayScore, 10);
      const h = have[m.id];
      if (h && h.status === 'FT' && (h.s1 !== s1 || h.s2 !== s2)) {
        skipped.push(`${m.t1} v ${m.t2}: DB ${h.s1}-${h.s2} vs TSDB ${s1}-${s2} — NOT overwriting`);
        await sleep(450); continue;
      }
      const tl = await fetch(`${TSDB}/lookuptimeline.php?id=${ev.idEvent}`).then(r => r.json()).catch(() => null);
      const goals = (tl && tl.timeline || [])
        .filter(e => (e.strTimeline || '').toLowerCase() === 'goal' && !/shootout/i.test(e.strTimelineDetail || ''))
        .sort((a, b) => (parseInt(a.intTime || '0', 10)) - (parseInt(b.intTime || '0', 10)));
      const scorers = goals.map(g => (g.strPlayer || '').trim() + (/own\s*goal/i.test(g.strTimelineDetail || '') ? ' (OG)' : '')).filter(Boolean).join(', ');
      // for an already-FT match, only write if the new timeline ADDS scorers (never shrink a fuller/manual list)
      if (h && h.status === 'FT' && goals.length <= scCount(h.sc)) {
        skipped.push(`${m.t1} v ${m.t2}: timeline still incomplete (${goals.length}/${s1 + s2}) — no new scorers`);
        await sleep(450); continue;
      }
      const r = await sb('results?on_conflict=match_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ match_id: m.id, s1, s2, status: 'FT', scorers }])
      });
      if (!r.ok) { skipped.push(`${m.t1} v ${m.t2}: upsert HTTP ${r.status}`); await sleep(450); continue; }
      wrote.push(`${m.t1} ${s1}-${s2} ${m.t2} [${goals.length}g]`);
      await sleep(450);
    } catch (e) { skipped.push(`${m.t1} v ${m.t2}: ${e.message}`); }
  }
  console.log(`fixtures=${fixtures.length} eligible=${cand.length} needed=${need.length} wrote=${wrote.length} skipped=${skipped.length} elapsed=${Math.round((Date.now() - t0) / 1000)}s`);
  wrote.forEach(s => console.log('  + ' + s));
  skipped.forEach(s => console.log('  - ' + s));

  // ====== PASS 2: ESPN STATS — fetch shots/corners/possession/cards/first-scorer/half-goals for FT matches missing STATS|<id>
  // Source: ESPN public FIFA scoreboard (no key, no quota). Feeds the new betting markets.
  console.log('--- pass2 espn stats ---');
  const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';
  const ESPN_ALIAS = { 'Bosnia-Herzegovina': 'Bosnia & Herzegovina', 'Congo DR': 'DR Congo', 'Czechia': 'Czech Republic', 'Türkiye': 'Turkey' };
  const eNorm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/gi, '').toLowerCase();
  const eOur = n => ESPN_ALIAS[n] || n;
  const KEY_TO_NAME = { shotsOnTarget: 'sot', totalShots: 'sh', wonCorners: 'cor', possessionPct: 'pos', yellowCards: 'yel', redCards: 'red', foulsCommitted: 'fou', offsides: 'off', saves: 'sav' };
  const halfOf = c => { if (!c) return null; const mm = parseInt(String(c).replace(/'/g, '').split('+')[0], 10); return isNaN(mm) ? null : (mm <= 45 ? 1 : 2); };

  // 1) Which FT matches DON'T already have a STATS row?
  const stRows = await sb('sidepicks?name=eq._stats&match_id=like.STATS|*&select=match_id').then(r => r.json()).catch(() => []);
  const haveStats = new Set((stRows || []).map(r => r.match_id.slice(6)));
  const ftAll = await sb('results?status=eq.FT&select=match_id,s1,s2').then(r => r.json()).catch(() => []);
  const ftNeedStats = (ftAll || []).filter(r => !haveStats.has(r.match_id));
  console.log(`stats: ${haveStats.size} stored, ${ftAll.length} FT total, ${ftNeedStats.length} missing`);
  if (!ftNeedStats.length) console.log('  (all caught up)');

  // 2) Build ESPN event map across WC dates
  const wantDates = new Set(ftNeedStats.map(r => r.match_id.split('|')[0].slice(0, 10).replace(/-/g, '')));
  const pair2evt = {};
  for (const d of wantDates) {
    try {
      const j = await fetch(`${ESPN}/scoreboard?dates=${d}`).then(r => r.json()).catch(() => null);
      for (const e of (j && j.events || [])) {
        const cs = ((e.competitions || [])[0] || {}).competitors || []; if (cs.length < 2) continue;
        const home = eOur(((cs.find(c => c.homeAway === 'home') || cs[0]).team || {}).displayName || '');
        const away = eOur(((cs.find(c => c.homeAway === 'away') || cs[1]).team || {}).displayName || '');
        const k1 = eNorm(home) + '|' + eNorm(away), k2 = eNorm(away) + '|' + eNorm(home);
        pair2evt[k1] = { id: e.id, home, away }; pair2evt[k2] = { id: e.id, home, away };
      }
    } catch (e) { console.log('  scoreboard', d, e.message); }
    await sleep(150);
  }

  // 3) Fetch summary + upsert per match
  let sOk = 0, sErr = 0;
  for (const r of ftNeedStats) {
    const parts = r.match_id.split('|'); if (parts.length < 3) { sErr++; continue; }
    const t1 = parts[1], t2 = parts[2];
    const evt = pair2evt[eNorm(t1) + '|' + eNorm(t2)];
    if (!evt) { console.log('  ESPN miss:', t1, 'v', t2); sErr++; continue; }
    try {
      const sum = await fetch(`${ESPN}/summary?event=${evt.id}`).then(x => x.json());
      const teams = (sum.boxscore || {}).teams || [];
      const home = teams.find(x => eOur(((x.team || {}).displayName) || '') === t1) || teams[0];
      const away = teams.find(x => x !== home) || teams[1];
      const num = v => { if (v == null) return null; const n = parseFloat(String(v).replace(/[^\d.\-]/g, '')); return isNaN(n) ? null : n; };
      const grab = (t, k) => { const s = ((t || {}).statistics || []).find(x => x.name === k); return s ? s.displayValue : null; };
      const stats = {};
      for (const [ek, ourk] of Object.entries(KEY_TO_NAME)) {
        const h = num(grab(home, ek)), a = num(grab(away, ek));
        if (h != null) stats[ourk + '1'] = h; if (a != null) stats[ourk + '2'] = a;
      }
      // first goalscorer (skip OG)
      const goals = (sum.keyEvents || []).filter(e => /^Goal!/.test(e.text || '') && !/own goal/i.test(e.text || ''))
        .sort((a, b) => { const am = parseInt((((a.clock || {}).displayValue || '0')).replace(/'/g, '').split('+')[0], 10), bm = parseInt((((b.clock || {}).displayValue || '0')).replace(/'/g, '').split('+')[0], 10); return am - bm; });
      if (goals.length) { const m1 = (goals[0].text || '').match(/Goal!.*?\.\s*([^(]+?)\s*\(/); if (m1) stats.fstScr = m1[1].trim(); }
      // half goals (counts goals + own goals — those count toward either half)
      const allG = (sum.keyEvents || []).filter(e => /Goal|own goal/i.test(e.text || ''));
      stats.h1g = allG.filter(g => halfOf(((g.clock || {}).displayValue)) === 1).length;
      stats.h2g = allG.filter(g => halfOf(((g.clock || {}).displayValue)) === 2).length;
      stats.espnId = evt.id;
      const u = await sb('sidepicks?on_conflict=name,match_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ name: '_stats', match_id: 'STATS|' + r.match_id, scbets: [stats], updated_at: new Date().toISOString() }])
      });
      if (!u.ok) { console.log('  upsert err', t1, 'v', t2, u.status); sErr++; }
      else { sOk++; console.log('  + stats', t1, 'v', t2, '— SoT', stats.sot1 + '/' + stats.sot2, '· corners', stats.cor1 + '/' + stats.cor2); }
    } catch (e) { console.log('  summary err', t1, 'v', t2, e.message); sErr++; }
    await sleep(200);
  }
  console.log(`stats: ok=${sOk} err=${sErr}`);

  // ====== PASS 3: CLAUDE'S MISSING PICKS — deterministic backfill.
  // Replaces the unreliable agent-driven daily task. Ensures Claude has a score-wager pick for EVERY upcoming match, every 15 min. Idempotent — never overwrites an existing pick.
  console.log('--- pass3 claude picks ---');
  const STRONG = new Set(['Brazil','France','Spain','Argentina','England','Germany','Portugal','Netherlands']);
  const MID = new Set(['Belgium','Croatia','Uruguay','Morocco','Colombia','Mexico','United States','Senegal','Japan','Switzerland','Norway','Canada','Ivory Coast','Sweden','Turkey','South Korea','Australia','Paraguay']);
  const tier = t => STRONG.has(t) ? 3 : MID.has(t) ? 2 : 1;            // 3=strong, 2=mid, 1=rest
  // pick a scoreline (home, away, stake) from the matchup. Picks reflect WC2026 form patterns: stronger team wins by 1-2, equal tiers lean draw/close, big mismatches are 3-0.
  function claudePick(h, a) {
    const th = tier(h), ta = tier(a);
    const d = th - ta;
    if (d === 2)  return [3, 0, 80];   // strong vs weak
    if (d === 1)  return [2, 0, 60];   // strong vs mid OR mid vs weak
    if (d === 0)  return th === 3 ? [1, 1, 70] : th === 2 ? [2, 1, 60] : [1, 1, 50];  // equal — high-tier draw, mid-tier home edge, low-low draw
    if (d === -1) return [0, 2, 60];   // weak vs mid OR mid vs strong
    if (d === -2) return [0, 3, 80];   // weak vs strong
    return [1, 1, 50];
  }
  // who has Claude already picked?
  const cp = await sb('predictions?name=eq.Claude&select=match_id').then(r => r.json()).catch(() => []);
  const havePick = new Set((cp || []).map(r => r.match_id));
  // upcoming matches: future dt, both teams have squads, not yet predicted
  const nowT = Date.now();
  const upcoming = fixtures.filter(m => teamReal(m.t1) && teamReal(m.t2) && new Date(m.dt).getTime() > nowT && !havePick.has(m.id));
  console.log(`claude: already has ${havePick.size} picks; ${upcoming.length} upcoming need picks`);
  let cOk = 0, cErr = 0;
  for (const m of upcoming) {
    const [home, away, stake] = claudePick(m.t1, m.t2);
    const body = [{ name: 'Claude', match_id: m.id, home, away, stake, joker: false, updated_at: new Date().toISOString() }];
    const r = await sb('predictions?on_conflict=name,match_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(body)
    });
    if (!r.ok) { console.log('  upsert err', m.t1, 'v', m.t2, r.status); cErr++; }
    else { cOk++; console.log(`  + claude ${m.t1} ${home}-${away} ${m.t2} $${stake}`); }
    await sleep(120);
  }
  console.log(`claude: added=${cOk} err=${cErr}`);

  // PASS 3B: side bets for EVERY Claude pick on an upcoming match. Derived from his predicted score. Idempotent — skips if sidepicks row already exists.
  const haveSide = new Set((await sb("sidepicks?name=eq.Claude&select=match_id").then(r=>r.json()).catch(()=>[])).map(r=>r.match_id));
  const allMyPicks = await sb('predictions?name=eq.Claude&select=match_id,home,away,stake').then(r=>r.json()).catch(()=>[]);
  const myPickMap = {}; (allMyPicks||[]).forEach(r=>myPickMap[r.match_id]=r);
  const fxById = {}; fixtures.forEach(m=>fxById[m.id]=m);
  const sideTargets = Object.values(myPickMap).map(r=>fxById[r.match_id]).filter(m=>m && teamReal(m.t1) && teamReal(m.t2) && new Date(m.dt).getTime()>Date.now() && !haveSide.has(m.id));
  console.log(`claude side bets: ${haveSide.size} already; ${sideTargets.length} new picks need side bets`);
  let sOk2 = 0, sErr2 = 0;
  for (const m of sideTargets) {
    const p = myPickMap[m.id]; const tot = p.home + p.away; const both = p.home > 0 && p.away > 0;
    const ou = tot >= 3 ? 'O' : 'U';
    const btts = both ? 'Y' : 'N';
    const fav = p.home > p.away ? m.t1 : p.away > p.home ? m.t2 : (tier(m.t1) >= tier(m.t2) ? m.t1 : m.t2);
    const star = (squad[fav] || [])[0] || null;             // index 0 = the team's headline striker, prices at 2.0x
    const scbets = star ? [{ p: star, st: 25 }] : [];
    const row = { name: 'Claude', match_id: m.id, ou, ou_stake: 25, btts, btts_stake: 20, scorer: null, scbets, updated_at: new Date().toISOString() };
    const rr = await sb('sidepicks?on_conflict=name,match_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([row])
    });
    if (!rr.ok) { console.log('  side upsert err', m.t1, 'v', m.t2, rr.status); sErr2++; }
    else { sOk2++; console.log(`  + claude side ${m.t1.slice(0,3)}-${m.t2.slice(0,3)}: O/U=${ou}$25 BTTS=${btts}$20 ⚽${star||'(none)'}$25`); }
    await sleep(120);
  }
  console.log(`claude side bets: added=${sOk2} err=${sErr2}`);

  // ====== PASS 4: SMART CLAUDE ('Claude Sharp') — FORM-AWARE private picks (admin-only visible in app).
  // Independent of pass 3's static tiers: builds REAL form (GF/GA/scorers/clean sheets) from results,
  // derives score/OU/BTTS/scorer per upcoming match. Idempotent — never overwrites an existing pick.
  console.log('--- pass4 claude sharp (form-aware) ---');
  const SH = 'Claude Sharp';
  const normN = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const freshRes = await sb('results?status=eq.FT&select=match_id,s1,s2,scorers').then(r => r.json()).catch(() => []);
  const fT = {}, gBy = {}, cSh = {};
  for (const r of (freshRes || [])) {
    const p = r.match_id.split('|'); if (p.length < 3) continue;
    const t1 = p[1], t2 = p[2], s1 = r.s1, s2 = r.s2;
    const e1 = fT[t1] || (fT[t1] = { n: 0, gf: 0, ga: 0, pts: 0 }), e2 = fT[t2] || (fT[t2] = { n: 0, gf: 0, ga: 0, pts: 0 });
    e1.n++; e1.gf += s1; e1.ga += s2; e2.n++; e2.gf += s2; e2.ga += s1;
    if (s2 === 0) cSh[t1] = (cSh[t1] || 0) + 1; if (s1 === 0) cSh[t2] = (cSh[t2] || 0) + 1;
    if (s1 > s2) e1.pts += 3; else if (s2 > s1) e2.pts += 3; else { e1.pts++; e2.pts++; }
    for (let nm of (r.scorers || '').split(',')) { nm = nm.trim(); if (!nm || /\(OG\)/.test(nm)) continue; gBy[normN(nm)] = (gBy[normN(nm)] || 0) + 1; }
  }
  const shPrior = t => STRONG.has(t) ? [1.9, 0.8] : MID.has(t) ? [1.2, 1.1] : [0.7, 1.9];
  const shRates = t => { const e = fT[t] || { n: 0, gf: 0, ga: 0 }; const pr = shPrior(t); return [(e.gf + pr[0]) / (e.n + 1), (e.ga + pr[1]) / (e.n + 1)]; };
  const clampn = x => Math.max(0, Math.min(5, Math.round(x)));
  const topScorerFor = team => { const pls = squad[team] || []; let best = null, bg = -1, bi = 99; pls.forEach((p, i) => { const g = gBy[normN(p)] || 0; if (g > bg || (g === bg && i < bi)) { bg = g; bi = i; best = p; } }); return best; };
  function sharpPick(t1, t2) {
    const a = shRates(t1), b = shRates(t2);
    const xgH = (a[0] + b[1]) / 2, xgA = (b[0] + a[1]) / 2;
    let home = clampn(xgH), away = clampn(xgA);
    if (home === 0 && away === 0) { if (xgH >= xgA) home = 1; else away = 1; }
    const tot = xgH + xgA, conf = Math.abs(xgH - xgA);
    const stake = Math.min(100, Math.max(40, Math.round((40 + conf * 45) / 10) * 10));
    const ou = tot >= 2.7 ? 'O' : 'U';
    const btts = Math.min(xgH, xgA) >= 0.9 ? 'Y' : 'N';
    const fav = xgH >= xgA ? t1 : t2;
    return { home, away, stake, ou, btts, scorer: topScorerFor(fav), conf };
  }
  const shHave = new Set((await sb('predictions?name=eq.' + encodeURIComponent(SH) + '&select=match_id').then(r => r.json()).catch(() => [])).map(r => r.match_id));
  const shHaveSide = new Set((await sb('sidepicks?name=eq.' + encodeURIComponent(SH) + '&select=match_id').then(r => r.json()).catch(() => [])).map(r => r.match_id));
  // ROLLING WINDOW: only the 4 SOONEST upcoming games (Nobby asked Claude Sharp to focus on the next four at a time).
  const next4 = fixtures.filter(m => teamReal(m.t1) && teamReal(m.t2) && new Date(m.dt).getTime() > Date.now())
    .sort((a, b) => new Date(a.dt) - new Date(b.dt)).slice(0, 4);
  const shUpcoming = next4.filter(m => !shHave.has(m.id));
  console.log(`claude sharp: ${shHave.size} picks; next-4 window, ${shUpcoming.length} need score/side picks`);
  let shJoker = null, shJC = -1;
  const shPicks = shUpcoming.map(m => { const pk = sharpPick(m.t1, m.t2); if (pk.conf > shJC) { shJC = pk.conf; shJoker = m.id; } return { m, pk }; });
  let shP = 0, shS = 0;
  for (const { m, pk } of shPicks) {
    const r = await sb('predictions?on_conflict=name,match_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ name: SH, match_id: m.id, home: pk.home, away: pk.away, stake: pk.stake, joker: m.id === shJoker, updated_at: new Date().toISOString() }]) });
    if (r.ok) shP++; else console.log('  sharp pred err', m.t1, 'v', m.t2, r.status);
    if (!shHaveSide.has(m.id)) {
      const scb = pk.scorer ? [{ p: pk.scorer, st: 25 }] : [];
      const rr = await sb('sidepicks?on_conflict=name,match_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ name: SH, match_id: m.id, ou: pk.ou, ou_stake: 25, btts: pk.btts, btts_stake: 20, scorer: null, scbets: scb, updated_at: new Date().toISOString() }]) });
      if (rr.ok) shS++; else console.log('  sharp side err', m.t1, 'v', m.t2, rr.status);
    }
    await sleep(100);
  }
  console.log(`claude sharp: preds+=${shP} sides+=${shS} joker=${shJoker || 'none'}`);

  // ====== PASS 4B: SMART CLAUDE markets ("more bets") for the next-4 window — score-derived, priced with the app's exact odds model. Idempotent.
  try {
    const SEED_STR = { Brazil: 9, France: 9, Spain: 9, Argentina: 9, England: 8, Germany: 8, Portugal: 8, Netherlands: 7, Belgium: 6, Croatia: 5, Uruguay: 5, Morocco: 5, Colombia: 4, Mexico: 4, 'United States': 4, Senegal: 4, Japan: 4, Switzerland: 4, Denmark: 4, Italy: 4 };
    const teamStrength = t => { const e = fT[t]; const f = e ? (e.pts * 3 + (e.gf - e.ga) + e.gf * 0.3) : 0; return f + (SEED_STR[t] || 2); };
    const oddsP = p => Math.max(1.1, Math.round(Math.min(17, 0.90 / Math.max(0.05, p)) * 20) / 20);
    const wProbs = (sH, sA) => { const eH = Math.exp(sH / 3.2), eA = Math.exp(sA / 3.2), wH = eH / (eH + eA), pD = Math.max(0.16, 0.30 - 0.26 * Math.abs(wH - 0.5)); return { H: wH * (1 - pD), D: pD, A: (1 - wH) * (1 - pD) }; };
    const FACT = [1, 1, 2, 6], poiss = (k, l) => Math.exp(-l) * Math.pow(l, k) / FACT[k];
    const csExp = (sH, sA) => [Math.max(0.45, Math.min(3.0, 1.35 * Math.exp((sH - sA) * 0.055))), Math.max(0.45, Math.min(3.0, 1.35 * Math.exp((sA - sH) * 0.055)))];
    const csOddsP = p => Math.max(1.5, Math.round(Math.min(51, 0.82 / Math.max(0.008, p)) * 2) / 2);
    const csScoreOdds = (sH, sA, a, c) => { if (a > 3 || c > 3) return 26; const e = csExp(sH, sA); return csOddsP(poiss(a, e[0]) * poiss(c, e[1])); };
    const csOdds = (sH, sA) => ({ H: oddsP(Math.max(0.12, Math.min(0.6, 0.33 + (sH - sA) * 0.022))), A: oddsP(Math.max(0.12, Math.min(0.6, 0.33 + (sA - sH) * 0.022))) });
    const mgnOdds = (sH, sA) => { const p = wProbs(sH, sA); return { h1: oddsP(p.H * 0.55), h2: oddsP(p.H * 0.30), h3: oddsP(p.H * 0.15), d: oddsP(p.D), a1: oddsP(p.A * 0.55), a2: oddsP(p.A * 0.30), a3: oddsP(p.A * 0.15) }; };
    const winOddsJ = (sH, sA) => { const p = wProbs(sH, sA); return { H: oddsP(p.H), D: oddsP(p.D), A: oddsP(p.A) }; };
    const shHaveMkt = new Set((await sb('sidepicks?name=eq.' + encodeURIComponent(SH) + '&match_id=like.MKT|*&select=match_id').then(r => r.json()).catch(() => [])).map(r => r.match_id.slice(4)));
    const myPickMap2 = {}; (await sb('predictions?name=eq.' + encodeURIComponent(SH) + '&select=match_id,home,away').then(r => r.json()).catch(() => [])).forEach(r => myPickMap2[r.match_id] = r);
    let mk4 = 0;
    for (const m of next4) {
      if (shHaveMkt.has(m.id)) continue;
      const p = myPickMap2[m.id]; if (!p) continue;
      const sH = teamStrength(m.t1), sA = teamStrength(m.t2), h = p.home, a = p.away, d = h - a;
      const rows = [];
      const tw = d > 0 ? 'H' : d < 0 ? 'A' : 'D'; rows.push({ mk: 'win', pk: tw, st: 20, od: winOddsJ(sH, sA)[tw] });
      if (h <= 3 && a <= 3) rows.push({ mk: 'cscore', pk: h + '-' + a, st: 15, od: csScoreOdds(sH, sA, h, a) });
      const mp = d === 0 ? 'd' : d === 1 ? 'h1' : d === 2 ? 'h2' : d >= 3 ? 'h3' : d === -1 ? 'a1' : d === -2 ? 'a2' : 'a3'; rows.push({ mk: 'mgn', pk: mp, st: 15, od: mgnOdds(sH, sA)[mp] });
      if (a === 0 && h > 0) rows.push({ mk: 'cs', pk: 'H', st: 20, od: csOdds(sH, sA).H });
      else if (h === 0 && a > 0) rows.push({ mk: 'cs', pk: 'A', st: 20, od: csOdds(sH, sA).A });
      const rr = await sb('sidepicks?on_conflict=name,match_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ name: SH, match_id: 'MKT|' + m.id, scbets: rows, updated_at: new Date().toISOString() }]) });
      if (rr.ok) mk4++; else console.log('  sharp mkt err', m.t1, 'v', m.t2, rr.status);
      await sleep(100);
    }
    console.log(`claude sharp markets: added=${mk4}`);
  } catch (e) { console.log('  pass4b markets error (non-fatal):', e.message); }
})().catch(e => { console.error('FAIL', e.stack); process.exit(1); });
