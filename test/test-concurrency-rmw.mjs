// test/test-concurrency-rmw.mjs
//
// REGRESSION TEST FOR THE LOST UPDATE ON THE PATTERNS INDEX.
//
// THE BUG. writeFileAtomic made ONE write atomic. It said nothing about the
// read-modify-write cycle around it, and the cycle is where data died. Each
// process loaded the index, added its own pattern, and saved the whole snapshot
// back. Every writer therefore published a complete index that did not contain
// the other writers' patterns, and every writer reported success.
//
// MEASURED ON THE PRE-FIX CODE — 8 processes, 8 distinct patterns, released
// together off a real barrier:
//   between 1 and 7 of 8 present (most often 3 of 8), file was valid JSON,
//   all 8 reported saved:true in every run
//
// The count is a RACE outcome, so it is a range over 120 runs rather than a
// figure. An earlier version asserted a single number (5 of 8) that did not
// reproduce.
// Not corruption. SILENT LOSS with a success code attached.
//
// WHY PURE OPTIMISTIC CONCURRENCY IS NOT THE FIX (the brief's preferred shape).
// It was implemented faithfully — read, sha256, re-read, verify unchanged, atomic
// rename, retry — and it FAILED across three 8-writer runs:
//
//   present 2 of 8 (LOST 6) / present 3 of 8 (LOST 5) / present 1 of 8 (LOST 7)
//
// all eight reporting saved:true. The cause is that the check is not atomic
// with the commit it protects:
//
//   A: verify disk == what I read   ✓ passes
//   B:                                  rename B's snapshot      ← A now stale
//   A:                                  rename A's snapshot      ← B's work GONE
//
// POSIX rename() is UNCONDITIONAL. There is no "rename only if the destination
// still has the bytes I read", and Node exposes no portable way to spell one
// (linkat2/RENAME_NOREPLACE is Linux-only; macOS renamex_np is not in Node).
// Optimistic concurrency narrows the window from the whole read-modify-write to
// a stat plus a read — which is why it sometimes looks like it works — and that
// is a probability improvement, not a guarantee.
//
// WHAT THIS TEST ASSERTS. Zero lost writes under a barrier that maximises the
// overlap, and that the fix's own primitives behave. The barrier is the point:
// without it, N writers released together may never actually collide, and a
// concurrency test that does not reliably collide is a test that passes on a
// broken build.
//
// THE BARRIER IS REAL AND IT HANGS LOUDLY. Each child writes a readiness file,
// then blocks on Atomics.wait until the gate file appears. Two failure modes
// were hit and fixed while writing this, and both are the reason for the
// structure below:
//   - a child that closed its streams before the gate was written deadlocked;
//   - writing the gate AFTER an await let every child spin past it, and the run
//     had to be killed (exit 124).
// So: readiness first, THEN the gate, and the gate write is synchronous and
// happens while every child is provably parked. A per-child watchdog plus an
// overall timer means a regression surfaces as a FAILED ASSERTION naming the
// stuck child, never as a hung CI job.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = join(REPO, 'src', 'polymem.mjs');

import { createSuite } from './harness.mjs';

const { ok, done } = createSuite('test-concurrency-rmw.mjs');

const workdir = mkdtempSync(join(tmpdir(), 'polymem-rmw-'));

// Generous enough that a loaded M4 does not produce a false failure, tight
// enough that a deadlock is reported as a failure rather than hanging a job.
const CHILD_TIMEOUT_MS = 30_000;

