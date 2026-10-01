// test/test-claim-gate.mjs
//
// THE REGRESSION GATE for the claim-path defect.
//
// THE DEFECT, in one causal chain — each link measured, none assumed:
//
//   appendWorkingMemory wrote entry.claims to disk with NO gate. So a noise
//   claim became half of a contradiction record via
//   checkIntraSessionContradictions. Then promoteSession's implicature pass
//   tested that record against EVERY pattern in the index and froze the ones
//   it implicated, permanently demoting established → candidate.
//
// The middle link is the one that makes this more than a tidiness bug. A
// rejected claim does not merely sit in a file: it DEMOTES REAL KNOWLEDGE. On
// the real corpus, 94 of 474 promoted patterns were frozen solely by
// contradictions built from claims the gate rejects, and one of them is
// `Chief of Staff handles simple direct requests without delegation` —
// item #2 on the must-keep list in docs/2026-09-25-promotion-defect.md, which
// that document says must never be tightened away. The gate is what keeps that
// knowledge reachable.
//
// TWO ARMS, AND NEITHER ALONE IS THE FIX. This is the part worth testing
// hardest, because each arm alone looks complete and neither is:
//
//   - write-path gate (appendWorkingMemory)  keeps NEW noise out, and CANNOT
//     reach records already on disk.
//   - promotion-path gate (promoteSession)    discards the 449 noise records
//     ALREADY sitting in the corpus.
//
// Deleting the promotion arm leaves the existing corpus frozen exactly as it
// was — 449 of 568 records are pre-existing. Deleting the write arm lets the
// corpus start re-filling. Both mutations are asserted below.
//
// THE ORIENTATION TEST IS THE POINT. Every assertion here is stated in the
// direction that must FAIL if the gate is removed, not the direction that
// happens to pass. A suite that only asserts "noise was dropped" is satisfied
// by a gate that rejects everything — so §4 asserts knowledge survives, and
// §5 asserts the gate cannot be replaced by a blanket reject.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'omega-claimgate-'));
process.env.OMEGA_MEMORY_INDEX = join(tmp, 'patterns-index.json');
process.env.OMEGA_MEMORY_SESSIONS_DIR = join(tmp, 'sessions');

const m = await import('../src/polymem.mjs');
import { createSuite } from './harness.mjs';
const { ok, section, done } = createSuite('test-claim-gate.mjs');

// ── fixtures ───────────────────────────────────────────────────────────────
// A REAL pattern: three sessions, two domains, so it reaches `established`
// and a freeze is therefore OBSERVABLE as a demotion rather than being masked
// by the promotion threshold.
//
// "power loss", not "crash", and the reason is worth stating because it is a
// trap this suite walked into first. `crash` is a member of the NEGATORS set —
// a JUDGMENT lexicon — so "Atomic rename prevents a torn index on crash" reads
// as `neg`, and so does "...does not prevent...". Bare polarity() then sees no
// conflict and the legitimate contradiction silently vanishes. That is the
// pre-existing topic-vs-judgment hazard polarityRelativeTo() exists to handle,
// and it is why the pattern-path fix reads polarity RELATIVE to the pattern.
// It is NOT caused by the claim gate, and this suite must not assert on a
// subject that trips it — otherwise a green run would be measuring the wrong
// thing.
const REAL = 'Atomic rename prevents a torn index on power loss';
// The subject the noise contradicts. Shares the pattern's tokens so it
// implicates, and reads as an ordinary claim rather than obviously synthetic.
const SUBJECT = 'atomic rename prevents a torn index on power loss';
const NOISE_POS = 'The casual greeting acknowledges the user warmly';
const NOISE_NEG = 'The casual greeting does not acknowledge the user warmly';

// Real facts, in the shape of the three read from Josh's own memory files that
// docs/2026-09-25-promotion-defect.md uses as a third-party benchmark.
const KNOWLEDGE = [
  'Two launchd plists both claimed the Telegram token and fought over it every fifteen seconds',
  'fallback_providers must be a YAML list, not a quoted string, or the gateway ignores it',
  'A gateway config change needs a manual restart from outside the process',
];

