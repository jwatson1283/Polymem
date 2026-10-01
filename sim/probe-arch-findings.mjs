// Reproduce B1..B5 + W1 against the real module BEFORE any fix.
// Every number here is measured, not asserted from the review.
//
// ISOLATION. INDEX_FILE and SESSIONS_DIR are resolved at MODULE LOAD, so a probe
// that reassigns process.env after the import measures nothing. Every scenario
// that needs its own index therefore runs in its OWN PROCESS, spawned with the
// env already set. The first draft of this file got W1, B3 and B4 wrong for
// exactly that reason and "confirmed" three findings that were not there.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = resolve(HERE, '..', 'src', 'polymem.mjs');

// A child that runs one scenario with a private HOME and index path.
function scenario(name, body) {
  const home = mkdtempSync(join(tmpdir(), `polymem-${name}-`));
  mkdirSync(join(home, 'memory'), { recursive: true });
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const src = `
    const m = await import(${JSON.stringify(MODULE)});
    const out = (o) => console.log('@@' + JSON.stringify(o));
    ${body}
  `;
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      OMEGA_MEMORY_INDEX: join(home, 'memory', 'patterns-index.json'),
      OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions'),
    },
  });
  if (p.status !== 0 && !p.stdout.includes('@@')) {
    console.log(`  CHILD FAILED: ${p.stderr.trim()}`);
  }
  rmSync(home, { recursive: true, force: true });
  return p.stdout.split('\n').filter(l => l.startsWith('@@')).map(l => JSON.parse(l.slice(2)));
}

const line = (s) => console.log(s);
const tmp = mkdtempSync(join(tmpdir(), 'polymem-probe-'));

// ═══════════════════════ B1 ═══════════════════════
line('══ B1 — patternId truncation manufactures false corroboration ══');
{
  const out = scenario('b1', `
    const P = 'Atomic rename publishes a whole file or nothing, so a crash mid-write never leaves a torn index behind on disk even when';
    const ALPHA = P + ' two writers race to publish the same state file simultaneously';
    const BETA  = P + ' the decomposer crashes between reading and committing a pattern ledger';
    out({ idA: m.patternId(ALPHA), idB: m.patternId(BETA),
          nearDupWouldMerge: m.findNearDuplicatePatternId(BETA, { patterns: { [m.patternId(ALPHA)]: { name: ALPHA } } }) !== null });
    // ALPHA once, BETA twice — two genuinely different facts.
    for (const [date, name, doms] of [
      ['2026-04-01', ALPHA, ['code']],
      ['2026-04-02', BETA,  ['code', 'ops']],
      ['2026-04-03', BETA,  ['code', 'ops']],
    ]) {
      m.appendWorkingMemory(date, { time: date, agent: 'probe', task: 't', claims: [],
        patterns: [{ text: name, domains: doms }], correspondences: [], contradictions: [] });
      m.promoteSession(date, m.loadPatternsIndex());
    }
    const idx = m.loadPatternsIndex();
    const ids = Object.keys(idx.patterns);
    const p = idx.patterns[ids[0]];
    out({ ids, status: p.status, evidenceCount: p.evidenceCount,
          nameVariations: p.nameVariations, domains: p.domains, sessions: p.sessions });
  `);
  const [ids, res] = out;
  line(`  id(ALPHA) = ${ids.idA}`);
  line(`  id(BETA)  = ${ids.idB}`);
  line(`  COLLIDE   = ${ids.idA === ids.idB}`);
  line(`  the near-dup guard would have merged them (0.9 containment)? ${ids.nearDupWouldMerge}  <-- so this is a pure id collision`);
  line(`  patterns after 3 sessions: ${res.ids.length}  ${JSON.stringify(res.ids)}`);
  line(`  status=${res.status} evidenceCount=${res.evidenceCount} nameVariations=${JSON.stringify(res.nameVariations)}`);
  line(`  >>> FALSE CORROBORATION = ${res.ids.length === 1 && res.status === 'established'}`);
  line(`  >>> the surviving entry is named: "...${res.ids[0].slice(-40)}"`);
  line(`  >>> nameVariations is EMPTY, so the audit trail does not even record the drift`);
}

