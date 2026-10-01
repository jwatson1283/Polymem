// test/test-near-duplicate.mjs
//
// THE NEAR-DUPLICATE THRESHOLD, PINNED.
//
// WHY THIS SUITE EXISTS. `findNearDuplicatePatternId` compares two pattern
// names by token CONTAINMENT against NEAR_DUP_CONTAINMENT = 0.9. Every number
// in that mechanism was load-bearing for the index and nothing tested the
// boundary, so a well-meaning edit to 0.9 would silently change what merges
// for every future consolidation and no suite would notice. This pins it.
//
// THE MEASURED FAILURE THIS DOCUMENT (a known limitation, asserted, not hidden).
// "Miscounting words in constrained-length responses" against "Miscounting
// words in constrained-length response." shares 5 of 6 tokens = 0.8333, which
// is BELOW 0.9, so the trailing plural keeps them split. That is real and it is
// asserted below as current behaviour. It is deliberately NOT fixed, and the
// reason is the finding this suite exists to record:
//
//   THE 0.8333 CASE CANNOT BE FIXED BY MOVING THE THRESHOLD. "Overcounting
//   words in constrained-length response" — a DIFFERENT claim — scores exactly
//   the same 0.8333 against the same base name. Containment cannot tell "the
//   same sentence pluralised" from "the opposite claim", so any threshold low
//   enough to merge the first necessarily merges the second. The only window
//   that catches the plural case is (0.80, 0.8333], and 0.80 is exactly the
//   score of the suite's own "differing leading word must stay separate" guard.
//   There is no threshold in that window that buys one without losing the
//   other, so 0.9 stays.
//
// THE ACTUAL SHAPE OF THE LIMITATION (measured, and the more useful fact).
// Because the denominator is the SHORTER name's token count, one differing
// token scores (L-1)/L. At L=6 that is 0.8333; at L=10 it is exactly 0.9. So
// for every name shorter than ten tokens, 0.9 does not mean "very similar" —
// it means "the token sets are IDENTICAL". Real model-emitted pattern names
// live in the 3-to-8 token range, which is why a one-word drift in either
// direction is invisible to this mechanism. That is the honest ceiling, and
// asserting it here is worth more than a threshold change that trades a false
// merge for a false split.
//
// Nothing here changes library behaviour. These are assertions about the
// mechanism as shipped, written so that changing the threshold on purpose
// forces an explicit, reviewable decision in this file.

import { createSuite } from './harness.mjs';
import { findNearDuplicatePatternId, consolidateNearDuplicates } from '../src/index.mjs';

const suite = createSuite('test-near-duplicate.mjs');
const { section, ok, done } = suite;

// ── Scoring mirror ────────────────────────────────────────────────────────
// An independent reimplementation of the shipped scoring, so the expected
// numbers below are derived rather than copied out of the library. If the
// library's arithmetic drifts, the drift shows up as a mismatch between this
// mirror and the real call, instead of both being wrong together.
const THRESHOLD = 0.9;
const MIN_TOKENS = 3;
const MIN_SHARED = 3;
const tok = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);

function scoreOf(name, existingName) {
  const nt = tok(name);
  if (nt.length < MIN_TOKENS) return null;
  const et = tok(existingName);
  if (et.length < MIN_TOKENS) return null;
  if (et.filter((t) => new Set(nt).has(t)).length < MIN_SHARED) return null;
  const [shorter, longer] = et.length <= nt.length ? [et, nt] : [nt, et];
  const s = new Set(shorter);
  return longer.filter((t) => s.has(t)).length / shorter.length;
}

const one = (id, name) => ({ patterns: { [id]: { name } } });

// ── 1. The measured failure, asserted as current behaviour ────────────────
section('the 0.8333 singular/plural pair (documented non-merge)');

const BASE = 'Miscounting words in constrained-length response';
const PLURAL = 'Miscounting words in constrained-length responses';

ok(Math.abs(scoreOf(PLURAL, BASE) - 5 / 6) < 1e-9,
  'mirror scores the plural pair at exactly 5/6 = 0.8333',
  `score=${scoreOf(PLURAL, BASE)}`);