// Spawn N children that all load, add one distinct pattern, and save — released
// together. Returns {results, timedOut}.
function runBarrieredWriters({ writers, workName }) {
  const home = join(workdir, workName);
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

  // The child: load, add MY pattern, save. The park is a synchronous
  // Atomics.wait so it cannot be lost to an event-loop turn.
  const childSrc = (tag) => `
    import { writeFileSync, existsSync } from 'node:fs';
    const m = await import(${JSON.stringify(MODULE)});
    writeFileSync(${JSON.stringify(join(readyDir, tag))}, 'ready');
    // Spin on a synchronous sleep until the parent publishes the gate. NOT an
    // await on a promise: this must not yield, or the ordering below breaks.
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
      for (const c of children) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
      resolvePromise({ results, timedOut });
    };
    const overall = setTimeout(() => finish(true), CHILD_TIMEOUT_MS);

    for (let i = 0; i < writers; i++) {
      const tag = `w${i}`;
      const c = execFile(process.execPath, ['--input-type=module', '-e', childSrc(tag)], { env, encoding: 'utf8' });
      children.push(c);
      let o = '', e = '';
      c.stdout.on('data', d => o += d);
      c.stderr.on('data', d => e += d);
      c.on('close', () => {
        let parsed = null;
        try { parsed = JSON.parse(o.trim().split('\n').pop()); } catch { /* reported as null below */ }
        results.push({ tag, saved: parsed ? parsed.saved : null, error: parsed ? parsed.error : null, stderr: e.trim() });
        if (results.length === writers) finish(false);
      });
    }

    // Publish the gate only after EVERY child has parked on it. Polled
    // synchronously on purpose — an await here is what deadlocked version 2.
    const readyPath = (tag) => join(readyDir, tag);
    const spinUntilAllReady = () => {
      const buf = new Int32Array(new SharedArrayBuffer(4));
      let waited = 0;
      const allReady = () => Array.from({ length: writers }, (_, i) => existsSync(readyPath(`w${i}`))).every(Boolean);
      while (!allReady() && waited < 20000) { Atomics.wait(buf, 0, 0, 1); waited++; }
      if (allReady()) writeFileSync(gate, 'go');
      return allReady();
    };
    // setImmediate keeps this off the parent's own stack so the children's
    // 'close' handlers above can fire, without ever yielding the gate itself.
    setImmediate(() => { spinUntilAllReady(); });
  });
}

const readIndex = (indexFile) => JSON.parse(readFileSync(indexFile, 'utf8'));

// Tolerant reader: the index legitimately does not exist yet when a writer is
// correctly refused, and "absent" is the pass condition for those assertions.
const readIndexSafe = (indexFile) => {
  try { return readIndex(indexFile); } catch { return null; }
};

// ── 1. zero lost writes under a real barrier ───────────────────────────────
// The headline regression. 8 processes, 8 distinct patterns, all released
// together: every one of the 8 must be present afterwards.
{
  const WRITERS = 8;
  const home = join(workdir, 'rmw-main');
  const indexFile = join(home, 'memory', 'patterns-index.json');
  const { results, timedOut } = await runBarrieredWriters({ writers: WRITERS, workName: 'rmw-main' });

  ok(!timedOut,
    `all ${WRITERS} barriered writers finished without deadlocking`,
    'a child never exited — the gate/claim loop is wedged');

  const flags = results.map(r => r.saved);
  ok(flags.length === WRITERS && flags.every(f => f === true),
    'every concurrent writer reports saved:true',
    `flags=${JSON.stringify(flags)} errors=${JSON.stringify(results.map(r => r.error))}`);

  let pats = {};
  let parsedOk = true;
  try { pats = readIndex(indexFile).patterns || {}; } catch { parsedOk = false; }
  ok(parsedOk, 'the index is valid JSON after concurrent writers — never a torn file');

  const present = Object.keys(pats).filter(k => k.startsWith('rmw-'));
  const missing = Array.from({ length: WRITERS }, (_, i) => `rmw-w${i}`).filter(id => !pats[id]);
  ok(present.length === WRITERS,
    `ZERO LOST WRITES: all ${WRITERS} concurrently-added patterns survive`,
    `present ${present.length}/${WRITERS}; missing ${missing.join(',') || 'none'}`);
  ok(missing.length === 0,
    'no writer is silently dropped — every process is represented by name',
    `missing ${missing.join(',')}`);
}

// ── 2. the claim is exclusive, and portable (not flock) ─────────────────────
// Direct proof of the mutual-exclusion primitive: exactly one of N racers wins
// the O_CREAT|O_EXCL open. If this ever passes for two racers, the whole design
// is a no-op and every other assertion here is meaningless.
{
  const probe = mkdtempSync(join(tmpdir(), 'polymem-claim-'));
  const claimPath = join(probe, 'idx.claim');
  const racer = (tag) => `
    import { openSync, closeSync, writeFileSync } from 'node:fs';
    let won = false;
    try {
      const fd = openSync(${JSON.stringify(claimPath)}, 'wx', 0o600);
      try { writeFileSync(fd, ${JSON.stringify(tag)}); } finally { closeSync(fd); }
      won = true;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    console.log(JSON.stringify({ tag: ${JSON.stringify(tag)}, won }));
  `;
  const N = 16;
  const outs = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res) => {
    const c = execFile(process.execPath, ['--input-type=module', '-e', racer(`r${i}`)], { encoding: 'utf8' });
    let o = '';
    c.stdout.on('data', d => o += d);
    c.on('close', () => { try { res(JSON.parse(o.trim().split('\n').pop())); } catch { res({ won: null }); } });
  })));
  const winners = outs.filter(o => o.won === true);
  ok(winners.length === 1,
    'O_CREAT|O_EXCL claim is mutually exclusive — exactly 1 of 16 racers wins',
    `winners=${winners.length} (${winners.map(w => w.tag).join(',') || 'none'})`);
  rmSync(probe, { recursive: true, force: true });
}

// ── 3. the claim is released, not leaked ────────────────────────────────────
// A claim that outlives its critical section wedges the index permanently. This
// asserts the file is GONE after a successful save, which is the difference
// between a self-healing claim and a lockfile that needs manual recovery.
{
  const home = join(workdir, 'rmw-release');
  const indexFile = join(home, 'memory', 'patterns-index.json');
  mkdirSync(join(home, 'memory'), { recursive: true });
  const src = `
    const m = await import(${JSON.stringify(MODULE)});
    const index = m.loadPatternsIndex();
    index.patterns['leak-check'] = { name: 'leak', domains: [], sessions: [], evidenceCount: 1,
      status: 'candidate', correspondences: [], contradictions: [] };
    console.log(JSON.stringify({ saved: m.savePatternsIndex(index) }));
  `;
  const out = await new Promise((res) => {
    execFile(process.execPath, ['--input-type=module', '-e', src],
      { env: { PATH: process.env.PATH, HOME: home, OMEGA_MEMORY_INDEX: indexFile, OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions') }, encoding: 'utf8' },
      (e, stdout) => res(stdout));
  });
  const saved = JSON.parse(out.trim().split('\n').pop()).saved;
  ok(saved === true, 'a save completes');
  ok(!existsSync(`${indexFile}.claim`),
    'the claim is RELEASED after the write — no orphaned .claim left to wedge the index',
    'a surviving .claim file means the critical section leaked');
  ok(readIndex(indexFile).patterns['leak-check'] !== undefined, 'the payload actually landed');
}

// ── 4. a claim left by a DEAD process is broken, not obeyed ────────────────
// This is what separates the claim from the lockfile pattern. A crash inside the
// critical section must not require manual recovery, so a claim whose owner is
// provably gone (same host, dead pid, older than the stale threshold) is broken
// automatically. Verified with a claim naming a pid that cannot exist.
{
  const home = join(workdir, 'rmw-stale');
  const indexFile = join(home, 'memory', 'patterns-index.json');
  mkdirSync(join(home, 'memory'), { recursive: true });
  // A pid that is not running, an old mtime, and our own hostname so the
  // liveness check is allowed to reach a verdict at all.
  writeFileSync(`${indexFile}.claim`, JSON.stringify({ pid: 0x7ffffffe, host: (await import('node:os')).hostname(), at: 0 }));
  const { utimesSync } = await import('node:fs');
  const old = new Date(Date.now() - 120_000);
  utimesSync(`${indexFile}.claim`, old, old);
  const src = `
    const m = await import(${JSON.stringify(MODULE)});
    const index = m.loadPatternsIndex();
    index.patterns['after-crash'] = { name: 'after crash', domains: [], sessions: [], evidenceCount: 1,
      status: 'candidate', correspondences: [], contradictions: [] };
    console.log(JSON.stringify({ saved: m.savePatternsIndex(index) }));
  `;
  const out = await new Promise((res) => {
    execFile(process.execPath, ['--input-type=module', '-e', src],
      { env: { PATH: process.env.PATH, HOME: home, OMEGA_MEMORY_INDEX: indexFile, OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions') }, encoding: 'utf8' },
      (e, stdout) => res(stdout));
  });
  const saved = JSON.parse(out.trim().split('\n').pop()).saved;
  ok(saved === true,
    'a claim abandoned by a DEAD process is broken automatically — a crash needs no manual recovery',
    'the save should have reclaimed the stale claim');
  ok(readIndex(indexFile).patterns['after-crash'] !== undefined, 'the write after the crash landed');
}

// ── 5. a LIVE holder's claim is respected, never stolen ─────────────────────
// The mirror image of 4, and the more important of the two. Breaking an
// abandoned claim is recovery; breaking a claim held by a running process is a
// DOUBLE WRITER — the exact bug this whole change exists to fix. So a claim
// naming this very (live) pid must NOT be broken, and the writer must give up
// with an actionable ContentionError instead of writing anyway.
{
  const home = join(workdir, 'rmw-live');
  const indexFile = join(home, 'memory', 'patterns-index.json');
  mkdirSync(join(home, 'memory'), { recursive: true });
  const src = `
    const m = await import(${JSON.stringify(MODULE)});
    const index = m.loadPatternsIndex();
    index.patterns['must-not-be-written'] = { name: 'x', domains: [], sessions: [], evidenceCount: 1,
      status: 'candidate', correspondences: [], contradictions: [] };
    console.log(JSON.stringify({ saved: m.savePatternsIndex(index) }));
  `;
  // The claim is planted by THIS test process, which is alive, and is given a
  // generous mtime so only the liveness check can reject breaking it.
  writeFileSync(`${indexFile}.claim`, JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), at: Date.now() }));
  const out = await new Promise((res) => {
    execFile(process.execPath, ['--input-type=module', '-e', src],
      { env: { PATH: process.env.PATH, HOME: home, OMEGA_MEMORY_INDEX: indexFile, OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions') }, encoding: 'utf8' },
      (e, stdout, stderr) => res({ stdout, stderr }));
  });
  const line = out.stdout.trim().split('\n').pop();
  let saved = null;
  try { saved = JSON.parse(line).saved; } catch { /* contention path prints the error */ }
  ok(saved === false,
    'a claim held by a LIVE process is respected — the writer refuses rather than double-writing',
    `saved=${saved} stdout=${line} stderr=${out.stderr.trim()}`);
  ok(/contention/i.test(out.stderr),
    'the refusal is reported as contention, with a reason, instead of a silent no-op',
    `stderr=${out.stderr.trim()}`);
  // The blocked write must not have landed. The index file is absent rather than
  // empty here, because a correctly-refused writer creates nothing at all — so
  // assert the absence of our pattern, not the absence of the file.
  ok(!existsSync(indexFile) || readIndex(indexFile).patterns['must-not-be-written'] === undefined,
    'the blocked write did NOT land — the live holder is genuinely still exclusive');
  rmSync(`${indexFile}.claim`, { force: true });
}

// ── 6. the merge still SEALS: encryption and concurrency compose ────────────
// This is the one thing neither feature's own tests can catch, and it is the
// regression that a naive merge of the two cards would have shipped.
//
// savePatternsIndex no longer hands `index` to writeStoreAtomic. It composes a
// MERGED value inside the write claim and encodes that. So the code that
// publishes the index is new code — and a new code path that assembles its own
// payload is exactly where a writer forgets to seal. The failure is silent and
// severe: the operator sets OMEGA_MEMORY_PASSPHRASE, sees the feature report
// itself on, and the memory index sits on disk in plaintext, because a
// plaintext index is a perfectly valid index.
//
// The encryption suite exercises savePatternsIndex and passes either way, so it
// cannot detect this. Only an assertion that reads the RAW BYTES of a merged,
// concurrent write can.
{
  const home = join(workdir, 'rmw-encrypted');
  const indexFile = join(home, 'memory', 'patterns-index.json');
  mkdirSync(join(home, 'memory'), { recursive: true });
  const passphrase = 'rmw-probe-passphrase';
  const secret = 'rmw-secret-pattern';

  // Two real processes, both with encryption on, both merging against disk.
  const results = await Promise.all([0, 1].map((n) => new Promise((res) => {
    const src = `
      const m = await import(${JSON.stringify(MODULE)});
      const index = m.loadPatternsIndex();
      index.patterns[${JSON.stringify(secret + '-' + n)}] = {
        name: ${JSON.stringify(secret + '-' + n)}, domains: ['ops'], sessions: ['sess-' + ${n}],
        evidenceCount: 1, status: 'candidate', correspondences: [], contradictions: [] };
      console.log(JSON.stringify({ saved: m.savePatternsIndex(index) }));
    `;
    execFile(process.execPath, ['--input-type=module', '-e', src], {
      env: { PATH: process.env.PATH, HOME: home, OMEGA_MEMORY_INDEX: indexFile,
             OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions'),
             OMEGA_MEMORY_PASSPHRASE: passphrase },
      encoding: 'utf8',
    }, (e, stdout, stderr) => res({ stdout, stderr }));
  })));

  const raw = readFileSync(indexFile, 'utf8');

  ok(results.every((r) => { try { return JSON.parse(r.stdout.trim().split('\n').pop()).saved === true; }
                            catch { return false; } }),
    'both encrypted writers reported success',
    results.map((r) => r.stdout.trim() + ' | ' + r.stderr.trim()).join(' ;; '));

  ok(!raw.includes(secret),
    'a MERGED concurrent write is SEALED — no pattern name appears in the raw bytes',
    `raw head=${JSON.stringify(raw.slice(0, 80))}`);

  ok(!raw.includes('promotions') && !raw.includes('patterns') && !raw.includes('sess-'),
    'no JSON key names and no session names leak into the sealed index',
    `raw head=${JSON.stringify(raw.slice(0, 80))}`);

  ok(!raw.includes(passphrase),
    'the passphrase never appears on disk',
    `raw head=${JSON.stringify(raw.slice(0, 80))}`);

  // Sealed or not, BOTH writers' patterns must survive. Proving the merge holds
  // under encryption is the point: a decode failure inside the claim would make
  // the second writer fall back to its own snapshot and lose the first's work.
  const opened = await new Promise((res) => {
    const src = `
      const m = await import(${JSON.stringify(MODULE)});
      const b = m.loadPatternsIndex();
      console.log(JSON.stringify({ ids: Object.keys(b.patterns).sort() }));
    `;
    execFile(process.execPath, ['--input-type=module', '-e', src], {
      env: { PATH: process.env.PATH, HOME: home, OMEGA_MEMORY_INDEX: indexFile,
             OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions'),
             OMEGA_MEMORY_PASSPHRASE: passphrase },
      encoding: 'utf8',
    }, (e, stdout) => res(stdout));
  });
  let ids = [];
  try { ids = JSON.parse(opened.trim().split('\n').pop()).ids; } catch { /* reported below */ }
  ok(ids.includes(secret + '-0') && ids.includes(secret + '-1'),
    'zero lost writes ACROSS the seal boundary — both encrypted writers kept their pattern',
    `ids=${JSON.stringify(ids)}`);

  ok(!existsSync(`${indexFile}.claim`) && !readdirSync(join(home, 'memory')).some((f) => f.endsWith('.tmp')),
    'the encrypted concurrent write leaves no claim and no temp file behind',
    readdirSync(join(home, 'memory')).join(', '));
}

// ── 7. the stale-claim BREAKER must not delete a claim it cannot prove dead ─
//
// A different lost-update bug from the one above, and one the barrier test
// structurally CANNOT catch: it fires in roughly 1 run in 15, so a suite that
// passes 14 times out of 15 is not pinning its own claim. So this asserts the
// DECISION, which is checkable on every single run.
//
// THE BUG. acquireClaim's EEXIST path was:
//
//   if (isClaimStale(claim)) { try { unlinkSync(claim); } catch {} continue; }
//
// isClaimStale returned true when the claim body would not parse, on the theory
// that an unreadable claim is a writer caught mid-write. But a claim that cannot
// be parsed is not evidence of an ABANDONED claim — it is evidence that we
// cannot identify the owner. The unlink that judgement authorised then deleted
// WHATEVER claim was at the path by the time it ran, which is frequently a
// different, LIVE holder. Two writers inside the "exclusive" section at once is
// the original lost update, reintroduced inside the fix for it.
//
// MEASURED, 8 barriered writers, one probe throughout:
//   pre-fix : 8 of 8 in 37 of 40 runs — 3 runs silently lost 1-2 writes
//   fixed   : 8 of 8 in 80 of 80 runs
// Every lost run had all 8 writers reporting saved:true.
//
// THE DISCRIMINATING FACT. An unparseable claim must NOT be breakable. Genuine
// pre-fix source breaks it and writes immediately; the fixed source refuses and
// reports contention. Same input, opposite outcomes — so this assertion fails
// on the old code instead of decorating it.
{
  const home = join(workdir, 'rmw-breaker');
  const indexFile = join(home, 'memory', 'patterns-index.json');
  mkdirSync(join(home, 'memory'), { recursive: true });
  const claimPath = `${indexFile}.claim`;

  // A claim whose body cannot be parsed, with an old mtime so that age alone
  // would authorise breaking it. This is the exact shape the old code mistook
  // for "abandoned".
  writeFileSync(claimPath, '{ this is not json');
  const { utimesSync } = await import('node:fs');
  const old = new Date(Date.now() - 120_000);
  utimesSync(claimPath, old, old);

  const src = `
    const m = await import(${JSON.stringify(MODULE)});
    const index = m.loadPatternsIndex();
    index.patterns['breaker-probe'] = { name: 'breaker probe', domains: [], sessions: [], evidenceCount: 1,
      status: 'candidate', correspondences: [], contradictions: [] };
    console.log(JSON.stringify({ saved: m.savePatternsIndex(index) }));
  `;
  const out = await new Promise((res) => {
    execFile(process.execPath, ['--input-type=module', '-e', src], {
      env: { PATH: process.env.PATH, HOME: home, OMEGA_MEMORY_INDEX: indexFile,
             OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions') },
      encoding: 'utf8',
    }, (e, stdout, stderr) => res({ stdout, stderr }));
  });

  const claimSurvived = existsSync(claimPath);
  let patternLanded = false;
  try { patternLanded = !!readIndexSafe(indexFile)?.patterns?.['breaker-probe']; } catch { /* absent */ }

  ok(claimSurvived,
    'the breaker REFUSES to delete a claim whose owner it cannot identify — unreadable is not abandoned',
    'the claim was deleted by a writer that never proved it abandoned; this is the unlink that put two writers inside the section at once');

  ok(!patternLanded,
    'and the refused write does not land by way of that deletion',
    `claimSurvived=${claimSurvived} patternLanded=${patternLanded}`);

  // The refusal must be honest about itself: contention, with a reason, and no
  // half-written store left behind for the next writer to trip over.
  ok(/contention/i.test(out.stderr) && !existsSync(`${indexFile}.claim.lock`),
    'the refusal is reported as contention with a reason, and leaves no lock behind',
    out.stderr.slice(0, 160));

  rmSync(claimPath, { force: true });
}

rmSync(workdir, { recursive: true, force: true });
done();
