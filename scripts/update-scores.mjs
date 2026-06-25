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
})().catch(e => { console.error('FAIL', e.stack); process.exit(1); });
