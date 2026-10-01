# sim/ — Polymem simulation harness

Runs Polymem, through its **public API**, against six bot personas with
deliberately different memory-writing styles, a deterministic hostile-input
suite, and a real multi-process concurrency case — then ends with a
machine-readable verdict.

```
SIM: CLEAN
SIM: FOUND <n> ISSUES
SIM: BLOCKED — the suite did not run
```

## Run it

```bash
./sim/run.sh
```

That is the whole procedure. It checks Ollama, builds the pinned image, runs the
suite in a container, copies `sim-report.json` into the repo root, and exits
`0` (clean) / `1` (issues) / `2` (blocked).

Nothing is installed. The library is zero-dependency, the harness uses only
`node:` builtins and global `fetch`, and there is **no `npm install` step in the
image at all** — which is the strongest available statement that this harness
added nothing to the package's dependency graph.

## When Ollama is down

The harness **fails loudly and does not fake anything.** There is no fixture
fallback, because a harness that quietly degrades to green is worse than no
harness — it converts "I could not test this" into "I tested this". `sim/run.sh`
checks on the host *before* the image build, so the failure takes about a second
instead of forty:

```
SIM: BLOCKED — Ollama is not reachable on http://localhost:11434
  ollama serve
  ollama pull qwen2.5-coder:14b
  ollama ps          # confirm nothing is mid-load
```

Exit code `2`. No report claims a verdict, and the issues section prints
`THE SUITE DID NOT RUN` instead of an empty list — see "Design decisions" below.

Inside the container the address is `host.docker.internal:11434`, not
`localhost`: the models live on the host. `sim/run.sh` passes `--add-host` and
sets `SIM_OLLAMA_HOST` so that difference is the script's problem, not yours.

Use a different model with `SIM_MODEL=qwen2.5vl:7b ./sim/run.sh`.

## Layout

| file | role |
|---|---|
| `run.sh` | the one command; host preflight, image build, container, report copy |
| `Dockerfile` | pinned base image (`node:22.14.0-alpine3.21`), no package install |
| `run.mjs` | the runner: five suites, issue grading, verdict |
| `writer.mjs` | ONE bot process — parse → gate → append → promote → query |
| `personas.mjs` | six styles, a realistic topic pool, the hostile case list |
| `llm.mjs` | Ollama client and the preflight that gates the whole run |
| `classify.mjs` | the independent knowledge/noise judge, plus its calibration |

## The suites

1. **Preflight.** Ollama reachable, model present. Fatal if not.
2. **Judge calibration.** Six undisputed labels, scored before any verdict is
   recorded.
3. **Personas.** 5 styles × 4 dates, through the public API. Promoting to
   `established` needs 3 sessions and 2 domains, so three dates would sit exactly
   on the boundary; four cross it and prove the evidence union is stable.
4. **Hostile inputs.** 14 deterministic cases, one child process each.
5. **Concurrent writers.** 6 separate OS processes promoting simultaneously.
6. **Isolation.** Proves the real `~/.computer-agent` was never touched.

## What makes a finding

Three severities, because "the library is broken" and "this run covered less than
it claimed" are different claims, and conflating them is how a harness starts
lying by accident.

`BLOCKER` — a Polymem defect: a crash, a hang, a throw that violates a
documented contract, prototype pollution, a write escaping the sandbox, a lost
update, a containment-breaking session date accepted, or `established` being
unreachable.

`FINDING` — real, needs a judgement call: noise that reached the index, a fenced
block silently discarded, a factual query returning nothing, a non-calendar date
accepted as a session key, an uncalibrated judge.

`GAP` — the run measured *less* than it set out to, for a reason outside Polymem:
the model aborted mid-generation, or a session produced no block. Counted in the
verdict, never silent, never filed against the library. Without this tier, a
model that refuses to generate is indistinguishable from a library that silently
drops data — which is the exact confusion this harness exists to prevent.

All three count toward the verdict. `BLOCKER` is separated out so a reader can
tell "the library crashed" from "this needs a judgement call".

## Design decisions worth knowing about

**Personas are generated, not written.** A hand-written "chatty" block is a
hypothesis about what chatty looks like, and testing the library against your own
hypothesis cannot fail in the direction that matters. Every persona block is
produced by the real model over a real task, which is also why Ollama is a hard
dependency of this suite.

**The judge is independent and calibrated.** "Is this knowledge or noise?" is
the exact question Polymem's own filter answers. Grading the library with a copy
of its own rules would agree by construction and measure nothing. An independent
model, shown the classification question with no knowledge of the library's
`REJECT` table, can *disagree* — and when it does, that disagreement is the
finding. It is calibrated against six undisputed labels first, because an
uncalibrated judge's opinion is decoration.