const resetIndex = () => writeFileSync(process.env.OMEGA_MEMORY_INDEX,
  JSON.stringify({ version: 1, patterns: {}, meta: { promotions: 0 } }, null, 2));

const writeSession = (date, { patterns = [], contradictions = [] } = {}) => {
  mkdirSync(join(tmp, 'sessions'), { recursive: true });
  writeFileSync(join(tmp, 'sessions', `working-${date}.json`), JSON.stringify({
    date,
    entries: patterns.map((p, i) => ({
      time: `t${i}`, agent: 'chief', task: 'real-work', taskId: `task-${date}-${i}`,
      claims: [], correspondences: [],
      patterns: [{ text: p, domains: ['code', 'ops'] }],
    })),
    contradictions,
  }, null, 2));
};

const realPattern = (index) => Object.values(index.patterns).find(p => p.name === REAL);

console.log('claim gate (write path):');
{
  // ── 1. noise never reaches disk ───────────────────────────────────────────
  const date = '2026-10-01';
  m.appendWorkingMemory(date, {
    time: 't1', agent: 'chief', task: 'greeting-benchmark', taskId: 'task-noise-1',
    claims: [
      { text: NOISE_POS, domains: [] },
      { text: 'The casual greeting is an acknowledgment of the user', domains: [] },
      { text: KNOWLEDGE[0], domains: ['ops'] },
    ],
  });
  const w = m.loadWorkingMemory(date);
  const texts = w.entries[0].claims.map(c => c.text);
  ok(!texts.includes(NOISE_POS), 'a claim the gate rejects is NOT stored',
    `stored: ${JSON.stringify(texts)}`);
  ok(!texts.includes('The casual greeting is an acknowledgment of the user'),
    'a rejected subject is NOT stored');
  ok(texts.includes(KNOWLEDGE[0]), 'a real claim in the same entry IS stored',
    `stored: ${JSON.stringify(texts)}`);
  ok(w.entries[0].claims.length === 1, 'the entry keeps exactly the admitted claims',
    `got ${w.entries[0].claims.length}`);

  // ── 2. rejections are recorded, not silently dropped ──────────────────────
  // An operator has to be able to ask "what was filtered and why" — the same
  // standard index.meta.patternGate is held to.
  const gate = w.meta && w.meta.claimGate;
  ok(!!gate, 'rejections are recorded in session meta, not deleted');
  ok(gate && gate.rejected === 2, 'claimGate counts both rejections',
    gate ? `rejected=${gate.rejected}` : 'no gate');
  ok(gate && gate.accepted === 1, 'claimGate counts the admitted claim',
    gate ? `accepted=${gate.accepted}` : 'no gate');
  ok(gate && Object.keys(gate.byReason).length > 0, 'claimGate records a per-reason breakdown',
    JSON.stringify(gate && gate.byReason));

  // ── 3. rejection reasons are the GATE's, not a catch-all ──────────────────
  ok(gate && Object.values(gate.byReason).every(r => typeof r === 'number' && r > 0),
    'every byReason bucket is a positive count');

  // ── 4. the entry is otherwise untouched ───────────────────────────────────
  // The gate filters CLAIMS. Patterns, correspondences and provenance must
  // survive, or this would be a data-loss fix disguised as a filter.
  m.appendWorkingMemory('2026-10-02', {
    time: 't2', agent: 'chief', task: 'real-work', taskId: 'task-keep-2',
    claims: [{ text: 'Casual greeting', domains: [] }],
    patterns: [{ text: REAL, domains: ['code', 'ops'] }],
    correspondences: ['serialization ↔ atomic rename'],
  });
  const w2 = m.loadWorkingMemory('2026-10-02');
  ok(w2.entries[0].patterns.length === 1 && w2.entries[0].patterns[0].text === REAL,
    'a rejected CLAIM does not take the entry\'s patterns with it');
  ok(w2.entries[0].correspondences.length === 1, 'correspondences survive the gate');
  ok(w2.entries[0].taskId === 'task-keep-2', 'entry provenance survives the gate');
}

