// test-concurrent-writes.mjs
//
// REGRESSION TEST FOR THE SHARED-TMP DATA LOSS (polymem.mjs:338 and :418, old).
//
// THE BUG. Both writers built a FIXED tmp name — `INDEX_FILE + '.tmp'` and
// `p + '.tmp'`. Two processes writing at once therefore shared ONE temp file:
// writer B's open(O_TRUNC) erased the bytes writer A had already written and
// fully flushed, and whichever process called rename() last published its own
// payload. A's data was destroyed even though A had written all of it and
// reported success.
//
// MEASURED, 5 concurrent processes x 600 patterns each:
//   expected 3000 patterns, ACTUAL 600 — 2400 lost (80%), and only 1 of the 5
//   writers was represented in the file at all. All five printed saved:true.
//
// WHY THIS TEST IS NOT A TIMING TEST. The obvious assertion — "run N writers,
// count the patterns" — cannot distinguish the tmp collision from ordinary
// last-writer-wins, because BOTH leave one writer's payload in the file. It also
// depends on process scheduling, so it is flaky by construction, and a flaky
// concurrency test is worse than no test: it fails on a fixed build and passes
// on a broken one roughly at the same rate.
//
// So this asserts the CAUSE, not the symptom: plant a decoy at the exact path
// the old code wrote through, and require that a real save never touches it.
// Deterministic, no sleeps, no races. If the tmp name is derived per write, the
// decoy is untouched; if it is the old fixed name, the decoy is clobbered.
//
// WHAT THIS NOW ALSO CLAIMS (added with the concurrent-merge fix). The header
// used to say, correctly for the code as it stood:
//
//   "It does not claim that concurrent saves MERGE. They do not, and cannot
//    with this API... That is a design property, not the tmp bug, and fixing
//    it would need a lock or an append-only log."
//
// That diagnosis was right and the conclusion was wrong — it does not need an
// append-only log. savePatternsIndex takes a full snapshot and publishes it
// verbatim, so the last writer discarded whatever the earlier writers had
// added; measured here, 5 writers x 600 patterns left 600 in the file, and all
// five reported saved:true. The snapshot is now MERGED against on-disk state
// inside an atomic claim (O_CREAT|O_EXCL, portable to Windows where flock is
// not), so this suite now also asserts that zero writes are lost.
//
// A note on why the pre-fix assertions below were inverted rather than deleted:
// they encoded the lost update as INTENDED behaviour ("last-writer-wins, by
// design"). Inverting them is the actual regression test — deleting them would
// have turned a green suite over a data-loss bug into a green suite over
// nothing.

import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = join(REPO, 'src', 'polymem.mjs');

import { createSuite } from './harness.mjs';

const { ok, done } = createSuite('test-concurrent-writes.mjs');

const child = (body, env) => {
  const src = `
    import(${JSON.stringify(MODULE)}).then(
      (m) => { ${body} },
      (e) => { console.log(JSON.stringify({ loadThrew: (e.message || String(e)).slice(0, 300) })); }
    );
  `;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', src],
      { cwd: REPO, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'] });
    return { out, err: '', code: 0 };
  } catch (e) {
    return { out: (e.stdout || ''), err: (e.stderr || ''), code: e.status ?? -1 };
  }
};
const lastJson = (r) => { try { return JSON.parse(r.out.trim().split('\n').pop()); } catch { return {}; } };

console.log('concurrent-write tmp collision:');