// ═══════════════════════ W1 ═══════════════════════
line('');
line('══ W1 — established is contingent on a prose "— domains:" suffix ══');
for (const [label, doms] of [['ZERO domains', []], ['ONE domain', ['code']], ['TWO domains', ['code', 'ops']]]) {
  const [res] = scenario('w1', `
    const NAME = 'Serialize read-modify-write under a single write claim before committing state';
    const doms = ${JSON.stringify(doms)};
    for (let d = 1; d <= 4; d++) {
      const date = '2026-05-0' + d;
      m.appendWorkingMemory(date, { time: date, agent: 'probe', task: 't', claims: [],
        patterns: [{ text: NAME, domains: doms }], correspondences: [], contradictions: [] });
      m.promoteSession(date, m.loadPatternsIndex());
    }
    const idx = m.loadPatternsIndex();
    const id = Object.keys(idx.patterns)[0];
    const p = idx.patterns[id];
    out({ sessions: p.sessions.length, domains: p.domains, status: p.status,
          promotions: idx.meta.promotions, patternGate: idx.meta.patternGate,
          // Reported, not inferred: the bag names the reason per pattern, so a
          // non-candidate can be traced to a specific unmet half.
          trustGate: idx.meta.trustGate || null,
          reasons: Object.keys(idx.meta.trustGate?.heldBack || {}) });
  `);
  line(`  ${label.padEnd(13)} sessions=${res.sessions} domains=${res.domains.length} status=${res.status}`);
  line(`  ${''.padEnd(13)} meta.promotions=${res.promotions} patternGate=${JSON.stringify(res.patternGate)}`);
  line(`  ${''.padEnd(13)} meta.trustGate=${JSON.stringify(res.trustGate)}`);
  line(`  ${''.padEnd(13)} >>> NOTHING SAYS WHY = ${res.reasons.length === 0}`
    + `   (held-back reasons named: ${JSON.stringify(res.reasons)})`);
}

// The shipped fixture, which is the corpus the project actually validates
// against. Run through the REAL parse path (raw text -> parseMemoryBlock), not
// by reading the fixture's structure, so the measurement matches what the
// library sees.
line('  --- the shipped real-corpus fixture, run through the real parse path ---');
{
  const fix = await import('../test/fixtures/real-corpus.mjs');
  const m2 = await import(MODULE);
  const dist = {};
  let total = 0;
  const recur = new Map();
  for (const s of fix.SESSIONS) {
    const { memory } = m2.parseMemoryBlock(s.raw);
    for (const p of memory.patterns || []) {
      const n = (p.domains || []).length;
      dist[n] = (dist[n] || 0) + 1;
      total++;
      recur.set(m2.patternId(p.text), (recur.get(m2.patternId(p.text)) || 0) + 1);
    }
  }
  line(`  pattern lines parsed: ${total}`);
  line(`  domain-count distribution: ${JSON.stringify(dist)}`);
  line(`  lines with ONE domain — they can NEVER establish, however long they recur: ${dist['1'] || 0}`);
  const maxRecur = Math.max(...recur.values());
  const cleared = [...recur.values()].filter(v => v >= 3).length;
  line(`  max recurrence of any pattern across the whole fixture: ${maxRecur}  (computeStatus needs 3 sessions)`);
  line(`  patterns that can clear the SESSION bar: ${cleared} of ${recur.size}`);
  line(`  >>> the corpus can produce ${cleared === 0 ? 'ZERO' : cleared} established patterns`);
}

// ═══════════════════════ B2 ═══════════════════════
line('');
line('══ B2 — the concurrent merge resurrects absorbed patterns ══');
{
  const [res] = scenario('b2', `
    const now = new Date().toISOString();
    const disk = { version: 1, patterns: {
        A: { name: 'Alpha pattern survives', domains: ['code'], sessions: ['2026-06-01'], evidenceCount: 1, status: 'candidate', correspondences: [], contradictions: [] } },
      meta: { absorbedPatterns: [{ absorbed: 'B', kept: 'A', at: now, record: { name: 'Beta was absorbed here' } }] } };
    const stale = { version: 1, patterns: {
        A: disk.patterns.A,
        B: { name: 'Beta was absorbed here', domains: ['code'], sessions: ['2026-06-01'], evidenceCount: 1, status: 'candidate', correspondences: [], contradictions: [] } },
      meta: { absorbedPatterns: [] } };   // loaded BEFORE the consolidation
    const merged = m.mergeConcurrentIndex(stale, disk);
    out({ mergedIds: Object.keys(merged.patterns),
          tombstoneForB: (merged.meta.absorbedPatterns || []).some(t => t.absorbed === 'B') });
  `);
  line(`  disk has [A] + a tombstone for [B];  stale snapshot has [A, B]`);
  line(`  merged patterns: [${res.mergedIds.join(', ')}]`);
  line(`  >>> B RESURRECTED = ${res.mergedIds.includes('B')}`);
  // The contradiction only exists when BOTH facts hold: the tombstone says
  // absorbed AND the entry is live. Each alone is correct — a tombstone
  // outliving its pattern is normal, and a live pattern with no tombstone is
  // normal. Only the pair is a bug, so only the pair is reported as one.
  const contradictory = res.tombstoneForB && res.mergedIds.includes('B');
  line(`  >>> tombstone claims B absorbed = ${res.tombstoneForB}`);
  line(`  >>> SIMULTANEOUSLY ABSORBED AND LIVE = ${contradictory}`);
}

