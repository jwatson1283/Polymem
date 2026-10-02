// test/suite-floors.mjs
//
// THE FLOOR TABLE — the reason a gutted suite cannot pass quietly.
//
// THE BUG THIS EXISTS TO KILL. Every suite is a hand-rolled script that ended
// in `process.exit(fail ? 1 : 0)`. Nothing anywhere counted assertions. So:
//
//   : > test/test-prototype-key-safety.mjs     # truncate to ZERO bytes
//   npm test                                    -> exit 0. "Passing."
//
// An empty file runs, asserts nothing, exits 0. Anyone could delete every
// assertion in a suite and the whole run stays green. That is the worst class
// of test bug: not a false failure, a false PASS. The guard is believed and
// does nothing.
//
// WHY THE FLOOR LIVES HERE, AND NOT INSIDE A SUITE. The obvious fix is to add
// `if (pass < 50) fail++` at the bottom of each suite. That fix does not work.
// Truncating a suite to zero bytes deletes that check along with the
// assertions — the guard protects only against the assertions being removed
// while the guard survives, which is exactly the case nobody performs by
// accident. The check has to live in something the gutting does not touch.
// Hence a shared table, enforced by the runner (primary) and re-checked by the
// harness when a suite runs standalone (secondary). Neither is inside a suite.
//
// WHY THESE ARE EXACT COUNTS, NOT ROUNDED-OUT FLOORS. Each number below is
// the suite's real measured assertion count, not a lower bound with slack.
// Slack is the weakness: a floor of 50 against a suite of 57 lets someone
// delete 7 assertions and stay green, which is the same false pass at a
// smaller scale. At the exact count, the ONLY edit that keeps the suite green
// is ADDING assertions. Removing one fails.
//
// That friction is the feature. If a suite legitimately needs fewer
// assertions, that is a real change to coverage and it must show up as a
// deliberate, reviewable edit to this file in the diff — not slip through
// silently as a deleted test nobody noticed was the only thing testing the
// thing. Weakening a floor is possible; it just can't be invisible.
//
// The task brief suggested looser floors (test-memory >= 50,
// test-promotion-idempotency >= 55, others >= 5). Those would each permit
// silently deleting 5-7 assertions, so they are deliberately NOT used. Recorded
// here as a disagreement with the brief, with the reason.
//
// Adding a suite: add a row. The runner fails an unregistered suite, so a new
// suite cannot ship without a floor.