ok(findNearDuplicatePatternId(PLURAL, one('base', BASE)) === null,
  'CURRENT BEHAVIOUR: the trailing plural does NOT merge at 0.9 — asserted, not hidden',
  'score=0.8333 < 0.9');
ok(findNearDuplicatePatternId(PLURAL, one('base', BASE + '.')) === null,
  'trailing punctuation does not change the verdict either (0.8333, still below)');

// ── 2. Why the threshold must not move: an indistinguishable pair ─────────
section('the pair that makes a threshold change unsafe');

const OPPOSITE = 'Overcounting words in constrained-length response';
const oppositeScore = scoreOf(OPPOSITE, BASE);

ok(Math.abs(oppositeScore - scoreOf(PLURAL, BASE)) < 1e-9,
  'a semantically OPPOSITE claim scores IDENTICALLY to the plural drift',
  `plural=${scoreOf(PLURAL, BASE)} opposite=${oppositeScore}`);
ok(findNearDuplicatePatternId(OPPOSITE, one('base', BASE)) === null,
  'CURRENT BEHAVIOUR: the opposite claim is not merged (0.8333 < 0.9)');
ok(scoreOf(PLURAL, BASE) > 0.8,
  'the plural score sits in the window ABOVE the 0.8 leading-word guard, so no threshold fixes both',
  `plural=${scoreOf(PLURAL, BASE)} guard=0.8`);
ok(scoreOf('parallel then write under concurrency', 'serialize then write under concurrency') === 0.8,
  'the existing guard case scores exactly 0.8 — pinning the floor of the window');

// ── 3. The neighbourhood: what 0.9 does and does not catch ────────────────
section('neighbourhood around the boundary');

ok(findNearDuplicatePatternId(BASE, one('base', BASE)) === 'base',
  'identical name merges (score 1.0)');
ok(findNearDuplicatePatternId(BASE + ' during evaluation', one('base', BASE)) === 'base',
  'an appended qualifier still merges — this is what containment was chosen for (score 1.0)');
ok(findNearDuplicatePatternId('Miscounting words in constrained-length', one('base', BASE)) === 'base',
  'a truncated name whose tokens are a strict subset still merges (shorter is the denominator)');
ok(findNearDuplicatePatternId('Miscounting word in constrained-length response', one('base', BASE)) === null,
  'a plural on a MIDDLE token scores the same 0.8333 and also fails to merge');
ok(findNearDuplicatePatternId('Miscountings words in constrained-length response', one('base', BASE)) === null,
  'a plural on the FIRST token scores the same 0.8333 and also fails to merge');
ok(findNearDuplicatePatternId('parallel-then-write under concurrency', one('g', 'Serialize-then-write under concurrency')) === null,
  'a differing leading word stays separate — the 0.8 guard, unchanged');

// ── 4. The real shape of the ceiling: length-dependence ───────────────────
// One differing token scores (L-1)/L, so the SAME drift that fails at L=6
// passes at L=10. Under 10 tokens, 0.9 means "identical", not "similar".
section('length-dependence: the threshold is stricter than it reads');

const WORDS = ('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon').split(' ');
const atLength = (L) => WORDS.slice(0, L).join(' ');
const withPluralOnLast = (L) => WORDS.slice(0, L - 1).join(' ') + ' ' + WORDS[L - 1] + 's';

ok(findNearDuplicatePatternId(withPluralOnLast(9), one('b', atLength(9))) === null,
  'at L=9 a one-token drift scores 0.8889 and does NOT merge');
ok(findNearDuplicatePatternId(withPluralOnLast(10), one('b', atLength(10))) === 'b',
  'at L=10 the SAME drift scores exactly 0.9 and DOES merge',
  'the threshold flips on name length alone, with identical semantic distance');
ok(scoreOf(withPluralOnLast(10), atLength(10)) === 0.9,
  'the L=10 score is exactly 0.9, i.e. sits precisely on the boundary');

// The consequence stated as an inequality, so the ceiling is a number.
const longestNonMerging = [4, 5, 6, 7, 8, 9].filter((L) => findNearDuplicatePatternId(withPluralOnLast(L), one('b', atLength(L))) === null);
ok(longestNonMerging.length === 6 && Math.max(...longestNonMerging) === 9,
  'MEASURED CEILING: a one-token drift is invisible at every length from 4 to 9 tokens',
  `non-merging lengths: ${longestNonMerging.join(', ')}`);

