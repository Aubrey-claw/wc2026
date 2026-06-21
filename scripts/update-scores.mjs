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
  const need = cand.filter(m => {
    const h = have[m.id]; if (!h) return true;
    if (h.status !== 'FT') return true;
    // FT and we already have score; only re-probe if scorers blank AND it wasn't a 0-0 (then there really are scorers to fetch)
    return !h.sc && (h.s1 + h.s2) > 0;
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
      if (have[m.id] && have[m.id].status === 'FT' && (have[m.id].s1 !== s1 || have[m.id].s2 !== s2)) {
        skipped.push(`${m.t1} v ${m.t2}: DB ${have[m.id].s1}-${have[m.id].s2} vs TSDB ${s1}-${s2} — NOT overwriting`);
        await sleep(450); continue;
      }
      const tl = await fetch(`${TSDB}/lookuptimeline.php?id=${ev.idEvent}`).then(r => r.json()).catch(() => null);
      const goals = (tl && tl.timeline || [])
        .filter(e => (e.strTimeline || '').toLowerCase() === 'goal' && !/shootout/i.test(e.strTimelineDetail || ''))
        .sort((a, b) => (parseInt(a.intTime || '0', 10)) - (parseInt(b.intTime || '0', 10)));
      const scorers = goals.map(g => (g.strPlayer || '').trim() + (/own\s*goal/i.test(g.strTimelineDetail || '') ? ' (OG)' : '')).filter(Boolean).join(', ');
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
})().catch(e => { console.error('FAIL', e.stack); process.exit(1); });
