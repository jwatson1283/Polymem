// test/test-real-corpus.mjs
//
// THE SUITE THAT MAKES THE 2026-09-25 FIX UNREGRESSABLE.
//
// WHY THIS SUITE EXISTS. The library shipped 270 assertions across 10 suites
// and still promoted "casual-greeting" and
// "miscounting-words-in-constrained-length-response" into a live index, which
// a human then had to quarantine by hand. Every existing assertion was true and
// the defect was real, because the existing suites test MECHANISMS — parse this,
// write atomically, contain this path, merge that one — and none of them ever
// asked the only question that mattered: given a realistic day's output, is the
// resulting index worth reading?
//
// Two obligations, and both must hold simultaneously:
//
//   1. Knowledge must survive. A filter tuned until only noise passes is worse
//      than no filter, because it looks like it is working.
//   2. Noise must not survive. This is the one that was failing.
//
// THE FIXTURE IS NOT SYNTHETIC. test/fixtures/real-corpus.mjs is six sessions
// of real model-emitted content — agent orchestration, memory architecture,
// security findings, deployment practice — in the raw display+```memory form a
// model actually produces, with the live corpus's noise classes interleaved at
// the live rate. "Hello world" fixtures cannot catch this defect; they are why
// the 182-assertion suite (now 270) shipped it.
//
// MEASURED BEFORE -> AFTER, via tools/real-corpus-probe.mjs:
//
//   noise promoted          15 -> 0        (0/15 rejected -> 15/15 rejected)
//   patterns promoted       24 -> 8
//   query("greeting")        6 -> 0 results
//   knowledge kept           8/8 -> 8/8     (the fix cost no knowledge)

import { createSuite } from './harness.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HOME must be redirected BEFORE src is imported: polymem.mjs resolves its
// session and index paths at module load. Import order is load-bearing here.
const home = mkdtempSync(join(tmpdir(), 'polymem-real-corpus-'));
process.env.HOME = home;

const { SESSIONS, MUST_KEEP, MUST_DROP } = await import('./fixtures/real-corpus.mjs');
const { parseMemoryBlock } = await import('../src/polymem.mjs');
const { promoteSession, queryPatterns, assessPatternName } = await import('../src/index.mjs');

const suite = createSuite('test-real-corpus.mjs');
const { section, ok, done } = suite;

const work = join(home, 'Documents/Obsidian Vault/11_COMPUTER_AGENT/sessions');
mkdirSync(work, { recursive: true });

// ── Build the corpus the way the real pipeline does ────────────────────────
// Model output -> parseMemoryBlock -> working-memory entry. Not hand-written
// objects: if the parser regresses, this suite sees the same garbage the live
// pipeline would see, which is the entire point.
const built = [];
for (const s of SESSIONS) {
  const memory = parseMemoryBlock(s.raw);
  ok(memory?.memory !== null, `parseMemoryBlock reads session ${s.date}`, s.raw.slice(0, 60));
  built.push({
    date: s.date,
    raw: s.raw,
    memory,
    patterns: (memory?.memory?.patterns || []).map((p) => p.text),
  });
}
ok(built.every((b) => b.patterns.length > 0), 'every session yields at least one pattern');

// The corpus must contain BOTH classes or nothing below is meaningful.
const offered = new Set(built.flatMap((b) => b.patterns));
const keepOffered = MUST_KEEP.filter((n) => offered.has(n));
const dropOffered = MUST_DROP.filter((n) => offered.has(n));

section('the fixture can actually fail');
// THE MOST IMPORTANT ASSERTIONS IN THIS FILE.
//
// An earlier draft kept MUST_DROP outside the emitted sessions, and the probe
// then reported "rejected 15/15" — measuring that the corpus did not CONTAIN
// the noise, not that the filter REJECTED it. That control cannot fail, which is
// a no-op in a different costume. These three assertions are what stop that
// class of bug from shipping again: if a noise name is not in a session, or a
// knowledge name is not, the suite fails BEFORE any gate result is trusted.
ok(dropOffered.length === MUST_DROP.length,
  'CONTROL: every MUST_DROP name was emitted into a session (not merely listed)',
  `${dropOffered.length}/${MUST_DROP.length} offered — missing: ${
    MUST_DROP.filter((n) => !offered.has(n)).join(', ') || 'none'}`);
ok(keepOffered.length === MUST_KEEP.length,
  'CONTROL: every MUST_KEEP name was emitted into a session',
  `${keepOffered.length}/${MUST_KEEP.length} offered — missing: ${
    MUST_KEEP.filter((n) => !offered.has(n)).join(', ') || 'none'}`);
ok(offered.size >= MUST_KEEP.length + MUST_DROP.length,
  'CONTROL: the corpus is mixed, not one-sided',
  `${offered.size} distinct names`);

