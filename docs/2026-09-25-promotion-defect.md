# The 2026-09-25 promotion defect — BEFORE / AFTER

Every number below was produced by `tools/real-corpus-probe.mjs`, run twice:
once in a `git worktree` at `7e7da33` (the pre-fix HEAD) with the fixture and
probe copied in, and once at `c0cec54`. Nothing here is remembered.

## Reproduce it

```bash
node tools/real-corpus-probe.mjs                  # AFTER (current HEAD)
git worktree add /tmp/pm-before 7e7da33
cp -r test/fixtures /tmp/pm-before/test/
mkdir -p /tmp/pm-before/tools && cp tools/real-corpus-probe.mjs /tmp/pm-before/tools/
cd /tmp/pm-before && node tools/real-corpus-probe.mjs   # BEFORE
```

The probe exits 0 either way — it is measurement, not a gate. The assertions are
`test/test-real-corpus.mjs`, which does gate.

## The two obligations

| | BEFORE (`7e7da33`) | AFTER (`c0cec54`) |
|---|---|---|
| **1. knowledge survives** | 8/8 kept | 8/8 kept |
| **2. noise rejected** | **0/15** — 15 promoted | **15/15** — 0 promoted |
| patterns promoted | 24 from 26 names | 8 from 26 names |
| `query("greeting")` | 6 results | 0 results |
| `query("word count")` | 4 results | 0 results |
| `query("deploy dirty tree")` | 2 results (one was "Running the deploy checks now") | 1 result |
| `query("serialize concurrency")` | 1 result | 1 result |
| provenance on promoted patterns | 0/5 auditable | 5/5 auditable |

Verdicts, verbatim:

```
< VERDICT: 0 knowledge lost, 15 noise promoted, 0 noise untested.
> VERDICT: both obligations met, and every MUST_DROP item was actually tested.
```

Obligation 1 is unchanged on purpose. The fix cost no knowledge.

## What was actually wrong

Two defects, both verified against the real corpus rather than reasoned about.

**1. The gate was never called by the library.** `assessClaim` was exported and
re-exported, with **zero callers inside `polymem.mjs`**. It was a filter the
consumer had to remember to invoke. Run its six existing families over the 24
patterns the quarantine actually held and **16 were accepted**, including
`casual-greeting`, `standard-greeting`, `five-word-salutation` and
`direct-minimal-response-to-simple-greetings`.

`promoteSession` now calls `assessPatternName` on every session pattern itself.
The filter is structural rather than advisory — the same reasoning as the
repo-root containment check: *"remember to set it" is a wish, not a control.*

Rejections land in `index.meta.patternGate` as `{accepted, rejected, byReason}`
rather than being deleted, so an operator can see what was dropped and why.

**2. Promoted patterns carried no provenance.** Claims got it from
`stampProvenance`; patterns got none. Auditing a promoted pattern meant
re-reading session files by hand — which is how 24 patterns ended up needing
manual adjudication. Now each field is read off the session entry that carried
the pattern and stored as `p.sources`.

Carried, not inferred: `working-2026-09-25.json` has `taskId` on 182/182 entries
and `model` on 0/182 (the provider string embeds the model), so `sources[].model`
reads `"unknown"` on real data. Filling it in would be fabricating attribution —
the longcat defect, unrecognised.

## Why the filter rejects what it rejects

Measured over the 85 real quarantined pattern names: **0 of 85 name a person,
project, file, or system.** They describe the exchange, not the work. The
pre-existing six families caught 3 of 85 — the word-counting
`selfOutputQuality` class. They cannot catch `"Casual greeting"`, which is not an
event log, a request log, or infrastructure; it is a subject with nothing behind
it. So the seven added families reject on **subject**, not phrasing:

`greeting`, `acknowledgment`, `taskRestatement`, `transientStatus`,
`preferenceWithoutSubject`, `selfDirectedOutput`, `conversationSubject`, plus
`dispatchMachinery` — a length test (≤4 content tokens **and** a machinery
noun) rather than a phrase list.