**Uniform failure is treated as a broken instrument.** On the first container run
all 14 hostile cases reported "failed", which a naive reading would have filed as
fourteen library defects. They were one bug: `node -e` resolves a relative import
against `cwd`, so every child died before touching Polymem. Real defects are
scattered across structurally different inputs; a library that fails all fourteen
is either broken beyond partial credit or the instrument is broken. The run now
collapses that to a single `BLOCKER` that says the per-case results are not
evidence.

**That guard then had to catch three more instrument faults, which is the real
argument for it.** Each of the following produced a report that looked like a
result and was not one. They are recorded because the failure mode is
self-concealing: in every case the harness reported *something*, and nothing in
the output said the thing was untested.

- **`report.classification` was read but never assigned.** The judge's output
  went into a local variable; the noise sweep dereferenced `undefined` and threw
  `TypeError: Cannot read properties of undefined (reading 'filter')`. The
  process aborted *after* the personas suite finished its real work, so
  hostile, concurrency and isolation never ran — and the report could not
  distinguish "three suites found nothing" from "three suites never executed".
  Each suite now runs through `runSuite()`, which contains a throw to that suite
  and records it as that suite's failure.
- **Hostile mutations were silently discarded.** `c.apply` is a *function*, and
  the child config was built with `JSON.stringify`, which drops function-valued
  properties without warning. `CFG.apply` arrived `undefined` in all sixteen
  children, so every mutation case tested the pristine baseline block. Ten
  adversarial inputs — `### constructor`, `__proto__`, the 1MB block, the
  5000-line block — reported "survived" having never been mutated. The mutation
  is now applied in the parent and passed as data, and a mutation that returns
  its input unchanged throws rather than being measured.
- **The largest two cases were never delivered.** The child script was passed as
  `node -e <script>`, putting a 1MB script on the command line, where macOS caps
  a single argv entry. `one-mb-block` and `five-thousand-lines` died with
  `spawnSync E2BIG` before node started — the two inputs most likely to break a
  parser were the two never tested. The script now travels on stdin.

Two guards were added so this class cannot recur silently: every generated child
is `node --check`ed before it runs (a child that does not parse is reported as a
harness fault, not a library result), and the mutation is applied in the parent
where it can be inspected rather than reconstructed inside a string template.

**A finding's cause is measured, not inferred — and this harness got it wrong
twice.** The chatty persona wrote a valid fence and yielded zero bullets. First
diagnosis: the 300-char bullet threshold. Disproved — chatty's longest bullet was
174 chars. Second diagnosis: missing `###` section headers. Disproved on a later
run — all four sessions had four headers each and still yielded nothing. Both
stories were plausible, both were wrong, and each would have shipped a confident
false cause into the report. So the finding now prints the per-session raw shape
(headers, bullet counts, longest-bullet chars) and explicitly says the cause is
not isolated when none of the known rules explains it. `hostile:header-placement`
and `hostile:bullet-length-boundary` measure the candidate rules in isolation so
a future run can attribute it properly.

The general rule this earned: a measurement that disproves your hypothesis is
worth more than the hypothesis, and a harness that reports an unexplained loss is
more useful than one that reports a confident wrong one.

**An empty issues section is not printed for a blocked run.** A fatal preflight
failure means no suite ran. Printing "issues: none" above `SIM: BLOCKED` is
exactly the misreading this harness exists to prevent, so that branch prints
`THE SUITE DID NOT RUN` and names which suites were skipped.

**A blocked run exits 2, not 0.** Distinct from "found issues" (exit 1), so CI
can tell "the library has problems" from "the harness could not run".

**Containment is measured by before/after diff.** A child cannot know what was
already in `/tmp`, so an absolute "these files exist" test would fire on the
harness's own scratch directory every run. The parent snapshots the escape
targets, runs the child, and diffs.

**The library's own repo-root guard works.** An early image put scratch state at
`/work/scratch`, inside the checkout, and Polymem refused to load — its
containment check computes the repo root from `src/..` and rejects any index
inside it. That guard caught the harness, which is the behaviour it exists for.

**Grading is two-tier where the severity differs.** A session date of
`2026-13-45` matches `/^\d{4}-\d{2}-\d{2}$/`, so it is accepted and files a
session under a date that does not exist. That is a real looseness with no
containment consequence, and it is reported as a `FINDING`, not a `BLOCKER` —
overstating findings is how a reader learns to discount the list.

**The harness is not shipped.** `package.json`'s `files` allowlist is `src/`,
`README.md`, `LICENSE`, `CHANGELOG.md`. Verify with `npm pack --dry-run`; `sim/`
must not appear.

## Known limitations

- **One model, one host.** Every persona's output comes from
  `qwen2.5-coder:14b` on one machine. A different model writes different
  memories, so these results describe this model. Set `SIM_MODEL` to re-measure.
- **One run, not a distribution.** Persona output is sampled at temperature 0.8,
  so a re-run can produce different patterns and a different finding count. The
  JSON carries every raw block so a surprising result can be traced to the exact
  text that produced it.