console.log('claim gate (does not manufacture a contradiction):');
{
  // ── 5. noise claims cannot raise a contradiction ──────────────────────────
  // This is the link that makes the defect more than a dirty file.
  const date = '2026-10-03';
  const first = m.appendWorkingMemory(date, {
    time: 't1', agent: 'chief', task: 'greeting-benchmark', taskId: 'task-n1',
    claims: [{ text: NOISE_POS, domains: [] }],
  });
  ok(first.length === 0, 'a noise claim on its own raises nothing');
  // The second entry would flip polarity against the first and raise a flag if
  // the first had been stored. It must not.
  const second = m.appendWorkingMemory(date, {
    time: 't2', agent: 'chief', task: 'greeting-benchmark', taskId: 'task-n2',
    claims: [{ text: NOISE_NEG, domains: [] }],
  });
  ok(second.length === 0, 'a second noise claim does NOT contradict the first',
    `flags=${JSON.stringify(second)}`);
  ok(m.loadWorkingMemory(date).contradictions.length === 0,
    'no contradiction record is written for a noise-only pair');
}

console.log('claim gate (legitimate contradictions still work):');
{
  // ── 6. the other direction: a REAL conflict must still be caught ──────────
  // A gate that rejects everything passes every assertion above. These are the
  // assertions that make a blanket reject fail.
  const date = '2026-10-04';
  m.appendWorkingMemory(date, {
    time: 't1', agent: 'sparks', task: 'storage', taskId: 'task-ok-1',
    claims: [{ text: SUBJECT, domains: ['code'] }],
  });
  const flags = m.appendWorkingMemory(date, {
    time: 't2', agent: 'sentry', task: 'storage', taskId: 'task-ok-2',
    claims: [{ text: 'Atomic rename does not prevent a torn index on power loss', domains: ['code'] }],
  });
  ok(flags.length === 1, 'two REAL claims in opposition DO raise a contradiction',
    `flags=${flags.length}`);
  ok(m.loadWorkingMemory(date).contradictions.length === 1,
    'the real contradiction is persisted');
}

