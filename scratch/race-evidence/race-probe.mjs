// race-probe.mjs — measure the pre-fix lost-update race N times.
//
// This is the SAME barrier, SAME 8 writers, SAME child body as
// test/test-concurrency-rmw.mjs section 1 — extracted so it can be pointed at
// any revision of src/polymem.mjs and run repeatedly without the other
// assertions (which fail on pre-fix code for unrelated missing-fix reasons).
//
//   node race-probe.mjs <path-to-polymem.mjs> <runs>
//
// Prints one "present N/8" line per run, then the observed range and mode.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE = process.argv[2];
const RUNS = Number(process.argv[3] || 20);
if (!MODULE) { console.error('usage: race-probe.mjs <polymem.mjs> [runs]'); process.exit(2); }

const WRITERS = 8;
const CHILD_TIMEOUT_MS = 30_000;

function runOnce(label) {
  const workdir = mkdtempSync(join(tmpdir(), 'polymem-race-'));
  const home = join(workdir, 'home');
  const indexFile = join(home, 'memory', 'patterns-index.json');
  mkdirSync(join(home, 'memory'), { recursive: true });
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const readyDir = join(home, 'ready');
  mkdirSync(readyDir, { recursive: true });
  const gate = join(home, 'gate');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    OMEGA_MEMORY_INDEX: indexFile,
    OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions'),
  };
  // Propagate instrumentation env vars into the children — without this the
  // claim log is written by nobody and an empty log looks like "no overlap".
  for (const k of ['POLYMEM_CLAIM_LOG', 'NODE_OPTIONS']) {
    if (process.env[k]) env[k] = process.env[k];
  }

  // Identical child to the regression test: load, add MY pattern, save.
  const childSrc = (tag) => `
    import { writeFileSync, existsSync } from 'node:fs';
    const m = await import(${JSON.stringify(MODULE)});
    writeFileSync(${JSON.stringify(join(readyDir, tag))}, 'ready');
    const gate = ${JSON.stringify(gate)};
    const buf = new Int32Array(new SharedArrayBuffer(4));
    let waited = 0;
    while (!existsSync(gate) && waited < 20000) { Atomics.wait(buf, 0, 0, 1); waited++; }
    if (!existsSync(gate)) { console.log(JSON.stringify({ tag: ${JSON.stringify(tag)}, error: 'gate never opened' })); process.exitCode = 1; }
    const index = m.loadPatternsIndex();
    index.patterns['rmw-${tag}'] = {
      name: 'rmw ${tag}', domains: ['code'], sessions: ['2026-09-30'],
      evidenceCount: 1, status: 'candidate', firstSeen: 'x', lastSeen: 'x',
      correspondences: [], contradictions: [], nameVariations: [], implicatedBy: [],
    };
    const saved = m.savePatternsIndex(index);
    console.log(JSON.stringify({ tag: ${JSON.stringify(tag)}, saved }));
  `;

  return new Promise((resolvePromise) => {
    const children = [];
    let settled = false;
    const results = [];
    const finish = (timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
      // Read the index HERE, before the workdir is removed. Reading it after
      // rmSync is what produced a bogus "0/8, unparseable" x25 on the first
      // attempt at this probe — the measurement, not the code, was broken.
      let pats = null;
      let parseError = null;
      try {
        pats = JSON.parse(readFileSync(indexFile, 'utf8')).patterns || {};
      } catch (e) { parseError = e.code || e.message; }
      if (!timedOut) { try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ } }
      resolvePromise({ results, timedOut, pats, parseError, indexFile, workdir });
    };
    const overall = setTimeout(() => finish(true), CHILD_TIMEOUT_MS);

    for (let i = 0; i < WRITERS; i++) {
      const tag = `w${i}`;
      const c = execFile(process.execPath, ['--input-type=module', '-e', childSrc(tag)], { env, encoding: 'utf8' });
      children.push(c);
      let o = '';
      c.stdout.on('data', d => o += d);
      c.on('close', () => {
        let parsed = null;
        try { parsed = JSON.parse(o.trim().split('\n').pop()); } catch { /* null below */ }
        results.push({ tag, saved: parsed ? parsed.saved : null });
        if (results.length === WRITERS) finish(false);
      });
    }

    const readyPath = (tag) => join(readyDir, tag);
    const spinUntilAllReady = () => {
      const buf = new Int32Array(new SharedArrayBuffer(4));
      let waited = 0;
      const allReady = () => Array.from({ length: WRITERS }, (_, i) => existsSync(readyPath(`w${i}`))).every(Boolean);
      while (!allReady() && waited < 20000) { Atomics.wait(buf, 0, 0, 1); waited++; }
      if (allReady()) writeFileSync(gate, 'go');
      return allReady();
    };
    setImmediate(() => { spinUntilAllReady(); });
  });
}

