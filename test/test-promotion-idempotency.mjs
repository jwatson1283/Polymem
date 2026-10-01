// test-promotion-idempotency.mjs — the regression gate for the three defects
// fixed in this branch. Every case here reproduced against the real module
// BEFORE the fix; the "was" values are measured, not asserted from memory.
//
//   node backend/test-promotion-idempotency.mjs
//
// Runs entirely in a temp dir. Never touches the real vault or the real index.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'omega-idem-'));
process.env.OMEGA_MEMORY_INDEX = join(tmp, 'patterns-index.json');
process.env.OMEGA_MEMORY_SESSIONS_DIR = join(tmp, 'sessions');

const m = await import('../src/polymem.mjs');

import { createSuite } from './harness.mjs';

const { ok, done } = createSuite('test-promotion-idempotency.mjs');

const seed = (date, patterns, contradictions = []) => {
  mkdirSync(join(tmp, 'sessions'), { recursive: true });
  writeFileSync(join(tmp, 'sessions', `working-${date}.json`), JSON.stringify({
    date,
    entries: patterns.map((p, i) => ({ time: `t${i}`, agent: 'chief', claims: [], correspondences: [], patterns: [{ text: p, domains: ['code', 'ops'] }] })),
    contradictions,
  }, null, 2));
};

const resetIndex = () => writeFileSync(process.env.OMEGA_MEMORY_INDEX,
  JSON.stringify({ version: 1, patterns: {}, meta: { decompositionStats: {}, promotions: 0 } }));

// The comparison that matters: everything an operator or a query can observe.
// Excludes firstSeen/lastSeen (wall-clock by design) and the promotion counter.
const observable = (idx) => JSON.stringify(Object.fromEntries(
  Object.entries(idx.patterns).map(([k, v]) => [k, {
    status: v.status, sessions: v.sessions.slice().sort(), evidence: v.evidenceCount,
    domains: v.domains.slice().sort(), implicatedBy: (v.implicatedBy || []).slice().sort(),
  }])
), null, 0);

const replay = (order) => { resetIndex(); const idx = m.loadPatternsIndex(); for (const d of order) m.promoteSession(d, idx); return idx; };

// ── 1. Implicature: subject overlap + polarity, not a shared substring ──────
console.log('implicature rule:');
const ATOMIC = 'Atomic rename prevents a torn index on crash';
ok(m.isImplicatedBy(ATOMIC, { newClaim: 'The staging index is stale', existingClaim: 'The staging index is current' }) === false,
  'unrelated claim sharing only "index" does NOT implicate the atomic-rename pattern');
ok(m.isImplicatedBy(ATOMIC, { newClaim: 'Atomic rename does not prevent a torn index on crash', existingClaim: 'Atomic rename prevents a torn index on crash' }) === true,
  'a claim that genuinely contradicts the pattern DOES implicate it');
ok(m.isImplicatedBy('Greeting', { newClaim: 'A friendly greeting was sent to the user this morning', existingClaim: 'A friendly greeting was never sent' }) === false,
  'a one-token pattern name is not implicable by any single shared word');
// MIN_SHARED in isolation. Two content tokens on each side, so neither the
// IMPLICATURE_MIN_TOKENS guard nor a low MIN_OVERLAP can be what rejects this.
// Exactly one of the pattern's two tokens appears in the claim: the overlap
// ratio is 1/2 = 0.50, precisely AT the threshold, and the case is still
// refused. Without the floor, sitting exactly on the threshold would be enough
// to implicate a pattern on half a subject match.
ok(m.isImplicatedBy('atomic rename', { newClaim: 'atomic writes are not needed here', existingClaim: 'atomic writes are needed here' }) === false,
  'one shared token out of two, ratio exactly at the 0.5 threshold, is still refused (MIN_SHARED floor)');
ok(m.isImplicatedBy('atomic rename', { newClaim: 'rename the atomic log lines', existingClaim: 'atomic log lines are not renamed' }) === true,
  'the same pattern with BOTH tokens shared is accepted — the floor is the only thing that changed');
ok(m.isImplicatedBy(ATOMIC, { newClaim: 'A torn index on crash is not prevented by an atomic rename', existingClaim: 'A torn index on crash is prevented by an atomic rename' }) === true,
  'a claim that restates the subject and reverses it DOES implicate (the rule did not become inert)');
ok(m.isImplicatedBy(ATOMIC, { newClaim: 'The index is written atomically', existingClaim: 'The index is written in place' }) === false,
  'overlapping vocabulary that is not the pattern\'s subject does not implicate it');