console.log('claim gate (promotion path heals the existing corpus):');
{
  // ── 7. the arm that only this fix adds ────────────────────────────────────
  // A contradiction record already on disk, bypassing the write path entirely —
  // which is the real corpus, where 449 of 568 records predate any gate. If the
  // promotion path did not re-check, this pattern would be frozen by a claim
  // the gate rejects.
  resetIndex();
  const dates = ['2026-10-05', '2026-10-06', '2026-10-07'];
  dates.forEach(d => writeSession(d, { patterns: [REAL] }));
  const idx = m.loadPatternsIndex();
  dates.forEach(d => m.promoteSession(d, idx));
  ok(realPattern(idx)?.status === 'established',
    'control: the real pattern establishes on clean sessions',
    `status=${realPattern(idx)?.status}`);

  // Now write the noise contradiction DIRECTLY to the session file, exactly as
  // the pre-fix write path would have left it.
  const last = dates[dates.length - 1];
  const p = join(tmp, 'sessions', `working-${last}.json`);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.contradictions.push({
    newClaim: NOISE_POS, existingClaim: NOISE_NEG, resolution: 'unresolved', time: 't9', agent: 'chief',
  });
  writeFileSync(p, JSON.stringify(j, null, 2));

  const idx2 = m.loadPatternsIndex();
  m.promoteSession(last, idx2);
  const healed = realPattern(idx2);
  ok((healed?.implicatedBy || []).length === 0,
    'a PRE-EXISTING noise contradiction does NOT freeze the real pattern',
    `implicatedBy=${JSON.stringify(healed?.implicatedBy)}`);
  ok(healed?.status === 'established', 'the real pattern stays established');
  const cg = idx2.meta.claimGate;
  ok(cg && cg.rejected >= 1, 'the promotion-path gate counts the discarded record',
    JSON.stringify(cg));
  ok(cg && Object.keys(cg.byReason || {}).length > 0,
    'the discarded record carries a reason, so the drop is auditable',
    JSON.stringify(cg && cg.byReason));

  // ── 7b. a MIXED batch: one noise record and one real record, same session ─
  // This is the case that a naive "drop the whole session's contradictions if
  // any claim is gated" fix would silently break, and the one that a
  // "filter on newClaim only" fix would silently break. Both must hold.
  resetIndex();
  const dates1b = ['2026-10-19', '2026-10-20', '2026-10-21'];
  dates1b.forEach(d => writeSession(d, { patterns: [REAL] }));
  const idxB = m.loadPatternsIndex();
  dates1b.forEach(d => m.promoteSession(d, idxB));
  ok(realPattern(idxB)?.status === 'established', 'control: establishes before the mixed batch');
  const lastB = dates1b[dates1b.length - 1];
  const pB = join(tmp, 'sessions', `working-${lastB}.json`);
  const jB = JSON.parse(readFileSync(pB, 'utf8'));
  jB.contradictions.push(
    { newClaim: NOISE_POS, existingClaim: NOISE_NEG, resolution: 'unresolved', time: 't8', agent: 'chief' },
    { newClaim: 'Atomic rename does not prevent a torn index on power loss', existingClaim: SUBJECT, resolution: 'unresolved', time: 't9', agent: 'chief' },
  );
  writeFileSync(pB, JSON.stringify(jB, null, 2));
  const idxB2 = m.loadPatternsIndex();
  m.promoteSession(lastB, idxB2);
  const mixed = realPattern(idxB2);
  ok((mixed?.implicatedBy || []).length === 1,
    'in a MIXED batch the noise record is dropped and the real one still freezes',
    `implicatedBy=${JSON.stringify(mixed?.implicatedBy)}`);
  ok(mixed?.status === 'candidate', 'and the demotion still happens (not swallowed with the noise)',
    `status=${mixed?.status}`);

  // ── 7c. gating must consider BOTH halves of the pair ──────────────────────
  // A clean claim contradicted by noise is still noise doing the damage, so a
  // filter that only inspects newClaim lets it through.
  resetIndex();
  const datesC = ['2026-10-22', '2026-10-23', '2026-10-24'];
  datesC.forEach(d => writeSession(d, { patterns: [REAL] }));
  const idxC = m.loadPatternsIndex();
  datesC.forEach(d => m.promoteSession(d, idxC));
  ok(realPattern(idxC)?.status === 'established', 'control: establishes before the half-noisy record');
  const lastC = datesC[datesC.length - 1];
  const pC = join(tmp, 'sessions', `working-${lastC}.json`);
  const jC = JSON.parse(readFileSync(pC, 'utf8'));
  // newClaim is REAL and implicates; existingClaim is noise. Checking only
  // newClaim would freeze the pattern on the strength of the noise half.
  jC.contradictions.push({
    newClaim: 'Atomic rename does not prevent a torn index on power loss',
    existingClaim: NOISE_POS, resolution: 'unresolved', time: 't9', agent: 'chief',
  });
  writeFileSync(pC, JSON.stringify(jC, null, 2));
  const idxC2 = m.loadPatternsIndex();
  m.promoteSession(lastC, idxC2);
  const half = realPattern(idxC2);
  ok((half?.implicatedBy || []).length === 0,
    'a record whose OTHER half is noise does not freeze a real pattern',
    `implicatedBy=${JSON.stringify(half?.implicatedBy)}`);
  ok(half?.status === 'established', 'the pattern stays established on a half-noisy record');

  // ── 8. a legitimate pre-existing contradiction MUST still freeze ──────────
  // The mirror of §7. If this fails, the fix is not a filter but a demotion.
  resetIndex();
  const dates2 = ['2026-10-08', '2026-10-09', '2026-10-10'];
  dates2.forEach(d => writeSession(d, { patterns: [REAL] }));
  const idx3 = m.loadPatternsIndex();
  dates2.forEach(d => m.promoteSession(d, idx3));
  ok(realPattern(idx3)?.status === 'established', 'control: establishes again');
  const last2 = dates2[dates2.length - 1];
  const p2 = join(tmp, 'sessions', `working-${last2}.json`);
  const j2 = JSON.parse(readFileSync(p2, 'utf8'));
  j2.contradictions.push({
    newClaim: 'Atomic rename does not prevent a torn index on power loss',
    existingClaim: SUBJECT, resolution: 'unresolved', time: 't9', agent: 'chief',
  });
  writeFileSync(p2, JSON.stringify(j2, null, 2));
  const idx4 = m.loadPatternsIndex();
  m.promoteSession(last2, idx4);
  const frozen = realPattern(idx4);
  ok((frozen?.implicatedBy || []).length === 1,
    'a LEGITIMATE pre-existing contradiction still freezes the pattern',
    `implicatedBy=${JSON.stringify(frozen?.implicatedBy)}`);
  ok(frozen?.status === 'candidate', 'and still demotes it to candidate',
    `status=${frozen?.status}`);
}