- **The judge is a model too.** It is calibrated and it always states a reason,
  but it can be wrong. `knowledgeCheck` in the JSON shows what it claimed and on
  what grounds, and the per-pattern reasons are there to be argued with.
- **`nomic-embed-text` is unused.** The library does literal substring matching
  (documented, deliberate), so there is no embedding surface to simulate.

## Standalone repros

Two findings are backed by scripts that run without the full simulation, so they
can be re-checked in seconds instead of re-running a 25-minute suite:

```bash
node sim/repro-junk-patterns.mjs     # the promoteSession null-guard crash
node sim/repro-established-bar.mjs   # whether `established` is reachable at all
```

Both use only the documented public API. Both assert nothing — they print what
happened, so they double as regression checks: if a fix lands, each says so and
exits 0.

`repro-established-bar.mjs` is the interesting one. It runs the "bot with memory"
case, feeding the model its own earlier pattern names so it *can* repeat itself,
and reports whether the 3-session bar is crossed.

## Findings from the first runs

The harness found three things worth Polymem's attention. Two are reproduced by
the scripts above; the third is a measurement in every report.

**1. `promoteSession` crashes on a null entry in `patterns`** — `BLOCKER`

`polymem.mjs:1868` does `assessPatternName(p.text)` with no null guard, so one
`null` inside a session's `patterns` array throws a `TypeError` and aborts
promotion. The parse path guards the same data (`polymem.mjs:1164`), so this is
inconsistent: `parseMemoryBlock` can never produce the input, but
`appendWorkingMemory` is a public export and a stored session file from an older
schema can contain it. Fix: skip non-object entries the way the parser does, and
record them in `index.meta.quarantine` so the discard stays auditable.

**2. `established` looks unreachable for model-written memory** — `BLOCKER`

Every pattern in every run ended with one session and nothing reached
`established`, despite 78 promotions collapsing to 33 entries — so dedup *is*
merging, just not across dates. The cause is that models paraphrase:

```
"Ensure atomicity in write operations through robust recovery mechanisms"
"Atomic write operations through robust recovery"
```

Five shared tokens, but containment 0.833 against the 0.9 bar at
`polymem.mjs:710`. The same durable idea arrives reworded, so it never merges,
evidence never accumulates. Feeding the model its own earlier names does not fix
it — see `repro-established-bar.mjs`, which still tops out at two sessions. The
README's "3 sessions across 2 domains → established" therefore describes a path a
model-writer does not actually take.

**3. Bullets can be silently discarded from a valid fence** — `FINDING`

`parseMemoryBlock` can return a **well-formed but empty** memory object for a
block that plainly contained bullets — four empty arrays, no throw, no
`memory: null`. Both the `chatty` and `noisy` personas hit this on some dates:
18 bullets written, 0 received, nothing visible to the caller.

Two rules can each cause it in isolation, and `sim/` measures both:

- the anchored header match `/^###\s+(\w+)/` (`polymem.mjs:1159`) plus the
  skip-when-no-current-section guard (line 1161) — so no headers at all, an
  indented `###`, a header glued to its bullet on one line, or an unrecognised
  section name each discard every bullet. Measured in
  `hostile:header-placement`: 3 of 5 ordinary shapes parse to empty.
- the length drop at line 1164 — see finding 4.

Worth considering: return `memory: null` when a fenced block yields zero items but
clearly contained bullets, so the caller can tell "said nothing" from "everything
was dropped".

*Honest caveat:* across runs the trigger moved — some sessions with headers and
short bullets still came back empty. The report therefore prints the per-session
shape and, when no known rule explains it, says the cause is not isolated rather
than naming one it has not proven.

**4. Two disagreeing bullet-length thresholds** — `FINDING`

`polymem.mjs:1164` drops any bullet over 300 chars; `1171` truncates anything
kept to 200. A 350-char bullet vanishes with no error while a 250-char bullet is
kept and shortened. Measured directly by `hostile:bullet-length-boundary`:
dropped at 301/400/1200, shortened at 201→200, 299→200, 300→200. Neither
threshold is documented in the README. One rule (truncate at 200 rather than
drop at 300) plus a documented note would remove the asymmetry.

**5. Non-calendar dates are accepted as session keys** — `FINDING`

`2026-13-45`, `2026-02-30`, `9999-99-99`, `0000-00-00` all match
`/^\d{4}-\d{2}-\d{2}$/`, so the format guard accepts them and files sessions under
`working-<date>.json` for dates that do not exist. No containment risk — the files
land inside the sessions dir — so this is a correctness issue, not a security one.
A calendar check next to `assertDateStr` would cover it.

Note that `2026-13-45` is graded separately from the traversal strings on purpose:
traversal acceptance is a `BLOCKER` because it is an arbitrary-path primitive,
while an impossible date is only a data-quality problem.
