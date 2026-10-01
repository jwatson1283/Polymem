// test-memory-index-location.mjs
//
// THE CONTROL FOR "the live patterns index must never be a tracked file".
//
// WHY THIS EXISTS AS A SEPARATE SUITE. test-memory.mjs sets OMEGA_MEMORY_INDEX to
// a temp dir on line 7, which is correct for what it tests and means it can never
// observe the DEFAULT. So the default was untested for the entire life of the
// hazard — and the hazard shipped once already:
//
//   Removing the compose bind mount fixed how the CONTAINER reached the index.
//   The default in memory.mjs still pointed into the worktree, so a host-side
//   load/save with the variable unset still wrote the tracked file. Reproduced:
//     git checkout -- backend/memory/patterns-index.json
//     node -e "loadPatternsIndex(); savePatternsIndex(idx)"
//     git status --short     →  M backend/memory/patterns-index.json
//
// One fix, one door. This suite is the assertion on the OTHER doors.
//
// IT MUST BE A CHILD PROCESS. INDEX_FILE is resolved once at module load, so a
// test that imports memory.mjs into its own process cannot vary it — and worse,
// the suite would inherit whatever the parent happened to export. Spawning with
// a scrubbed env is the only way to actually test the default.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRACKED = join(REPO, 'src', 'polymem.mjs');

import { createSuite } from './harness.mjs';

const { ok, done } = createSuite('test-memory-index-location.mjs');

// Run load+save in a fresh process with a controlled env and HOME.
const childSave = (home) => {
  const script = `
    const m = await import(${JSON.stringify(join(REPO, 'src', 'polymem.mjs'))});
    const idx = m.loadPatternsIndex();
    idx.meta.decompositionStats['probe:default-location'] = { blocks: 7, withMemory: 0 };
    m.savePatternsIndex(idx);
    process.stdout.write('OK');
  `;
  // A scrubbed env: no OMEGA_MEMORY_INDEX, and HOME pointed at a throwaway dir
  // so the real deployment's ledger is never touched by this suite.
  const env = { PATH: process.env.PATH, HOME: home };
  return execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { cwd: REPO, env, encoding: 'utf8' });
};

console.log('patterns index location:');

// ── 1. the load-bearing assertion ──────────────────────────────────────────
// The tracked file must be byte-identical after a default-path save. This is
// the whole invariant: no code path, container or host, writes into the tree.
const home = mkdtempSync(join(tmpdir(), 'omega-idxloc-'));
const trackedBefore = readFileSync(TRACKED, 'utf8');
let childErr = null;
try {
  childSave(home);
} catch (e) {
  childErr = e;
}
ok(!childErr, 'a default-path load+save runs at all',
  childErr ? String(childErr.stderr || childErr.message).split('\n')[0] : '');
ok(readFileSync(TRACKED, 'utf8') === trackedBefore,
  'THE TRACKED FILE IS UNCHANGED by a default-path save — no path writes into the worktree',
  readFileSync(TRACKED, 'utf8') === trackedBefore ? '' : 'the tracked index moved');

// ── 2. where the write actually landed ─────────────────────────────────────
// Asserting "the tracked file didn't move" alone would also pass if the save
// silently went nowhere. So check the data arrived in $HOME.
const homeIndex = join(home, '.computer-agent', 'memory', 'patterns-index.json');
ok(existsSync(homeIndex), 'the default write landed under $HOME/.computer-agent/memory',
  `expected ${homeIndex}`);
if (existsSync(homeIndex)) {
  const saved = JSON.parse(readFileSync(homeIndex, 'utf8'));
  ok(saved?.meta?.decompositionStats?.['probe:default-location']?.blocks === 7,
    'the saved data is really there — the previous assertion is not passing vacuously');
}

// ── 3. an explicit OMEGA_MEMORY_INDEX still wins ───────────────────────────
// The env var is the operator's override and must keep working; this suite must
// not pass by breaking the documented seam.
const explicit = join(home, 'explicit-index.json');
const script = `
  const m = await import(${JSON.stringify(join(REPO, 'src', 'polymem.mjs'))});
  const idx = m.loadPatternsIndex();
  idx.meta.decompositionStats['probe:explicit'] = { blocks: 3, withMemory: 1 };
  m.savePatternsIndex(idx);
  `;
execFileSync(process.execPath, ['--input-type=module', '-e', script],
  { cwd: REPO, env: { PATH: process.env.PATH, HOME: home, OMEGA_MEMORY_INDEX: explicit }, encoding: 'utf8' });
ok(existsSync(explicit), 'an explicit OMEGA_MEMORY_INDEX still overrides the default');
ok(readFileSync(TRACKED, 'utf8') === trackedBefore,
  'and the explicit override does not touch the tracked file either');

// ── 4. a fresh HOME degrades to an empty index, it does not throw ──────────
// The new default points into a directory that may not exist yet. If a cold
// start could not create it, the first run on any new machine would fail — and
// the container recreates $HOME contents on every deploy.
const cold = mkdtempSync(join(tmpdir(), 'omega-idxcold-'));
let coldErr = null;
try { childSave(cold); } catch (e) { coldErr = e; }
ok(!coldErr, 'a cold $HOME with no memory dir still works (creates it)',
  coldErr ? String(coldErr.stderr || coldErr.message).split('\n')[0] : '');
ok(readFileSync(TRACKED, 'utf8') === trackedBefore,
  'and the cold-start path still leaves the tracked file alone');

rmSync(home, { recursive: true, force: true });
rmSync(cold, { recursive: true, force: true });

done();