console.log('claim gate (knowledge side):');
{
  // ── 9. no real knowledge is lost ─────────────────────────────────────────
  // The obligation docs/2026-09-25-promotion-defect.md calls out as unchanged
  // BY DESIGN. Three claims Josh actually wrote, in his own store.
  const date = '2026-10-11';
  m.appendWorkingMemory(date, {
    time: 't1', agent: 'chief', task: 'ops', taskId: 'task-know-1',
    claims: KNOWLEDGE.map(t => ({ text: t, domains: ['ops'] })),
  });
  const stored = m.loadWorkingMemory(date).entries[0].claims.map(c => c.text);
  for (const k of KNOWLEDGE) {
    ok(stored.includes(k), `real knowledge kept: "${k.slice(0, 48)}..."`);
  }
  ok(stored.length === KNOWLEDGE.length, 'every real knowledge claim survived',
    `got ${stored.length}/${KNOWLEDGE.length}`);
}

console.log('claim gate (the `seen` set is per-ENTRY, not per-session):');
{
  // ── 10. cross-entry corroboration must survive ───────────────────────────
  // Seeding the duplicate check from every claim already in the session drops
  // 45 cross-entry duplicates on the real corpus, and all 45 carry a DIFFERENT
  // taskId than the copy it kept. Those are separate dispatches asserting the
  // same fact — corroboration, not duplication. Dropping them deletes the
  // audit trail. This assertion is the guard on that measurement.
  const date = '2026-10-12';
  const shared = 'The staging index is rebuilt before every release';
  m.appendWorkingMemory(date, {
    time: 't1', agent: 'chief', task: 'ops', taskId: 'task-dup-a',
    claims: [{ text: shared, domains: ['ops'] }],
  });
  m.appendWorkingMemory(date, {
    time: 't2', agent: 'sentry', task: 'ops', taskId: 'task-dup-b',
    claims: [{ text: shared, domains: ['ops'] }],
  });
  const entries = m.loadWorkingMemory(date).entries;
  ok(entries.length === 2, 'both entries stored');
  ok(entries[1].claims.length === 1,
    'a claim repeated by a DIFFERENT dispatch in a later entry is KEPT',
    `got ${entries[1].claims.length}`);
  // Guarded rather than indexing blind: under the per-session-seeding mutation
  // the second entry's claims array is EMPTY, so `entries[1].claims[0].taskId`
  // throws and takes the whole suite down with it. A crash reports "no result"
  // to the runner, which is a weaker and less legible failure than a red
  // assertion naming the behaviour that broke.
  ok(entries[1].claims[0]?.taskId === 'task-dup-b',
    'the second dispatch keeps its own taskId — the evidence link survives',
    `taskId=${entries[1].claims[0]?.taskId}`);

  // ── 11. a genuine within-entry duplicate is still caught ──────────────────
  // The per-entry rule must not have been widened into "never dedupe".
  const dupDate = '2026-10-13';
  m.appendWorkingMemory(dupDate, {
    time: 't1', agent: 'chief', task: 'ops', taskId: 'task-dup-c',
    claims: [
      { text: 'The staging index is rebuilt before every release', domains: ['ops'] },
      { text: 'the staging index is rebuilt before every release!', domains: ['ops'] },
    ],
  });
  const dup = m.loadWorkingMemory(dupDate);
  ok(dup.entries[0].claims.length === 1,
    'the SAME dispatch saying it twice is deduped (normalised comparison)',
    `got ${dup.entries[0].claims.length}`);
  ok(dup.meta.claimGate.byReason['duplicate-in-session'] === 1,
    'and it is reported as duplicate-in-session, not silently',
    JSON.stringify(dup.meta.claimGate.byReason));
}

