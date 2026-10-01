// tools/real-corpus-probe.mjs
//
// THE BEFORE/AFTER MEASUREMENT. Run this against the realistic corpus and it
// prints, verbatim, what the library actually promotes and what a user would
// actually get back from a query.
//
// This exists as a committed tool rather than a one-off paste because the
// card's central claim — "the design captured noise instead of knowledge" — is
// only worth believing if it can be re-derived by someone else on a different
// day. A report you cannot re-run is an anecdote.
//
//   node tools/real-corpus-probe.mjs
//
// Not shipped: package.json's "files" allowlist is src/ + README + LICENSE +
// CHANGELOG, so this stays out of the npm tarball.
//
// NOT A SUITE. It prints a report and exits 0 regardless of what it finds,
// because its job is measurement. The ASSERTIONS live in
// test/test-real-corpus.mjs, which does gate. A probe that failed the build on
// a finding would be the same "looks fine while broken" shape this repo keeps
// warning about, one level up.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'polymem-real-corpus-'));
process.env.OMEGA_MEMORY_INDEX = join(tmp, 'patterns-index.json');
process.env.OMEGA_MEMORY_SESSIONS_DIR = join(tmp, 'sessions');

const m = await import('../src/index.mjs');
const { SESSIONS, MUST_KEEP, MUST_DROP } = await import('../test/fixtures/real-corpus.mjs');

const R = (s) => `\u001b[31m${s}\u001b[0m`;
const G = (s) => `\u001b[32m${s}\u001b[0m`;
const D = (s) => `\u001b[2m${s}\u001b[0m`;
const B = (s) => `\u001b[1m${s}\u001b[0m`;

console.log(B('── parse → append → promote ───────────────────────────────────────'));

let keptClaims = 0, rejectedClaims = 0;
const rejectReasons = {};
let allPatternNames = [];
// Every pattern name the library was actually shown. MUST_DROP is only
// meaningful against THIS set: a name that was never offered cannot be
// "rejected", and counting it as rejected is a control that cannot fail.
const offered = new Set();

for (const s of SESSIONS) {
  const { display, memory } = m.parseMemoryBlock(s.raw);
  const stamped = m.stampProvenance(memory.claims, {
    provider: 'nous', model: 'stealth/space-bunny-alpha',
    task: 'real-corpus', taskId: `task-${s.date}`, agent: 'professor', routeSource: 'router',
  });

  // The gate as the CONSUMER applies it (this is how OmegaShell calls it).
  const seen = new Set();
  const accepted = [];
  for (const c of stamped) {
    const a = m.assessClaim(c, seen);
    if (a.accept) { accepted.push(c); keptClaims++; seen.add(c.text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()); }
    else { rejectedClaims++; rejectReasons[a.reason] = (rejectReasons[a.reason] || 0) + 1; }
  }

  const entry = {
    time: `${s.date}T09:00:00.000Z`, agent: 'professor', task: 'real-corpus',
    taskId: `task-${s.date}`, provider: 'nous', model: 'stealth/space-bunny-alpha',
    routeSource: 'router',
    claims: accepted,
    patterns: memory.patterns,
    correspondences: memory.contradictions || [],
    contradictions: [],
  };
  m.appendWorkingMemory(s.date, entry);

  const idx = m.loadPatternsIndex();
  m.promoteSession(s.date, idx);
  const names = memory.patterns.map((p) => p.text);
  allPatternNames.push(...names);
  console.log(`\n${B(s.date)}  ${D(`display: ${display.slice(0, 52)}${display.length > 52 ? '…' : ''}`)}`);
  for (const n of names) {
    const g = m.assessClaim({ text: n });
    offered.add(n.toLowerCase());
    console.log(`   ${g.accept ? R('OFFERED (gate accepts)') : G('offered → gate REJECTS')}  ${n}`);
  }
}

