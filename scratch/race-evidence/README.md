# Lost-update race: evidence

Task t_d2dc7378. Two distinct defects, both in the concurrent read-modify-write
path that guards the patterns index. All numbers below were produced by the
scripts in this directory on an M4 Mac Mini (macOS 26.3, node v26.5.1).

## Defect 1 — the pre-fix lost update (the one the audit found)

8 barriered writer processes, each adding one pattern. Reproduced against the
parent of the fix, `a770582`, using the CURRENT harness and the CURRENT
regression test so the measurement isolates the historical source defect:

    1-7 of 8 patterns persisted, mode 3, over 120 runs
      distribution: 1x6  2x22  3x50  4x30  5x9  6x2  7x1

Four different ranges had been published for this one race (sentry's audit said
3-7, the CHANGELOG said 2-5, an earlier README pass said 1-5, and the code
comment said "5 of 8"). None of them was reproducible as stated, because the
count is a race outcome and moves with scheduling. Every doc now gives the
measured range over 120 runs instead of a single figure.

A SECOND race had the same shape of error. The shared fixed temp path was
documented as "600 of 3000 patterns surviving" in src/polymem.mjs and in the
CHANGELOG. Measured over 30 runs at `322eb1f~1`, with 5 concurrent processes x
600 patterns, it ranged 600-2400 (most often 1200) — 1 to 4 of the 5 writers
represented. The 600 was the single worst run, presented as the invariant.

## Defect 2 — the fix's own TOCTOU (found while verifying defect 1)

After the fix, 8/8 landed in 79 of 80 runs. One run lost a write with **all
eight writers reporting saved:true** — silent loss with a success code.

Cause, isolated by instrumenting the claim file (`instr3`) and then labelling
every staleness branch (`instr4`/`branch`):

    acquireClaim:  if (isClaimStale(claim)) { try { unlinkSync(claim); } ... }

`isClaimStale` returned true when the claim could not be stat'd at all ("vanished
under us"). That is not evidence of an abandoned claim — it is evidence that the
writer raced the holder's release. The unlink it authorised deleted whatever
claim was at the path by then, frequently a different LIVE holder. Two writers
inside the "exclusive" section is defect 1, reintroduced inside its own fix.

Correlation across 40 runs — every lost-write run is exactly a run with a
duplicate read count, i.e. two writers inside at once:

    runs with duplicate read count == runs that lost a write   TRUE

`STALE-VANISHED-TRUE` fired 19 times; every lossy run was among them.

`poc-claim-toctou.mjs` demonstrates the mechanism deterministically, with no
need to win a scheduling race.

## The fix

Two parts:
1. A claim that cannot be identified is no longer treated as abandoned. It is
   contention; the O_EXCL create is retried, which is the correct response.
2. Breaking a claim is now conditional: the claim is re-read and unlinked ONLY if
   it is still byte-for-byte the claim that was judged stale
   (`breakClaimIfUnchanged`).

Honest scope: read-compare-unlink is not itself atomic, so this narrows the race
window rather than proving it closed. The comment in the source says exactly
this and says not to upgrade the claim without a measurement that shows it.

## Measurement after the fix

    8 barriered writers, 80 runs: 8 of 8 in 80 of 80 runs

Before: 8/8 in 37 of 40. `npm test`: 440 assertions, 0 failing (437 + 3 new).

## The regression test discriminates

A test that cannot fail on the buggy code is decoration. Verified in both
directions:

| module under test            | result                            |
|------------------------------|-----------------------------------|
| genuine pre-fix (`HEAD`)     | 3 FAILED (`claimSurvived=false`)  |
| fixed                        | all pass (`claimSurvived=true`)   |

`breaker-diff.mjs` is the standalone version of that comparison: same input
(unparseable claim, 120s old mtime), opposite outcomes — pre-fix deletes the
claim and lands the write in 153ms; fixed refuses with contention.

## Not caused by this change

`test-trust-integrity.mjs` (a sibling work-in-progress suite, untracked at the
time) fails on 6 assertions — W1/B4/B5 features and an unregistered-suite
floor. It fails identically on pristine `HEAD`. The B4 timing assertion is
PRE-EXISTING and slightly better with this fix: 4590ms here vs 5022ms on
genuine pre-fix.