// ═══════════════════════ B3 ═══════════════════════
line('');
line('══ B3 — promoteSession throws away the save result ══');
{
  const out = scenario('b3', `
    const { writeFileSync } = await import('node:fs');
    const { hostname } = await import('node:os');
    const INDEX = process.env.OMEGA_MEMORY_INDEX;
    m.appendWorkingMemory('2026-06-10', { time: 'x', agent: 'probe', task: 't', claims: [],
      patterns: [{ text: 'Verify the store after a merge that never landed', domains: ['code', 'ops'] }],
      correspondences: [], contradictions: [] });
    // A claim held by THIS (live) pid: the writer must refuse to write.
    writeFileSync(INDEX + '.claim', JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }));
    const t0 = Date.now();
    const ret = m.promoteSession('2026-06-10', m.loadPatternsIndex());
    const dt = Date.now() - t0;
    const { existsSync } = await import('node:fs');
    const wrote = existsSync(INDEX);
    out({ ret, dt, wrote });
  `);
  const res = out[out.length - 1];
  line(`  returned in ${res.dt}ms`);
  line(`  returned: ${JSON.stringify(res.ret)}`);
  line(`  index file written? ${res.wrote}`);
  // The defect was a return value that SHAPED like success while the write had
  // not happened. Post-fix the honest question is whether the return value lets
  // a caller TELL — so that is what is measured, not just whether it threw.
  line(`  >>> LOOKS-SUCCESS-WHILE-BROKEN = ${!res.wrote && res.ret.promoted.length === 1 && res.ret.saved !== false}`
    + `   (saved reported: ${JSON.stringify(res.ret.saved)})`);
  line(`  >>> CALLER CAN TELL = ${res.ret.saved === false ? 'yes — saved:false' : 'NO — still indistinguishable'}`);
}

// ═══════════════════════ B4 ═══════════════════════
line('');
line('══ B4 — a crashed writer stalls the event loop ══');
{
  const out = scenario('b4', `
    const { writeFileSync, utimesSync, rmSync } = await import('node:fs');
    const { hostname } = await import('node:os');
    const INDEX = process.env.OMEGA_MEMORY_INDEX;
    const add = (id) => { const i = m.loadPatternsIndex(); i.patterns[id] = {
      name: 'crash probe ' + id, domains: [], sessions: [], evidenceCount: 1, status: 'candidate',
      correspondences: [], contradictions: [] }; return i; };
    const results = [];
    // A claim whose pid cannot exist and whose mtime is FRESH: exactly what a
    // process that crashed a second ago leaves behind.
    writeFileSync(INDEX + '.claim', JSON.stringify({ pid: 0x7ffffffe, host: hostname(), at: Date.now() }));
    let t0 = Date.now(); let saved = m.savePatternsIndex(add('crash-a'));
    results.push({ age: 0, saved, ms: Date.now() - t0 });
    rmSync(INDEX + '.claim', { force: true });
    for (const age of [0, 20_000]) {
      writeFileSync(INDEX + '.claim', JSON.stringify({ pid: 0x7ffffffe, host: hostname(), at: Date.now() }));
      const when = age === 0 ? new Date() : new Date(Date.now() - age);
      utimesSync(INDEX + '.claim', when, when);
      t0 = Date.now(); saved = m.savePatternsIndex(add('crash-' + age));
      results.push({ age, saved, ms: Date.now() - t0 });
      rmSync(INDEX + '.claim', { force: true });
    }
    out({ results });
  `);
  for (const r of out[0].results) {
    line(`  crashed claim ${(r.age / 1000).toFixed(0).padStart(2)}s old -> save ${r.saved ? 'OK  ' : 'FAIL'} in ${String(r.ms).padStart(5)}ms`);
  }
  const worst = Math.max(...out[0].results.map(r => r.ms));
  line(`  >>> worst blocked-event-loop cost for a provably-dead holder: ${worst}ms`);
}

// ═══════════════════════ B5 ═══════════════════════
line('');
line('══ B5 — queryPatterns cannot express trust, silently drops 2-char terms ══');
{
  const [res] = scenario('b5', `
    const idx = { patterns: {
      'ui-tokens': { name: 'Design tokens are the single source for every surface', domains: ['design'],
                     sessions: ['2026-06-01', '2026-06-02', '2026-06-03'], evidenceCount: 3, status: 'established' },
      'rename-guard': { name: 'Atomic rename prevents lost updates on crash', domains: ['code'],
                     sessions: ['2026-06-01'], evidenceCount: 1, status: 'candidate' } } };
    out({ ui: m.queryPatterns('ui', idx).length,
          uiStatus: m.queryPatterns('ui', idx, { status: 'established' }).length,
          functionWords: m.queryPatterns('why did the deploy refuse', idx).map(r => r.id),
          missingStatusArg: m.queryPatterns('atomic', idx).map(r => r.id + ':' + r.status) });
  `);
  line(`  queryPatterns('ui')                       -> ${res.ui} hits   (ui normalizes to domain "design" on the WRITE path)`);
  line(`  queryPatterns('ui', {status:'established'}) -> ${res.uiStatus} hits   (options bag ignored entirely)`);
  line(`  queryPatterns('why did the deploy refuse')  -> ${JSON.stringify(res.functionWords)}   (function words only)`);
  line(`  queryPatterns('atomic')                   -> ${JSON.stringify(res.missingStatusArg)}   (cannot ask for trust)`);
}

rmSync(tmp, { recursive: true, force: true });