const counts = [];
let allReportedSaved = true;
let anyTimedOut = false;
let neverValidJson = 0;
const anomalies = [];

for (let run = 1; run <= RUNS; run++) {
  // Stamp a run marker into the shared log so every claim event can be
  // attributed to the run that produced it. Without this, correlating a
  // RETRY-VERIFY with the run that lost a write is guesswork.
  if (process.env.POLYMEM_CLAIM_LOG) {
    try { appendFileSync(process.env.POLYMEM_CLAIM_LOG, JSON.stringify({ ev: 'RUN-MARKER', run }) + '\n'); } catch { /* best effort */ }
  }
  const { results, timedOut, pats, parseError, indexFile, workdir } = await runOnce(run);
  if (timedOut) { anyTimedOut = true; console.log(`run ${run}: TIMED OUT`); try { rmSync(workdir, { recursive: true, force: true }); } catch {} continue; }

  const savedFlags = results.map(r => r.saved);
  if (!(savedFlags.length === WRITERS && savedFlags.every(f => f === true))) allReportedSaved = false;

  if (parseError) { neverValidJson++; console.log(`run ${run}: index unreadable (${parseError})`); continue; }
  const keys = Object.keys(pats);
  const presentKeys = keys.filter(k => k.startsWith('rmw-'));
  const present = presentKeys.length;
  const missing = Array.from({ length: WRITERS }, (_, i) => `rmw-w${i}`).filter(id => !pats[id]);
  counts.push(present);
  const line = `run ${run}: present ${present}/${WRITERS}  lost ${WRITERS - present}  allSaved=${savedFlags.every(f => f === true)}`;
  console.log(missing.length ? `${line}  MISSING=${missing.join(',')}` : line);
  if (missing.length) {
    // Capture the full evidence for an anomalous run: every child's result and
    // stderr, plus any non-rmw keys, so the cause can be identified rather
    // than guessed at.
    anomalies.push({
      run, present, missing, savedFlags,
      results: results.map(r => ({ tag: r.tag, saved: r.saved, error: r.error, stderr: r.stderr })),
      strayKeys: keys.filter(k => !k.startsWith('rmw-')),
    });
  }
}

console.log('');
console.log(`runs: ${counts.length}`);
if (counts.length) {
  const min = Math.min(...counts), max = Math.max(...counts);
  const tally = {};
  for (const c of counts) tally[c] = (tally[c] || 0) + 1;
  const mode = Object.entries(tally).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0];
  console.log(`OBSERVED RANGE: ${min}-${max} of ${WRITERS}`);
  console.log(`MODE: ${mode[0]}/${WRITERS} (${mode[1]} of ${counts.length} runs)`);
  console.log(`DISTRIBUTION: ${Object.keys(tally).sort((a, b) => a - b).map(k => `${k}x${tally[k]}`).join('  ')}`);
}
console.log(`every writer reported saved:true in every run: ${allReportedSaved}`);
console.log(`runs whose index failed to parse: ${neverValidJson}`);
console.log(`timed-out runs: ${anyTimedOut}`);
if (anomalies.length) {
  console.log('');
  console.log(`### ${anomalies.length} ANOMALOUS RUN(S) — full evidence`);
  for (const a of anomalies) console.log(JSON.stringify(a, null, 2));
}