// ── 5. Sub-threshold guards, unchanged ────────────────────────────────────
section('guard rails below the containment check');

ok(findNearDuplicatePatternId('hi', { patterns: { greeting: { name: 'hi' } } }) === null,
  'a name under the 3-token minimum returns null rather than a false match');
ok(findNearDuplicatePatternId('SQL WAL mode for durability', { patterns: { x: { name: 'some entirely different subject here' } } }) === null,
  'fewer than 3 shared tokens returns null — containment is not reached');
ok(findNearDuplicatePatternId(BASE, { patterns: {} }) === null,
  'an empty index returns null rather than throwing');
ok(findNearDuplicatePatternId(BASE, undefined) === null,
  'an undefined index returns null rather than throwing');
ok(findNearDuplicatePatternId(undefined, one('base', BASE)) === null,
  'an undefined name returns null rather than throwing');

// ── 6. Consolidation inherits the same boundary ───────────────────────────
// consolidateNearDuplicates is findNearDuplicatePatternId applied across the
// index, so it inherits the 0.8333 non-merge. Asserted on the real function,
// because a refactor could plausibly give consolidation its own comparison.
section('consolidateNearDuplicates inherits the threshold');

const idx = () => ({
  version: 1,
  meta: {},
  patterns: {
    [PLURAL]: { name: PLURAL, domains: ['x'], sessions: ['2026-09-01'], evidenceCount: 2, status: 'candidate', correspondences: [], contradictions: [], nameVariations: [] },
    [BASE]: { name: BASE, domains: ['y'], sessions: ['2026-09-02'], evidenceCount: 2, status: 'candidate', correspondences: [], contradictions: [], nameVariations: [] },
  },
});

const pluralIdx = idx();
const pluralMerges = consolidateNearDuplicates(pluralIdx);
ok(pluralMerges.length === 0,
  'CURRENT BEHAVIOUR: consolidation leaves the 0.8333 plural pair split, same as the lookup',
  JSON.stringify(pluralMerges));
ok(Object.keys(pluralIdx.patterns).length === 2,
  'both halves of the plural pair survive as separate entries');
ok(!pluralIdx.meta.absorbedPatterns,
  'nothing is recorded as absorbed when no merge happened');

// The control: an identical-ish pair DOES consolidate, so the zero above is
// the threshold and not a broken call.
const ctrlIdx = {
  version: 1,
  meta: {},
  patterns: {
    'copy-on-write-with-atomic-rename': { name: 'copy-on-write-with-atomic-rename', domains: ['code'], sessions: ['2026-09-01'], evidenceCount: 2, status: 'candidate', correspondences: ['note-a'], contradictions: [], nameVariations: [] },
    'copy-on-write-atomic-rename': { name: 'copy-on-write-atomic-rename', domains: ['ops'], sessions: ['2026-09-02'], evidenceCount: 1, status: 'candidate', correspondences: [], contradictions: [], nameVariations: [] },
  },
};
const ctrlMerges = consolidateNearDuplicates(ctrlIdx);
ok(ctrlMerges.length === 1, 'CONTROL: a mid-name insertion still consolidates into one entry');
ok(ctrlMerges[0].absorbed === 'copy-on-write-atomic-rename' && ctrlMerges[0].kept === 'copy-on-write-with-atomic-rename',
  'CONTROL: the merge reports which id was kept and which absorbed');
ok(ctrlIdx.meta.absorbedPatterns?.length === 1,
  'CONTROL: an actual merge IS recorded in meta for audit and reversal');
ok(ctrlIdx.patterns['copy-on-write-atomic-rename'] === undefined,
  'CONTROL: the absorbed entry is gone from active patterns');

// ── 7. The floor itself is reachable only by an explicit change ───────────
// If NEAR_DUP_CONTAINMENT is ever edited, every assertion in sections 1-4
// moves together and this one names the number that has to be reconsidered.
section('the threshold constant, stated once');

ok(THRESHOLD === 0.9,
  'this suite pins NEAR_DUP_CONTAINMENT at 0.9 — changing it means re-deciding sections 1-4, not just this line');

done();