console.log('claim gate (provenance is fill-only):');
{
  // ── 12. existing attribution must never be overwritten ───────────────────
  // stampProvenance assigns every field unconditionally. Calling it on the
  // write path with entry-level fields would stamp "unknown" over real model
  // attribution — measured on the real corpus as 4640 claim fields holding a
  // real value, and 0/182 entries carrying a `model` key at all. That is the
  // longcat attribution defect rebuilt one layer down.
  const date = '2026-10-14';
  m.appendWorkingMemory(date, {
    time: 't1', agent: 'chief', task: 'ops', taskId: 'task-prov-1', model: 'ENTRY-MODEL',
    claims: [{ text: KNOWLEDGE[2], model: 'claim-model', provider: 'claim-provider', domains: ['ops'] }],
  });
  const c = m.loadWorkingMemory(date).entries[0].claims[0];
  ok(c.model === 'claim-model', 'a claim\'s own model is NOT overwritten by the entry',
    `model=${c.model}`);
  ok(c.provider === 'claim-provider', 'a claim\'s own provider is NOT overwritten',
    `provider=${c.provider}`);
  ok(c.taskId === 'task-prov-1', 'a MISSING field is filled from the entry',
    `taskId=${c.taskId}`);

  // ── 13. and a genuinely absent field stays absent, never invented ────────
  const d2 = '2026-10-15';
  m.appendWorkingMemory(d2, {
    time: 't1', agent: 'chief', task: 'ops', taskId: 'task-prov-2',
    claims: [{ text: KNOWLEDGE[1], domains: ['ops'] }],
  });
  const c2 = m.loadWorkingMemory(d2).entries[0].claims[0];
  ok(c2.model === undefined,
    'a model absent from BOTH claim and entry is not invented',
    `model=${JSON.stringify(c2.model)}`);
  ok(c2.routeSource === undefined, 'routeSource is not invented either',
    `routeSource=${JSON.stringify(c2.routeSource)}`);
}

console.log('claim gate (idempotence):');
{
  // ── 14. replaying must not change the outcome ────────────────────────────
  // The property promoteSession already guarantees for the pattern path. The
  // new gate must not break it: re-promoting must not re-apply a freeze or
  // double-count a rejection.
  resetIndex();
  const d = ['2026-10-16', '2026-10-17', '2026-10-18'];
  d.forEach(x => writeSession(x, { patterns: [REAL] }));
  const runOnce = () => {
    const idx = m.loadPatternsIndex();
    d.forEach(x => m.promoteSession(x, idx));
    return JSON.stringify({
      status: realPattern(idx)?.status,
      sessions: realPattern(idx)?.sessions.slice().sort(),
      evidence: realPattern(idx)?.evidenceCount,
      implicatedBy: (realPattern(idx)?.implicatedBy || []).slice().sort(),
    });
  };
  const first = runOnce();
  const second = runOnce();
  ok(first === second, 'replaying every session converges on the same pattern state',
    `${first} vs ${second}`);

  // ── 15. replaying must not inflate the rejection counters ────────────────
  // claimGate is cumulative by design, so a re-promote of the SAME session
  // adds to it. That is a reporting artifact worth pinning: an operator
  // reading claimGate after N manual re-promotes should not think the filter
  // got N× stricter.
  const idx = m.loadPatternsIndex();
  const before = idx.meta.claimGate.accepted;
  m.promoteSession(d[d.length - 1], idx);
  const after = m.loadPatternsIndex().meta.claimGate.accepted;
  ok(after >= before, 'claimGate is monotonic across replays (documented as cumulative)',
    `${before} -> ${after}`);
}

done();