// A pattern name names the failure it fixes, so NEGATORS terms in the name are
// topic, not judgment. If they were read as judgment, "on crash" would make the
// name negative and every contradiction about it would be silently dropped.
ok(m.isImplicatedBy(ATOMIC, { newClaim: 'Atomic rename fails to prevent a torn index on crash', existingClaim: 'Atomic rename prevents a torn index on crash' }) === true,
  'a failure-verb restatement still implicates a pattern whose own name contains "crash"');
ok(m.isImplicatedBy(ATOMIC, { newClaim: 'Atomic rename prevents a torn index on crash', existingClaim: 'Atomic rename prevents a torn index on crash too' }) === false,
  'two same-polarity claims are not a contradiction, so they implicate nothing');
ok(m.isImplicatedBy(ATOMIC, 'some bare agent-authored string') === false,
  'an agent-authored string contradiction is skipped, not read as {undefined,undefined}');
ok(m.isImplicatedBy(ATOMIC, { newClaim: 'A torn index on crash is not prevented by an atomic rename' }) === false,
  'a half-record (missing existingClaim) is rejected');
ok(m.isImplicatedBy(ATOMIC, { newClaim: '', existingClaim: '' }) === false, 'empty contradiction record is inert');
ok(m.isImplicatedBy(ATOMIC, { newClaim: '   ', existingClaim: 'A torn index on crash is prevented by an atomic rename' }) === false,
  'a whitespace-only claim side is rejected');
ok(m.isImplicatedBy(ATOMIC, null) === false && m.isImplicatedBy(ATOMIC, undefined) === false,
  'a null or missing record is rejected rather than throwing');
ok(m.isImplicatedBy(ATOMIC, { newClaim: 42, existingClaim: 'x' }) === false,
  'a non-string claim side is rejected rather than coerced');
// A one-token pattern name can never share two tokens, so MIN_SHARED rejects it
// on its own — there is deliberately no second length guard to test. This pins
// the outcome that guard is supposed to produce, so the reason the branch is
// unnecessary stays visible and someone re-adding it sees why it was redundant.
ok(m.isImplicatedBy('Retry', { newClaim: 'Retry is not needed when the queue drains', existingClaim: 'Retry is needed when the queue drains' }) === false,
  'a one-token pattern name is never implicable, even at ratio 1.0 (MIN_SHARED covers it)');
// Degenerate inputs must be inert, not a division by zero or a false positive.
ok(m.isImplicatedBy('', { newClaim: '!!!', existingClaim: '???' }) === false, 'empty pattern name → inert');
ok(m.isImplicatedBy(ATOMIC, { newClaim: '!!!', existingClaim: '???' }) === false, 'no content tokens in the claim → inert');
// MIN_OVERLAP at its permissive end: a real subject conflict, but the claim
// restates only a fraction of a long pattern name. Refused, because one shared
// token out of many is not the same subject.
const LONG_ATOMIC = 'Atomic rename prevents a torn index on crash during a concurrent write';
ok(m.isImplicatedBy(LONG_ATOMIC, { newClaim: 'Writing an index crash is not sorted by date at all today', existingClaim: 'Writing an index crash is sorted by date at all today' }) === false,
  '2 shared tokens out of 6 on a long pattern name is refused (MIN_OVERLAP floor)');