Two are anchored so they cannot eat knowledge: `transientStatus` is anchored on
the present progressive (*"Deploy checks completed before the release was cut"*
survives), and `selfDirectedOutput` is `^…$`-anchored (*"Response caching
invalidates on schema change"* is untouched).

## The ceiling, measured rather than hand-waved

Over the real 85 the rules reject **74**; **11 survive**.

An earlier version of this document reported 22 survivors and called all 22
"false negatives". That label was wrong, and it had been asserted in a test,
which is worse than the mistake — it locked a bad judgement in place. Auditing
the 22 splits them:

**7 that are still noise:**
`System recovery check` · `Clear communication pattern` ·
`Factual accuracy error` · `Information synthesis pattern` ·
`Incomplete adherence to specifications` · `Local-first AI agents explanation` ·
`Progress tracking across parallel workstreams.`

**4 that are plausibly good knowledge, and must never be tightened away:**
`Intra-session contradiction tracking` (a feature of this very library) ·
`Chief of Staff handles simple direct requests without delegation` ·
`Edge computing architecture prioritizes privacy, latency, and offline
resilience` · `Generate and review code snippets`

The 7 cannot be removed without taking the 4 with them. `System recovery check`
and `Clear communication pattern` are structurally identical to `Code Review`,
which *is* caught — there is no line between them that does not also take real
knowledge.

Three narrow shapes got the residual from 22 to 11 at zero knowledge cost
(`echoArtifact`, `nominalizedActivity`, `bareProcessLabel`, all behind a
predicate veto). A broader "no finite verb" rule was measured and **rejected**:
it caught 4 and destroyed `Intra-session contradiction tracking`. That is the
whole argument of this exercise in one measurement — a rule that trades real
knowledge for noise is a bad trade however good the headline number looks.

The knowledge side was checked against 15 items: the fixture's 8, the quarantine
audit's 3, and **3 real facts read from Josh's own memory files** (the
launchd/Telegram-token collision, the `fallback_providers` list-vs-string gotcha,
the gateway restart requirement). Third-party text I did not write, which makes
it a better benchmark than my own fixture.

## Verification by mutation

The suite was checked by breaking the library on purpose:

| Mutation | Result |
|---|---|
| `promoteSession` gate removed (the original defect) | **7 of 42 fail** — all 15 noise names re-promote, `query("greeting")` → 6 hits, `patternGate` reads `{"accepted":26,"rejected":0}` |
| gate always **rejects** | **3 fail** — all 8 knowledge items lost. This is the direction a naive test cannot catch: a filter that rejects everything satisfies every "noise was dropped" assertion. |
| widen `nominalizedActivity` to `tracking` + drop the predicate veto | **3 fail**, naming the knowledge it ate |
| `p.sources` stripped | **1 fails** — 6 patterns lose their audit trail |

## The control that could not fail

The first draft of the fixture kept `MUST_DROP` in a separate list that was never
emitted in any session, so the probe scored **"rejected 15/15"** by measuring
*absence from the corpus* rather than gate behaviour. Every `MUST_DROP` name is
now emitted verbatim in a session, the probe tracks what was actually offered, and
three assertions fail fast if any `MUST_KEEP`/`MUST_DROP` name was never fed to
the library — that class of no-op cannot ship again.

## Suite

`316 assertions across 11 suites, 0 failing` (was 270/10). The new suite is
registered in `test/suite-floors.mjs` at its exact count of 46;
`TOTAL_ASSERTION_FLOOR` 270 → 316, `SUITE_COUNT_FLOOR` 9 → 11. No existing
assertion was weakened.

---

# The claim path — the half of this that was never fixed

The document above fixed **patterns**. It says so explicitly, at line 53:
"`promoteSession` now calls `assessPatternName` on every session pattern
itself." The same sentence was true, and still is, of nothing else.

`assessClaim` had **zero callers inside `polymem.mjs`** — the identical defect,
one layer down, in the file the previous fix had already proven could hold it.
It was exported, re-exported through `src/index.mjs`, and invoked by consumers
who had to remember. `appendWorkingMemory` did not remember.

## What that cost, measured rather than argued

The 1083 real claims were written unfiltered. Replaying all 9 sessions through
`promoteSession`, with and without a gate at the write path:

| | ungated | gated |
|---|---|---|
| patterns promoted | 474 | **474** |
| patterns frozen (`implicatedBy` non-empty) | **157** | **63** |
| established | 1 | 1 |
| contradiction records | 568 | 257 |

474 is the number that matters: **the gate cost zero patterns.** It removed 94
freezes and promoted nothing new, which is the same "obligation 1 unchanged on
purpose" result the pattern fix reported.

## The middle link is the finding

An ungated claim does not merely sit in a file being untidy. It becomes **half
of a contradiction record**, the implicature pass tests that record against
every pattern in the index, and the patterns it implicates are frozen —
permanently demoted to `candidate`, with a `demoted` note and no way back
except later clean evidence.

Of the 157 frozen patterns, **94 are implicated only by contradictions whose
claim text the gate rejects.** No clean contradiction touches them at all.

And the set is not all noise. `Chief of Staff handles simple direct requests
without delegation` is item #2 of the four that section "The knowledge side"
declares must never be tightened away. Ungated claims were **deleting it** from
the established set. It is unfrozen by this change, with `sessions` and
`evidenceCount` byte-identical — the gate restored reachability, it did not
manufacture evidence.

## Two arms, because one is not a fix

| arm | what it does | what it cannot do |
|---|---|---|
| write path — `appendWorkingMemory` | keeps new noise out | reach the 449 records already on disk |
| promotion path — `promoteSession` | discards records already written | stop the corpus refilling |

**449 of 568 records pre-date the gate.** Deleting the promotion arm leaves the
existing corpus frozen exactly as it was. Verified by mutation: removing it
fails 4 assertions, removing the write arm fails 10.

Both halves of a pair are checked. A clean claim contradicted by noise is still
noise doing the damage, so a filter inspecting only `newClaim` lets it through —
that mutation fails 2.

## Two traps, both of which a first draft walked into

**Attribution destruction.** `stampProvenance` assigns every field
unconditionally, so calling it on the write path with entry-level fields
overwrites what the claim already carries. Measured: **4640 claim fields hold a
real value** the entry also has, and **0/182 entries carry a `model` key at
all** (the provider string embeds it). An overwrite stamps `"unknown"` over
real model attribution on all 1083 claims — the longcat attribution defect,
rebuilt one layer down, and it would have looked like a *fix*. The gate is
**fill-only**: it writes a field the claim is missing or already marked
`unknown`, and never touches a real one.

**Cross-entry evidence loss.** Seeding the duplicate check from every claim
already in the session drops **45 cross-entry duplicates — and all 45 carry a
different `taskId` than the copy it kept.** Those are separate dispatches
independently asserting the same fact: corroboration, not duplication. The
`seen` set is therefore **per-entry**, matching what `sim/writer.mjs` and
`tools/real-corpus-probe.mjs` already did. That mutation fails 2.

`claimKey` is now one exported-shape function used by both the gate and its
callers. It was written out in three places; a drift would have made the
caller's dedup a different rule than the gate's, which is worse than no dedup
because it looks like it is working.

## Rejections are recorded, not deleted

`session.meta.claimGate` and `index.meta.claimGate`, both
`{accepted, rejected, byReason}` — the same contract `index.meta.patternGate`
already had. An operator can ask what was filtered and why. A silently-dropped
claim is indistinguishable from a claim that never happened.

`claimGate` is **cumulative across re-promotes** by design. A session promoted
five times counts five times. That is a reporting artifact, stated here rather
than hidden: an operator reading it after N manual replays should not conclude
the filter got N× stricter.

## Verification by mutation

Every number measured, none asserted from memory:

| Mutation | Result |
|---|---|
| write-path gate removed (the original defect) | **10 fail** |
| promotion-path gate removed | **4 fail** |
| gate always **rejects** | **5 fail** — the direction a naive test cannot catch |
| gate checks `newClaim` only | **2 fail** |
| `seen` seeded per-session | **2 fail** |
| provenance overwrites instead of fill-only | **1 fail** |

## A trap in the TEST, not the fix

The first draft asserted the legitimate contradiction using the subject
`Atomic rename prevents a torn index on crash`. It failed.

`crash` is a member of `NEGATORS` — a **judgment** lexicon — so both sides of
that pair read as `neg`, bare `polarity()` saw no conflict, and the
contradiction the assertion depended on silently did not exist. That is the
pre-existing topic-vs-judgment hazard `polarityRelativeTo()` was written for,
which is why the pattern path reads polarity *relative to the pattern*. It is
not caused by the claim gate.

The suite uses `power loss` instead, and says why in a comment. Worth recording
because the failure looked exactly like a broken fix and would have been
"fixed" by loosening the gate — the precise wrong direction.

## Suite

`437 assertions across 14 suites, 0 failing`. `test-claim-gate.mjs` registers at
its exact count of 47. No existing assertion was weakened.

*(Superseded: `437 assertions across 14 suites` was true when this defect was
measured and is NOT the repository's current suite size — the claim-path and
diversity suites below were added after it, and further work since. This document
records the defect as it was investigated, so the figure above is left as written.
It is a historical measurement, not a live one. The current suite size is
asserted only in README §Status and `.github/workflows/ci.yml`, and
`npm run docs:check` fails if either drifts from `npm test`. This file is
deliberately not a source of a live count, because a design document that quotes
one goes stale silently — which is how "437" here outlived its truth.)*

## Rejected: cross-session diversity as a promotion signal

A later card asked whether **recurrence** could break the 11-name ceiling — does
a pattern recur across distinct `(taskId, session)` pairs? The data already
existed: `patternSource()` records exactly that and `p.sources` stores it. The
ceiling section above left that stone unturned, so here is the measurement.

**The answer is no, and the reason is stronger than "it did not help".**

`p.sources` is already deduped on `(taskId, session)`, so a repeated emission
inside one dispatch is one piece of evidence, not many. Every one of the 11 has
exactly **one** source: `pairs=1, sessions=1, taskIds=1, tasks=1, agents=1`. Not
one available field varies across the 11, so no function of them can order the
7 from the 4. Reproduce with `node tools/cross-session-diversity-probe.mjs`.

The premise underneath the request was also wrong. The card asserted "182/182
entries sharing one `taskId`", which would have made recurrence look like
eleven draws from one bucket. Measured: `working-2026-09-25.json` has 182 entries
carrying **182 distinct `taskId`s**, one entry per `taskId`. The repetition is in
the `task` *string* — 15 distinct values, `"Say hello in 5 words"` 97 times.
`taskId` is per-dispatch; `task` is the prompt. Conflating them is what made a
correlated field look like a useless one.

On the fixture, a "require 2+ distinct dispatches" rule scores **15/15 noise
removed against 6/8 knowledge lost** — a number worth quoting if you skip the
next sentence. All 15 of that noise is *already* rejected by the shipped lexical
gate, which is obligation 2 of `test-real-corpus.mjs` and is green. So the rule's
marginal contribution is **0 noise rescued, 6 knowledge destroyed**. A filter
tuned against a raw count measures itself against noise it was not responsible
for catching.

**What the library already does, correctly.** `computeStatus` *is* the
recurrence signal, and it is already wired in — `candidate` below 3 sessions or 2
domains, `established` at 3+ and 2+ with no unresolved contradiction. The
difference is that it **ranks instead of filtering**: every single-dispatch
pattern survives as `candidate` and stays queryable. That is the whole lesson,
and it generalises past this card:

> Use evidence accumulation to decide how much to **trust** something, never
> whether to **keep** it. Trust is recoverable. Deletion is not.

A ranking signal that misjudges one name demotes it; a filtering signal that
misjudges one name destroys it. That is why the same signal is safe here and
catastrophic as a filter.

The refusal is pinned by `test/test-cross-session-diversity.mjs` (44 assertions),
so the next card to read "the filter judges each name in isolation" and ship a
recurrence rule finds the measurement waiting for it. 10 mutants run; 9 caught.
The one that survives weakens `keepLost > 0`, which is redundant — the refusal is
independently held by `keepLost > netRescued`, and inverting that bound fails
immediately. The suite also survives stacking: inverting all six conclusion
assertions at once still fails 5.