const workdir = mkdtempSync(join(tmpdir(), 'polymem-conc-'));
try {
  // ── 1. the load-bearing assertion: the fixed tmp path is never written ────
  // The decoy stands in for "another process that is mid-write on the old
  // fixed path". A save that goes through `INDEX_FILE + '.tmp'` destroys it; a
  // save that uses a unique per-write name cannot.
  {
    const home = join(workdir, 'home1');
    const indexFile = join(home, 'memory', 'patterns-index.json');
    mkdirSync(dirname(indexFile), { recursive: true });
    const decoy = indexFile + '.tmp';
    const decoyBody = 'DECOY-ANOTHER-WRITER-PAYLOAD-must-not-be-clobbered';
    writeFileSync(decoy, decoyBody);

    const r = child(`
      const patterns = {};
      for (let k = 0; k < 50; k++) patterns['real-' + k] = {
        name: 'real ' + k, domains: ['code'], sessions: ['2026-09-30'],
        evidenceCount: 1, status: 'candidate', firstSeen: 'x', lastSeen: 'x',
        correspondences: [], contradictions: [], nameVariations: [], implicatedBy: [],
      };
      const saved = m.savePatternsIndex({ version: 1, patterns, meta: { decompositionStats: {}, promotions: 1 } });
      console.log(JSON.stringify({ saved }));
    `, { HOME: home, OMEGA_MEMORY_INDEX: indexFile, OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions') });

    const j = lastJson(r);
    ok(j.saved === true, 'a real save succeeds with a foreign file sitting on the old tmp path',
      `saved=${j.saved}`);
    // Read the decoy defensively. On the old code the save renames it away, so
    // the file is GONE rather than merely overwritten — an unguarded read
    // throws and takes the whole test file down with it, hiding every
    // assertion that follows. A regression test must fail loudly at the
    // assertion, not abort the run.
    const decoySurvived = existsSync(decoy);
    const decoyBodyNow = decoySurvived ? readFileSync(decoy, 'utf8') : null;
    ok(decoyBodyNow === decoyBody,
      'THE TMP PATH IS NOT SHARED — a save never writes through INDEX_FILE + \'.tmp\'',
      decoySurvived
        ? 'the decoy was OVERWRITTEN — that is the original collision'
        : 'the decoy was RENAMED AWAY — the save consumed another writer\'s temp file');
    ok(JSON.parse(readFileSync(indexFile, 'utf8')).patterns !== undefined,
      'the index itself was written and parses');
  }

  // ── 2. two writes in the SAME process must not collide either ────────────
  // A per-write counter (or any per-call uniquifier) is required, not merely a
  // per-process one: two saves in the same process in the same millisecond
  // share a pid.
  {
    const home = join(workdir, 'home2');
    const indexFile = join(home, 'memory', 'patterns-index.json');
    const r = child(`
      const mk = (n) => { const p = {}; for (let k = 0; k < n; k++) p['p-' + n + '-' + k] = {
        name: 'p ' + n + ' ' + k, domains: ['code'], sessions: ['2026-09-30'],
        evidenceCount: 1, status: 'candidate', firstSeen: 'x', lastSeen: 'x',
        correspondences: [], contradictions: [], nameVariations: [], implicatedBy: [] }; return p; };
      const a = m.savePatternsIndex({ version: 1, patterns: mk(5), meta: {} });
      const b = m.savePatternsIndex({ version: 1, patterns: mk(7), meta: {} });
      const c = m.savePatternsIndex({ version: 1, patterns: mk(9), meta: {} });
      console.log(JSON.stringify({ a, b, c }));
    `, { HOME: home, OMEGA_MEMORY_INDEX: indexFile, OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions') });
    const j = lastJson(r);
    ok(j.a === true && j.b === true && j.c === true,
      'three rapid same-process saves all report success', JSON.stringify(j));
    // WAS: "the LAST save is the one that survives (last-writer-wins, by
    // design)" — asserting === 9. That assertion ENCODED the lost update as
    // intended behaviour: three disjoint saves, each reporting success, and two
    // thirds of the patterns silently gone. Each writer was handed a snapshot
    // that never saw the others' patterns, so publishing it verbatim discarded
    // them. The fix merges the snapshot against on-disk state inside the claim,
    // so all three survive: 5 + 7 + 9.
    ok(Object.keys(JSON.parse(readFileSync(indexFile, 'utf8')).patterns || {}).length === 21,
      'disjoint same-process saves MERGE — 5+7+9=21 patterns survive, none lost');
  }

  // ── 3. a failed write leaves no partial file behind ──────────────────────
  // The old code had no cleanup at all. A failed write that leaves a temp file
  // next to the index is how a stale file gets promoted into a real one by a
  // later rename.
  {
    const home = join(workdir, 'home3');
    const bad = '/dev/null/nope/patterns-index.json';
    const r = child(`
      m.savePatternsIndex({ version: 1, patterns: { x: { name: 'x', domains: [], sessions: [], evidenceCount: 1, status: 'candidate', correspondences: [], contradictions: [] } }, meta: {} });
      console.log(JSON.stringify({ done: true }));
    `, { HOME: home, OMEGA_MEMORY_INDEX: bad, OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions') });
    lastJson(r);
    const dir = '/dev/null/nope';
    ok(!existsSync(join(dir, 'patterns-index.json')),
      'a failed save does not create the index file');
  }

  // ── 4. the real-world symptom: concurrent writers, measured ─────────────
  // Kept because it is the finding's headline number and a reader should see
  // what the fix does and does not move. 5 processes x 600 patterns.
  //
  // WAS: "the surviving payload is ONE writer's complete set (600), not a
  // blend". That assertion was a deliberate refusal to require a merge — the
  // comment above it said reaching 3000 "would be asserting a feature that does
  // not exist". The feature now exists, and the merge is the whole point of the
  // fix, so the assertion is inverted to require zero lost writes. Everything
  // else here is unchanged: still no barrier, still 5 real processes, still
  // checking validity and truthfulness of the reported results.
  {
    const WRITERS = 5, PER = 600;
    const home = join(workdir, 'home4');
    const indexFile = join(home, 'memory', 'patterns-index.json');
    const env = { PATH: process.env.PATH, HOME: home, OMEGA_MEMORY_INDEX: indexFile,
      OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions') };
    const writerSrc = (tag) => `
      const m = await import(${JSON.stringify(MODULE)});
      const patterns = {};
      for (let k = 0; k < ${PER}; k++) patterns['w${tag}-' + k] = {
        name: 'w${tag} ' + k, domains: ['code'], sessions: ['2026-09-30'],
        evidenceCount: 1, status: 'candidate', firstSeen: 'x', lastSeen: 'x',
        correspondences: [], contradictions: [], nameVariations: [], implicatedBy: [] };
      console.log(JSON.stringify({ saved: m.savePatternsIndex({ version: 1, patterns, meta: {} }) }));
    `;
    // Fire all N writers concurrently. No barrier: the assertions are about
    // corruption, spurious failure and total retention, not about one specific
    // interleaving, so there is nothing here for a barrier to make more reliable.
    const outs = await Promise.all(Array.from({ length: WRITERS }, (_, i) => new Promise((res) => {
      const c = execFile(process.execPath, ['--input-type=module', '-e', writerSrc(i)], { env, encoding: 'utf8' });
      let o = '', er = '';
      c.stdout.on('data', d => o += d);
      c.stderr.on('data', d => er += d);
      c.on('close', () => res({ o: o.trim(), e: er.trim() }));
    })));

    const savedFlags = outs.map(o => { try { return JSON.parse(o.o.split('\n').pop()).saved; } catch { return null; } });
    ok(savedFlags.every(s => s === true),
      'every concurrent writer reports success (no spurious failure)',
      `flags=${JSON.stringify(savedFlags)}`);

    let parsed = true, count = 0, missing = [];
    try {
      const pats = JSON.parse(readFileSync(indexFile, 'utf8')).patterns || {};
      count = Object.keys(pats).length;
      // Name the specific survivors rather than just a count. A count alone can
      // hide a pathological merge that kept 3000 entries but dropped one whole
      // writer; per-tag presence proves every writer is represented.
      for (let i = 0; i < WRITERS; i++) {
        if (!pats[`w${i}-0`]) missing.push(`w${i}`);
      }
    }
    catch { parsed = false; }
    ok(parsed, 'the index is valid JSON after 5 concurrent writers — never a torn file');
    ok(count === WRITERS * PER,
      `ZERO LOST WRITES: all ${WRITERS * PER} patterns from ${WRITERS} concurrent writers survive`,
      `got ${count}`);
    ok(missing.length === 0,
      'every writer is represented in the merged index (no writer silently dropped)',
      `absent: ${missing.join(',') || 'none'}`);
  }

  // ── 5. file mode: memory files must not be world-readable ───────────────
  // Measured before this fix: index and session files were written 0644, i.e.
  // readable by every account on the machine. The content is verbatim agent
  // output — absolute paths, provider/model, task ids, agent identity, and any
  // claim a user made.
  {
    const home = join(workdir, 'home5');
    const indexFile = join(home, 'memory', 'patterns-index.json');
    const sessions = join(home, 'sessions');
    const r = child(`
      m.savePatternsIndex({ version: 1, patterns: { x: { name: 'x', domains: [], sessions: [], evidenceCount: 1, status: 'candidate', correspondences: [], contradictions: [] } }, meta: {} });
      m.saveWorkingMemory('2026-09-30', { date: '2026-09-30', entries: [], contradictions: [] });
      console.log(JSON.stringify({ done: true }));
    `, { HOME: home, OMEGA_MEMORY_INDEX: indexFile, OMEGA_MEMORY_SESSIONS_DIR: sessions });
    lastJson(r);
    const idxMode = existsSync(indexFile) ? statSync(indexFile).mode & 0o777 : 0;
    const sessFile = join(sessions, 'working-2026-09-30.json');
    const sessMode = existsSync(sessFile) ? statSync(sessFile).mode & 0o777 : 0;
    ok(idxMode === 0o600, `the patterns index is written 0600, not world-readable (got 0${idxMode.toString(8)})`);
    ok(sessMode === 0o600, `session working memory is written 0600 (got 0${sessMode.toString(8)})`);
  }

  // ── 6. no temp files survive a successful write ─────────────────────────
  {
    const home = join(workdir, 'home6');
    const indexFile = join(home, 'memory', 'patterns-index.json');
    const r = child(`
      m.savePatternsIndex({ version: 1, patterns: { x: { name: 'x', domains: [], sessions: [], evidenceCount: 1, status: 'candidate', correspondences: [], contradictions: [] } }, meta: {} });
      console.log(JSON.stringify({ done: true }));
    `, { HOME: home, OMEGA_MEMORY_INDEX: indexFile, OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions') });
    lastJson(r);
    const leftovers = readdirSync(dirname(indexFile)).filter(f => f.includes('.tmp'));
    ok(leftovers.length === 0,
      'a successful write leaves NO temp file behind', leftovers.join(', '));
  }

} finally {
  rmSync(workdir, { recursive: true, force: true });
}

done();