// End-to-end: the substring bug demoted this pattern in the pre-fix run.
seed('2026-09-01', [ATOMIC]); seed('2026-09-02', [ATOMIC]); seed('2026-09-03', [ATOMIC]);
seed('2026-09-04', ['Deployment notes'], [{ newClaim: 'The staging index is stale', existingClaim: 'The staging index is current' }]);
const idA = 'atomic-rename-prevents-a-torn-index-on-crash';
let idxA = replay(['2026-09-01', '2026-09-02', '2026-09-03']);
ok(idxA.patterns[idA].status === 'established', '3 clean sessions establish the pattern');
idxA = replay(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
ok(idxA.patterns[idA].status === 'established', 'an unrelated "index" contradiction no longer demotes it (was: candidate)');
ok(!idxA.patterns[idA].demotedAt, 'no demotion was recorded at all');

// ── 2. Quarantine gate ──────────────────────────────────────────────────────
console.log('quarantine gate:');
seed('2026-09-10', ['Serialize the write before committing the index']);
resetIndex();
const qIdx = m.loadPatternsIndex();
qIdx.meta.quarantine = {
  reason: 'test', count: 2, quarantinedAt: '2026-09-01T00:00:00.000Z',
  restoreCommand: 'node quarantine-patterns.mjs --restore',
  patterns: { 'held-a': { name: 'held-a', sessions: ['2026-08-01'] }, 'held-b': { name: 'held-b', sessions: ['2026-08-02'] } },
};
m.savePatternsIndex(qIdx);
let threw = null;
try { m.promoteSession('2026-09-10', m.loadPatternsIndex()); } catch (e) { threw = e; }
ok(threw !== null && threw.code === 'QUARANTINED', 'promoteSession REFUSES while the corpus is quarantined');
ok(threw && /restore/.test(threw.message), 'the refusal names the restore command');
const afterRefusal = m.loadPatternsIndex();
ok(Object.keys(afterRefusal.patterns).length === 0, 'nothing was promoted — the 24-pattern hole is closed');
ok(Object.keys(afterRefusal.meta.quarantine.patterns).length === 2, 'the quarantined corpus is untouched');
ok(m.QuarantineError && new m.QuarantineError(2, 'x') instanceof Error, 'QuarantineError is a typed Error, catchable by code');
// the gate must not fire once the corpus is legitimately restored.
// removeMetaKey, NOT a bare delete: the concurrent merge reads an absent key as
// "never seen, keep the disk's copy", so a plain delete resurrected the
// quarantine from disk and left the gate stuck permanently — the save reported
// success and every later promotion still refused as QUARANTINED.
m.removeMetaKey(afterRefusal, 'quarantine');
m.savePatternsIndex(afterRefusal);
ok(m.loadPatternsIndex().meta.quarantine === undefined,
  'clearing the quarantine actually clears it (a bare delete was silently undone by the merge)');
let okNow = true;
try { m.promoteSession('2026-09-10', m.loadPatternsIndex()); } catch { okNow = false; }
ok(okNow && Object.keys(m.loadPatternsIndex().patterns).length === 1, 'after restore, promotion works normally again');

// ── 3. Scan symmetry: demote and restore cover the same set ─────────────────
console.log('scan symmetry:');
const P = 'Serialize the write before committing the index';
const idP = 'serialize-the-write-before-committing-the-index';
const CONTRA = { newClaim: 'Serializing the write before committing the index is not required under concurrency', existingClaim: 'Serializing the write before committing the index is required under concurrency' };
seed('2026-09-01', [P]); seed('2026-09-02', [P]); seed('2026-09-03', [P]);
// 09-04 contradicts it and does NOT re-invoke it
seed('2026-09-04', ['Deployment notes'], [CONTRA]);
// 09-05 re-invokes it cleanly
seed('2026-09-05', [P]);
resetIndex();
let idxS = m.loadPatternsIndex();
for (const d of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) m.promoteSession(d, idxS);
ok(idxS.patterns[idP].status === 'candidate', 'a contradiction naming an un-re-invoked pattern still freezes it');
ok(Array.isArray(idxS.patterns[idP].implicatedBy) && idxS.patterns[idP].implicatedBy.includes('2026-09-04'), 'the implicating session is recorded by date');
m.promoteSession('2026-09-05', idxS);
ok(idxS.patterns[idP].status === 'established', 'a later clean session restores it (was: stayed candidate forever)');
ok(typeof idxS.patterns[idP].restoredAt === 'string' && idxS.patterns[idP].restoredFrom === 'candidate', 'the restore records provenance: restoredFrom + restoredAt');
ok(idxS.patterns[idP].restoredReason && /2026-09-05/.test(idxS.patterns[idP].restoredReason), 'the restore reason names the evidence that cleared it');
ok(idxS.patterns[idP].demotedAt !== undefined, 'the demotion record survives the restore — nothing is deleted');
ok(idxS.meta.restorations === 1, 'restorations counted separately from demotions');
ok(idxS.meta.demotions === 1, 'exactly one demotion recorded for the one contradiction');
// 09-03 is the pattern's FIRST crossing of the threshold (never demoted) and
// 09-05 is a genuine recovery from the 09-04 freeze. Both notes must exist and
// they must be worded differently — conflating them is what made the first
// crossing claim a freeze that never happened.
ok(idxS.patterns[idP].contradictions.includes('established: cleared by evidence through 2026-09-03'),
  'the first threshold crossing is noted as "established", not "restored" (it was never frozen)');
ok(idxS.patterns[idP].contradictions.some(x => /^restored to established: cleared by evidence through 2026-09-05$/.test(x)),
  'the recovery from the 09-04 freeze is noted as a restoration');
ok(m.restorePattern(m.loadPatternsIndex(), idP) === false, 'restorePattern is a no-op on an already-established pattern');
const dIdx = m.loadPatternsIndex();
ok(m.demotePattern(dIdx, idP) === true, 'demotePattern moves an established pattern');
ok(m.demotePattern(dIdx, idP) === false, 'demotePattern is a no-op the second time');

// computeStatus is pure — same input, same answer, no clock, no call order.
const sample = { sessions: ['a', 'b', 'c'], domains: ['code', 'ops'], implicatedBy: [] };
ok(m.computeStatus(sample) === 'established', 'computeStatus: 3 sessions + 2 domains → established');
ok(m.computeStatus({ ...sample, implicatedBy: ['c'] }) === 'candidate', 'computeStatus: implicated in the latest session → candidate');
ok(m.computeStatus({ ...sample, implicatedBy: ['a'] }) === 'established', 'computeStatus: an OLDER implication is cleared by later evidence');
ok(m.computeStatus({ ...sample, sessions: ['a', 'b'] }) === 'candidate', 'computeStatus: 2 sessions → candidate');
ok(m.computeStatus({ ...sample, domains: ['code'] }) === 'candidate', 'computeStatus: 1 domain → candidate');
// The date comparison is the whole recovery rule, so pin both directions.
// Same-day freeze (im === ev) must STAY frozen: a session that both re-invoked
// and contradicted a pattern has not resolved anything.
ok(m.computeStatus({ sessions: ['a', 'b', 'c'], domains: ['code', 'ops'], implicatedBy: ['c'] }) === 'candidate',
  'computeStatus: a freeze raised in the SAME session as the latest evidence stays frozen (im === ev)');
ok(m.computeStatus({ sessions: ['a', 'b', 'c', 'd'], domains: ['code', 'ops'], implicatedBy: ['c'] }) === 'established',
  'computeStatus: evidence strictly after the freeze clears it');
ok(m.computeStatus({ sessions: ['a', 'b', 'c'], domains: ['code', 'ops'], implicatedBy: ['z'] }) === 'candidate',
  'computeStatus: a freeze dated AFTER the last evidence still holds');
ok(m.computeStatus({ sessions: [], domains: [], implicatedBy: ['a'] }) === 'candidate', 'computeStatus: no evidence → candidate');
ok(m.computeStatus({ sessions: ['a', 'b', 'c'], domains: ['code', 'ops'] }) === 'established', 'computeStatus: no implicatedBy field at all → established');

// Consolidation must not be able to silently un-freeze a contradicted pattern.
// Note what is NOT asserted here: any merge of the implicatedBy field. That
// path is unreachable — consolidation runs before the implicature pass, and
// that pass re-evaluates every pattern in the index under its own name on the
// same promote — so a test for it would pass whether or not the merge existed.
// Mutation testing confirmed it: deleting the merge leaves this file green.
// The invariant worth pinning is the one an operator can observe.
resetIndex();
seed('2026-09-01', ['Serialize the write before committing the index']);
seed('2026-09-02', ['Serialize writes before committing the index']);
let idxC = replay(['2026-09-01', '2026-09-02']);
ok(Object.keys(idxC.patterns).length === 1, 'two name-variants consolidate into one entry');
seed('2026-09-03', ['Deployment notes'], [CONTRA]);
resetIndex();
idxC = replay(['2026-09-01', '2026-09-02', '2026-09-03']);
ok(idxC.patterns[idP] && idxC.patterns[idP].status === 'candidate',
  'a consolidated, previously-frozen pattern is still frozen by a later contradiction');
ok(Object.values(idxC.patterns).every(p => (p.implicatedBy || []).length > 0 || p.status === 'candidate' || (p.sessions?.length || 0) < 3),
  'no pattern claims established status while carrying an unreviewed implication');

// ── 4. The oracle: replay order must not change the outcome ─────────────────
console.log('idempotency oracle:');
seed('2026-09-20', [P]); seed('2026-09-21', [P]); seed('2026-09-22', [P]);
seed('2026-09-23', [P], [CONTRA]);
seed('2026-09-24', [P]);
const fwd = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'];
const forward = replay(fwd);
const back = replay([...fwd, '2026-09-23']);            // replay the contradicting session last
ok(observable(forward) === observable(back), 'replaying the contradicting session again does NOT diverge (was: established → candidate)');
const rev = replay([...fwd].reverse());               // reverse chronological
ok(observable(forward) === observable(rev), 'reverse-chronological replay converges on the same state');
const twice = replay([...fwd, ...fwd]);
ok(observable(forward) === observable(twice), 'running the whole history twice is a no-op');
const contradictionNotes = (p) => p.contradictions.filter(x => /^unresolved contradiction in session /.test(x));
ok(contradictionNotes(forward.patterns[idP]).length === 1, 'exactly one contradiction note survives repeated replays');
ok(contradictionNotes(forward.patterns[idP]).length === contradictionNotes(twice.patterns[idP]).length,
  'replaying the full history twice adds no contradiction notes');
ok(forward.patterns[idP].contradictions.length === twice.patterns[idP].contradictions.length,
  'the whole audit trail is byte-identical after a double replay');

rmSync(tmp, { recursive: true, force: true });
done();