export const SUITE_FLOORS = {
  // name (test/*.mjs)          measured
  // The claim-path half of the 2026-09-25 defect. The OTHER half is
  // test-real-corpus.mjs (patterns); this one is claims, and the two defects
  // share a causal chain that neither suite could see alone: an ungated claim
  // becomes half of a contradiction record, and the implicature pass then
  // FREEZES real knowledge on it. So this suite asserts the middle link
  // directly — noise claims raise nothing — not just that noise is filtered.
  // Verified by mutation, six ways, every one measured rather than asserted:
  //   write-path gate removed            → 10 fail
  //   promotion-path gate removed        →  4 fail
  //   gate ALWAYS rejects                →  5 fail
  //   gate checks newClaim only          →  2 fail
  //   `seen` seeded per-SESSION          →  2 fail
  //   provenance OVERWRITES instead of
  //   fill-only                          →  1 fail
  // The first two are the defect itself and are independent: the promotion arm
  // is the only one that heals the 449 records already on disk, and the write
  // arm is the only one that keeps the corpus from refilling. The blanket-reject
  // mutation is the direction a naive test cannot catch — every "noise was
  // dropped" assertion is satisfied by a filter that drops everything — which is
  // why the knowledge-side and legitimate-contradiction assertions exist.
  'test-claim-gate.mjs':           47,
  // A NEGATIVE-RESULT suite, which is the hardest kind to write honestly. It
  // measures cross-session diversity (distinct (taskId, session) pairs per
  // name) and shows the signal cannot separate noise from knowledge: on the
  // fixture a "require 2+ dispatches" rule removes 15/15 noise while costing
  // 6/8 knowledge, and ALL 15 of that noise is already rejected by the shipped
  // lexical gate — so marginal value is 0 rescued vs 6 destroyed.
  //
  // Its most important assertions are the CONTROLS. A suite that concludes
  // "signal X does not separate" passes forever if the measuring code reads
  // nothing, which is the exact bug this suite's first draft had. So it builds
  // a corpus where the signal DOES separate (noise once, knowledge three times)
  // and fails if the same arithmetic cannot detect that. A negative result
  // whose test cannot detect a positive one is a no-op in a costume.
  //
  // Verified by mutation (10 mutants, all caught except one, documented in the
  // suite). The most important mutant forces every distinct-pair count to 1 —
  // the vacuous reading that would make this entire conclusion unfalsifiable;
  // it fails 6. The suite also holds when all six conclusion assertions are
  // inverted at once (5 failures), so no single edit can quietly reverse the
  // verdict. The one surviving mutant weakens a redundant assertion
  // (`keepLost > 0`); the refusal is independently pinned by
  // `keepLost > netRescued`, which is why the suite still fails when that one
  // is weakened too.
  'test-cross-session-diversity.mjs': 44,
  'test-concurrent-writes.mjs':      13,
  'test-concurrency-rmw.mjs':       23,
  'test-encryption-at-rest.mjs':    66,
  // The anti-forgery regression. This suite is what keeps the coverage gate
  // from being "simplified" away: it forges a result line in a throwaway repo
  // and asserts the runner refuses it. Gutting this suite would reopen the
  // hole, which is why it has a floor like anything else.
  'test-forged-suite-detection.mjs': 11,
  'test-memory-index-location.mjs':   8,
  // Six trust-model defects, each proven to fail before its fix. The floor is
  // the count that must survive: if a later edit silences one of these
  // assertions the suite fails loudly instead of quietly losing a guarantee.
  'test-trust-integrity.mjs':       68,
  'test-memory.mjs':                 57,
  // Pins NEAR_DUP_CONTAINMENT = 0.9 and the boundary it produces. The
  // interesting property is that it catches a threshold change in BOTH
  // directions, and that this is deliberate: the 0.8333 singular/plural
  // non-merge is asserted as CURRENT behaviour because lowering the
  // threshold to catch it would also merge a semantically opposite claim
  // that scores identically (0.8333), and 0.80 — the existing "differing
  // leading word must stay separate" guard — is the floor of that window.
  // The fix is therefore not available at ANY threshold; see the header
  // comment of the suite. Verified by mutation: 0.8 fails 8 assertions,
  // 0.95 fails 1, and swapping the shorter/longer denominator (the original
  // defect) fails 3.
  'test-near-duplicate.mjs':         30,
  'test-promotion-idempotency.mjs':  61,
  'test-prototype-safety.mjs':       19,
  // The ONLY suite that asks "is the resulting index worth reading?" rather
  // than "did each mechanism work?". Every other suite was green while
  // "casual-greeting" sat in a live index, because they test mechanisms and the
  // defect was in the composition. Verified by mutation: reverting the
  // promoteSession gate fails 7 of these 42, and over-filtering (a gate that
  // always rejects) fails 3 — so it catches both directions, not just the one
  // that was broken.
  'test-real-corpus.mjs':            46,
  'test-repo-root-containment.mjs':   5,
  'test-session-date-containment.mjs':14,
  'test-working-memory-location.mjs': 7,
  // Four intake defects from the persona simulation, each proven to fail before
  // its fix (26 of these 40 assertions failed on the unpatched module). The
  // floor is the full count because the controls are load-bearing: without them
  // a parser that returned null for everything would satisfy every "does not
  // lose memory" assertion in the suite.
  'test-memory-intake.mjs':          40,
};

// Net across the whole run. The per-suite floors catch a suite whose
// assertions were gutted; these two catch the case the per-suite floors
// structurally CANNOT see.
//
// DELETING AN ENTIRE SUITE is invisible to per-suite floors — remove a file
// and the remaining ones all still clear their own floors, so the run is green
// with a hole in it. A total-assertion floor and a suite-count floor close
// that. Between them: gutted suite, deleted suite, and a new suite that was
// never registered all fail loudly.
//
// BOTH FLOORS ARE PINNED TO THE MEASURED COUNT, and they have to stay that
// way. These were 440 / 14 against a real 548 / 16 — slack of 108 assertions
// and TWO whole suites, so `rm test/test-repo-root-containment.mjs` left
// `npm test` green, and so did deleting a second suite after it. A floor that
// rots upward is worse than no floor at all: every suite added without
// raising it widens the hole, and nothing announces the decay. `docs:check`
// caught it, but only because the README quotes a measured count — that is
// the compound net working by accident, not this floor doing its job.
//
// So: anyone who adds a suite raises SUITE_COUNT_FLOOR in the same commit.
// That is the friction this file already argues for, not a new cost of it —
// and CONTRIBUTING.md's PR checklist asks for exactly this.
export const TOTAL_ASSERTION_FLOOR = 559;
export const SUITE_COUNT_FLOOR = 17;

// Files in test/ that are machinery, not suites. Listed explicitly so the
// runner can require every OTHER *.mjs to be a real `test-*.mjs` suite —
// otherwise a suite named `foo.mjs` would be silently skipped, which is the
// "developer forgets to register it" failure GAP 3 is about, re-entering
// through the back door.
export const NON_SUITE_FILES = new Set([
  'harness.mjs',
  'suite-floors.mjs',
  'run-tests.mjs',
  // The anti-forgery gate. Machinery: it reads coverage profiles and decides
  // whether a suite ran the library. It asserts nothing about the library, so
  // it is not a suite and must not be counted as one.
  'coverage-gate.mjs',
]);

export const SUITE_GLOB_PREFIX = 'test-';