console.log(`\n${B('── claim gate ───────────────────────────────────────────────────')}`);
console.log(`  claims accepted ${keptClaims}, rejected ${rejectedClaims}`);
for (const [r, n] of Object.entries(rejectReasons).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${r.padEnd(24)} ${n}`);
}

const index = m.loadPatternsIndex();
const promoted = Object.values(index.patterns);
console.log(`\n${B('── what actually landed in the patterns index ────────────────────')}`);
console.log(`  ${promoted.length} patterns promoted from ${allPatternNames.length} session pattern names\n`);
for (const p of promoted.sort((a, b) => (b.sessions?.length || 0) - (a.sessions?.length || 0))) {
  console.log(`  ${B(p.status.padEnd(11))} ${D(`sessions=${(p.sessions || []).length} domains=[${(p.domains || []).join(',')}]`)}`);
  console.log(`     ${p.name}`);
}

// ── The two obligations, measured ───────────────────────────────────────────
const names = promoted.map((p) => p.name.toLowerCase());
const keptOK = MUST_KEEP.filter((n) => names.includes(n.toLowerCase()));
const droppedKnowledge = MUST_KEEP.filter((n) => !names.includes(n.toLowerCase()));
const noiseLanded = MUST_DROP.filter((n) => names.includes(n.toLowerCase()));
const noiseAbsent = MUST_DROP.filter((n) => !names.includes(n.toLowerCase()));

console.log(`\n${B('── OBLIGATION 1: knowledge must survive ───────────────────────────')}`);
console.log(`  kept ${keptOK.length}/${MUST_KEEP.length}`);
for (const n of MUST_KEEP) {
  console.log(`   ${names.includes(n.toLowerCase()) ? G('  KEPT  ') : R('  LOST ')} ${n}`);
}

console.log(`\n${B('── OBLIGATION 2: noise must not survive ──────────────────────────')}`);
console.log(`  ${noiseAbsent.length}/${MUST_DROP.length} rejected, ${noiseLanded.length} promoted`);
// A name that was never fed to the library proves nothing. Say so loudly rather
// than letting it pad the score.
const neverOffered = MUST_DROP.filter((n) => !offered.has(n.toLowerCase()));
for (const n of MUST_DROP) {
  const wasOffered = offered.has(n.toLowerCase());
  const landed = names.includes(n.toLowerCase());
  const tag = !wasOffered ? D('  NOT OFFERED (untested)') : landed ? R('  PROMOTED') : G('  rejected');
  console.log(`   ${tag}  ${n}`);
}
if (neverOffered.length) {
  console.log(R(`   ⚠ ${neverOffered.length} MUST_DROP item(s) never reached the library — that part of the score is vacuous.`));
}

// ── The user-visible half: what a query actually returns ─────────────────────
const QUERIES = [
  'how do we avoid losing writes',
  'serialize concurrency',
  'prototype pollution model output',
  'deploy dirty tree',
  'greeting',
  'word count',
];
console.log(`\n${B('── queryPatterns: what a user would actually get back ───────────')}`);
for (const q of QUERIES) {
  const r = m.queryPatterns(q, index);
  console.log(`\n  ${B(q)}  → ${r.length} result(s)`);
  for (const h of r.slice(0, 4)) console.log(`     ${D(`[${h.status} s=${h.sessions.length} score=${h.score}]`)} ${h.name}`);
  if (!r.length) console.log(D('     (nothing)'));
}

console.log(`\n${B('── provenance: can a promoted pattern be audited back to its claim? ─')}`);
for (const p of promoted.slice(0, 5)) {
  const hasProv = p.sources || p.provenance || p.taskId;
  console.log(`   ${hasProv ? G('YES') : R('NO ')}  ${p.name}`);
}
console.log(D('   (checked for a sources/provenance/taskId field on the index entry itself)'));

const verdict = droppedKnowledge.length === 0 && noiseLanded.length === 0 && neverOffered.length === 0
  ? G('VERDICT: both obligations met, and every MUST_DROP item was actually tested.')
  : R(`VERDICT: ${droppedKnowledge.length} knowledge lost, ${noiseLanded.length} noise promoted, ${neverOffered.length} noise untested.`);
console.log(`\n${verdict}\n`);

rmSync(tmp, { recursive: true, force: true });