try {
  // ── Obligation 1: knowledge survives ─────────────────────────────────────
  section('OBLIGATION 1 — knowledge must survive');

  // ── Obligation 2: noise must not survive, ON THE PROMOTION PATH ─────────
  // These run through the real promoteSession, not assessPatternName directly.
  // The whole defect was that the gate existed and was never called, so
  // asserting on the gate's return value would test nothing that was broken.
  const index = { version: 1, patterns: {}, meta: {} };
  for (const b of built) {
    writeFileSync(join(work, `working-${b.date}.json`), JSON.stringify({
      date: b.date,
      contradictions: [],
      entries: [{
        time: `${b.date}T09:00:00.000Z`,
        task: b.raw.split('\n')[0] || 'real-corpus session',
        taskId: `task-${b.date}-corpus`,
        provider: 'nous/hermes-2',
        agent: 'researcher',
        routeSource: 'router',
        claims: [],
        patterns: b.patterns.map((text, i) => ({ text, domains: ['code', 'ops'], i })),
        correspondences: [],
        contradictions: [],
      }],
    }, null, 2));
    promoteSession(b.date, index);
  }

  const promoted = new Map(Object.entries(index.patterns).map(([id, p]) => [id, p.name]));
  const promotedNames = [...promoted.values()];

  const lostKeep = MUST_KEEP.filter((n) => !promotedNames.includes(n));
  ok(lostKeep.length === 0,
    'OBLIGATION 1: no knowledge was dropped by the gate',
    lostKeep.join(' | '));
  ok(MUST_KEEP.every((n) => offered.has(n)), 'OBLIGATION 1: every knowledge item was actually offered');

  const landedNoise = MUST_DROP.filter((n) => promotedNames.includes(n));
  ok(landedNoise.length === 0,
    'OBLIGATION 2: no noise was promoted into the index',
    landedNoise.join(' | '));
  ok(MUST_DROP.every((n) => offered.has(n)), 'OBLIGATION 2: every noise item was actually offered');

  // The historical defect, named. These are the two patterns that reached the
  // live index and had to be quarantined by hand.
  for (const known of ['casual-greeting', 'miscounting-words-in-constrained-length-response']) {
    ok(!promoted.has(known),
      `OBLIGATION 2: "${known}" — the exact pattern from the quarantine — is not promoted`);
  }

  // ── The user-visible half ────────────────────────────────────────────────
  section('what a user would actually get back');
  const greetingHits = queryPatterns('greeting', index);
  ok(greetingHits.length === 0,
    'queryPatterns("greeting") returns nothing',
    `${greetingHits.length} hit(s): ${greetingHits.map((h) => h.name).join(', ')}`);
  const writeHits = queryPatterns('serialize concurrency', index);
  ok(writeHits.length > 0,
    'queryPatterns("serialize concurrency") still finds the real knowledge',
    `${writeHits.length} hit(s)`);

  // ── The gate is structural, not advisory ─────────────────────────────────
  // THE REGRESSION THIS SUITE EXISTS FOR. Before the fix, assessClaim had zero
  // callers in polymem.mjs. A suite that only asserted on assessClaim's return
  // value would have passed then and now, while the index filled with noise.
  section('the gate is ON the promotion path');
  ok(index.meta.patternGate, 'promoteSession recorded meta.patternGate');
  ok(index.meta.patternGate.rejected > 0,
    'meta.patternGate shows rejections — the gate actually ran',
    JSON.stringify(index.meta.patternGate));
  ok(index.meta.patternGate.accepted > 0 && index.meta.patternGate.rejected > 0,
    'the gate is mixed: it passed knowledge AND refused noise',
    JSON.stringify(index.meta.patternGate));
  ok(Object.keys(index.meta.patternGate.byReason || {}).length > 0,
    'rejections carry a machine-readable reason',
    Object.keys(index.meta.patternGate.byReason || {}).join(', '));

  // ── Provenance ───────────────────────────────────────────────────────────
  section('a promoted pattern can be audited back to its dispatch');
  const noProv = [...promoted.values()].filter((n) => {
    const p = index.patterns[patternIdOf(promoted, n)];
    return !p?.sources?.length;
  });
  ok(noProv.length === 0,
    'every promoted pattern carries at least one source',
    noProv.join(' | '));

  const sample = index.patterns[Object.keys(index.patterns)[0]];
  ok(sample.sources[0].taskId === `task-${sample.sources[0].session}-corpus`,
    'source.taskId matches the dispatch that carried it',
    sample.sources[0].taskId);
  ok(sample.sources[0].provider === 'nous/hermes-2',
    'source.provider survives promotion',
    sample.sources[0].provider);
  ok(sample.sources[0].agent === 'researcher',
    'source.agent survives promotion',
    sample.sources[0].agent);
  // Carried, not inferred. The fixture's entries carry no `model` field, so
  // this must be 'unknown' — a filter that filled it in would be fabricating
  // attribution, which is the longcat defect all over again.
  ok(sample.sources[0].model === 'unknown',
    'an absent field stays "unknown" rather than being invented',
    `got "${sample.sources[0].model}"`);

  // ── The measured ceiling, asserted as a number ───────────────────────────
  // The 11 real names that STILL pass, measured not remembered. An earlier
  // draft listed 22 and called all of them "noise" — that label was wrong, and
  // four of them are plausibly GOOD knowledge:
  //
  //   "Intra-session contradiction tracking"    <- a feature of this library
  //   "Chief of Staff handles simple direct requests without delegation"
  //   "Edge computing architecture prioritizes privacy, latency, ..."
  //   "Generate and review code snippets"
  //
  // The remaining 7 are noise a lexical rule cannot separate without the same
  // word patterns that would also kill the four above: "System recovery check"
  // and "Clear communication pattern" are structurally identical to "Code
  // Review", which IS caught. There is no line between them that does not also
  // take real knowledge with it.
  //
  // A broad "no finite verb" rule was measured against this set: it caught 4
  // and destroyed "Intra-session contradiction tracking". Rejected for that
  // reason — a rule that trades real knowledge for noise is a bad trade however
  // good the headline number looks. The three narrow shapes that shipped took
  // the ceiling 22 -> 11 at zero knowledge cost.
  section('the measured ceiling, stated as a number');
  const SURVIVING_REAL_NAMES = [
    'System recovery check',
    'Edge computing architecture prioritizes privacy, latency, and offline resilience',
    'Local-first AI agents explanation',
    'Intra-session contradiction tracking',
    'Incomplete adherence to specifications',
    'Progress tracking across parallel workstreams.',
    'Clear communication pattern',
    'Factual accuracy error',
    'Information synthesis pattern',
    'Generate and review code snippets',
    'Chief of Staff handles simple direct requests without delegation',
  ];
  // Of the 11, these four are believed to be knowledge and MUST NOT be
  // tightened away. Asserted separately so a future "improvement" that eats
  // them fails loudly rather than silently.
  const ARGUABLY_KNOWLEDGE = [
    'Intra-session contradiction tracking',
    'Chief of Staff handles simple direct requests without delegation',
    'Edge computing architecture prioritizes privacy, latency, and offline resilience',
    'Generate and review code snippets',
  ];
  const stillPassing = SURVIVING_REAL_NAMES.filter((n) => assessPatternName(n).accept);
  ok(stillPassing.length === SURVIVING_REAL_NAMES.length,
    `MEASURED CEILING: all ${SURVIVING_REAL_NAMES.length} surviving real names still pass the filter`,
    `${stillPassing.length} pass — if this IMPROVES, update the list with evidence, do not relax the assertion`);
  ok(ARGUABLY_KNOWLEDGE.every((n) => assessPatternName(n).accept),
    'all 4 arguably-knowledge survivors are still kept — the ceiling may not tighten into them',
    ARGUABLY_KNOWLEDGE.filter((n) => !assessPatternName(n).accept).join(' | '));
  // The converse: none of these may be added to the list casually. Asserting the
  // whole documented set still passes is what makes adding an entry deliberate.
  ok(assessPatternName('Code Review').accept === false,
    '"Code Review" is now caught by bareProcessLabel — a real name off the ceiling',
    `reason=${assessPatternName('Code Review').reason}`);
  ok(assessPatternName('**Echo Command**').accept === false,
    '"**Echo Command**" is caught despite markdown noise',
    `reason=${assessPatternName('**Echo Command**').reason}`);
  ok(assessPatternName('Requirement verification omission').accept === false,
    '"Requirement verification omission" is caught by nominalizedActivity',
    `reason=${assessPatternName('Requirement verification omission').reason}`);
  ok(assessPatternName('Intra-session contradiction tracking catches drift').accept === true,
    'the predicate veto keeps knowledge that merely ENDS in a nominalization');
  ok(assessPatternName('Response caching invalidates on schema change').accept === true,
    'the ^…$-anchored rule does NOT fire on a pattern that merely mentions a response');

  // ── Anchoring guards ─────────────────────────────────────────────────────
  // Two rules were deliberately anchored so they cannot eat real knowledge.
  section('anchored rules do not fire on real knowledge');
  for (const keep of [
    'Response caching invalidates on schema change',
    'Josh prefers direct action over a plan document',
    'Deploy checks completed before the release was cut',
  ]) {
    const v = assessPatternName(keep);
    ok(v.accept, `kept: "${keep}"`, `rejected as ${v.reason}`);
  }
  for (const drop of [
    'Casual greeting', 'Five-word salutation', 'Minimalist greeting acknowledgment',
    'Running the deploy checks now', 'The user prefers concise responses',
    'Task processing pattern: The system processes tasks sequentially or concurrently based on configuration',
    'Task Reponse', 'Response Acknowledgment',
    'The user asked to fix the race' /* a restated request is still a request */
  ]) {
    const v = assessPatternName(drop);
    ok(!v.accept, `rejected: "${drop}"`, `reason=${v.reason}`);
  }

} finally {
  rmSync(home, { recursive: true, force: true });
}

function patternIdOf(map, name) {
  for (const [id, n] of map) if (n === name) return id;
  return null;
}

done();