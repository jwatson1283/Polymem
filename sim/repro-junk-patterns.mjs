// Repro for the `junk-sections` BLOCKER found by sim/run.mjs.
//
// Minimal, standalone, and committed next to the finding so it can be re-run and
// re-checked independently of the simulation:
//
//     node repro-junk-patterns.mjs
//
// It uses ONLY the documented public API, in the order the README prescribes:
// parse → assessClaim → appendWorkingMemory → promoteSession. The junk reaches
// the gate through appendWorkingMemory exactly as a malformed model reply would.
//
// Expected: a TypeError from promoteSession.
// If this script prints "no throw", the finding is stale and the gate has been
// hardened — delete the finding from the sim report.

import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'polymem-repro-'));
const HOME = join(ROOT, 'home');
mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.OMEGA_MEMORY_INDEX = join(ROOT, 'patterns-index.json');
process.env.OMEGA_MEMORY_SESSIONS_DIR = join(ROOT, 'sessions');
mkdirSync(process.env.OMEGA_MEMORY_SESSIONS_DIR, { recursive: true });

const polymem = await import(fileURLToPath(new URL('../src/index.mjs', import.meta.url)));

const DATE = '2026-10-20';

// A session whose patterns array holds a null. `parseMemoryBlock` can never
// produce this — it guards with `if (!item || item.length > 300) continue;`
// (polymem.mjs:1164). So this is only reachable by a caller that assembles
// working memory programmatically, or by a caller whose stored JSON predates a
// schema change. Both are legitimate: appendWorkingMemory is a public export,
// and a corrupt-but-parseable session file should not crash promotion.
//
// WHY THIS IS A REAL DEFECT RATHER THAN HARNESS ABUSE. appendWorkingMemory
// validates `claims` and ignores `patterns`:
//
//   for (const c of entry.claims || []) { const verdict = assessClaim(c, seen); ... }
//   const gatedEntry = { ...entry, claims };          // <- patterns spread through
//
// so patterns go to disk unvalidated by design, and promoteSession then assumes
// every element is an object (polymem.mjs:1868). The two public functions make
// opposite assumptions about the same field, and the unvalidated one comes
// first. A single null from a model, a merge, or an older session file turns
// every subsequent promotion for that session into a TypeError.
//
// Blast radius, checked rather than guessed: there is no `promotionInFlight`
// marker anywhere in polymem.mjs, so the throw does not leave the session
// wedged — a caller that catches the TypeError and retries simply re-runs
// promoteSession. The real cost is that every pattern after the null in the
// array is skipped for that session, and the caller gets an exception rather
// than a partial result, so the safe move is to drop the whole session.
const junk = {
  time: new Date().toISOString(),
  agent: 'degenerate',
  claims: [{ text: 'a real claim about the index write path', domains: ['code'] }],
  patterns: [null, 'a bare string', { text: 'a real pattern about atomic rename', domains: ['code'] }],
  correspondences: [],
  contradictions: [],
};

polymem.appendWorkingMemory(DATE, junk);

let threw = null;
try {
  const idx = polymem.loadPatternsIndex();
  polymem.promoteSession(DATE, idx);
} catch (e) {
  threw = e;
}

if (threw) {
  console.error('REPRO CONFIRMED — promoteSession threw on a null entry in patterns:');
  console.error(`  ${threw.name}: ${threw.message}`);
  const frame = String(threw.stack).split('\n').find(l => l.includes('polymem.mjs'));
  if (frame) console.error(`  at ${frame.trim()}`);
  console.error('');
  console.error('The claim gate iterates e.patterns with no null guard:');
  console.error('    for (const p of e.patterns || []) {');
  console.error('      const verdict = assessPatternName(p.text);   // <- p.text on null');
  console.error('Fix: skip non-object entries the same way the parse path does, and');
  console.error('record them in index.meta.quarantine so the discard stays auditable.');
  process.exit(1);
} else {
  console.log('no throw — the gate tolerates a null pattern entry. Finding is stale.');
  process.exit(0);
}