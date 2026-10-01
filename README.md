# Polymem

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D18-5FA04E.svg)
![Dependencies](https://img.shields.io/badge/dependencies-0-success)

<!--
Two badges are deliberately absent, because both targets 404 today and a broken
badge reads as neglect rather than as pending.

THE GITHUB BADGE. The repo now exists but is PRIVATE: created 2026-10-01
15:16:40Z, first push 15:18:38Z, both before this section was last written, and
`private: true` with `visibility: private` in the API response. Measured
2026-10-01 11:58 EDT, authenticated as jwatson1283:
`api.github.com/repos/jwatson1283/Polymem` returns 200. Unauthenticated — which
is what a badge request and a CI status check are — it returns 404, and so does
the badge SVG itself. So the badge stays out until the repo is public. Making it
public is Josh's call and is NOT covered by the "nothing gets published" rule
here, which covers releases, tags, npm, and announcements.

  ![CI](https://github.com/jwatson1283/Polymem/actions/workflows/ci.yml/badge.svg)

THE NPM BADGE. `npm view polymem` returns E404 — the name is AVAILABLE, the
registry has no squatter. So:

  ![npm](https://img.shields.io/npm/v/polymem)
-->

**An AI agent forgets everything between sessions. Polymem gives it a memory
that learns *which techniques keep working* — and stores that memory as plain
JSON files you can read, diff, edit, and delete.**

No database. No server. No embeddings. No API keys. **No dependencies at all** —
not zero-ish, not "a couple". `src/` imports nothing but `node:` builtins, so
there is nothing to resolve, nothing to audit, nothing to keep current, and
nothing to install. Your agent's memory is a file. When you want to know what it
knows, you open it in an editor.

**Contents**
- [What this is not](#what-this-is-not) — read this before anything else
- [Why it exists: it was adversarially audited and it failed](#why-it-exists-it-was-adversarially-audited-and-it-failed)
- [What it actually does](#what-it-actually-does)
- [Usage, with real captured output](#usage-with-real-captured-output)
- [Retrieval is keyword-based, not semantic](#retrieval-is-keyword-based-not-semantic)
- [Install](#install)
- [Who this is for](#who-this-is-for)
- [When NOT to use this](#when-not-to-use-this)
- [How this compares](#how-this-compares)
- [What is NOT done yet](#what-is-not-done-yet)
- [The polymathic thesis](#the-polymathic-thesis)
- [API](#api)
- [Configuration](#configuration)
- [Durability and privacy](#durability-and-privacy)
- [The simulation harness (`sim/`)](#the-simulation-harness-sim)
- [How this repo verifies its own claims](#how-this-repo-verifies-its-own-claims)
- [Contributing](#contributing)
- [Status](#status)
- [License](#license)

---

## What this is not

Put bluntly, because it saves you an hour if you are the wrong tool:

Polymem is **not a vector database**, it does **not** do semantic search, and
its retrieval is plain substring matching. It answers a narrower question: over
many sessions, which recurring ways of working have accumulated enough
independent evidence to be trusted, and which have been contradicted?

Everything below follows from that. If you need "find things that *mean*
similar to this", you want a vector store and this is the wrong library — see
[When NOT to use this](#when-not-to-use-this), which is the most useful section
on this page.

---

## Why it exists: it was adversarially audited and it failed

This is the short version, because it is more persuasive than any feature list
and it is the reason the README reads the way it does.

Polymem was extracted from [OmegaShell](https://github.com/jwatson1283), where
it runs in production as the backend memory layer. It was then audited
adversarially — deliberately broken, on purpose, by someone looking for reasons
not to trust it. **Five real defects, each reproduced before and after, each now
covered by a regression test that fails against the old code:**

1. **Silent data loss under concurrency.** Every writer published a complete
   snapshot of the index; the last `rename()` won and the other writers'
   patterns were gone. Measured on the pre-fix code, 8 processes each adding one
   pattern, released together off a real barrier: **between 1 and 7 of 8
   survived** (most often 3 of 8), the file was valid JSON, and **all 8 reported
   `saved: true`**. The exact count is not a stable property — it is a race, so
   it varies with scheduling. Any single figure quoted here would be an
   artifact of one run, which is why this states a range over 120 runs. The textbook fix
   (hash-compare-then-rename) was implemented faithfully and *also* failed —
   2 of 8, then 3 of 8, then 1 of 8 — because `rename()` is unconditional.
2. **Path traversal through the session date, on read *and* write.** The date
   was interpolated raw into a filename. Three path segments escaped the
   sessions directory on read: `loadWorkingMemory` would return the contents of
   any JSON file the process could already reach, which needs no write
   permission and is the cheaper abuse.
3. **Prototype-chain lookups on model-supplied keys.** A memory section header
   reading `### constructor` made `parseMemoryBlock` throw — breaking its own
   documented never-throw contract, on the per-response path, with no attacker
   required: a model only has to emit the word. Worse, `demotePattern` and
   `restorePattern` wrote `demotedFrom`/`status`/`demotedAt` onto
   `Object.prototype` — process-wide, visible to code that never touches memory.
4. **The npm tarball published everything.** No `files` field, so the pack
   included whatever sat at the repo root — internal design docs under `docs/`
   and the test suite shipped alongside the library. Measured at
   `322eb1f~1`, that was 12 files, not the whole checkout; a scratch directory
   at the repo root would have gone with it. Now an explicit allowlist, measured
   at exactly 7 files.
5. **The pack was readable by every account on the host.** The index holds
   verbatim agent output — absolute paths, provider names, task ids — written at
   mode `0644`. Now `0600`.

Then, later, a second round found the defect that mattered most, and it was not
a security bug at all:

6. **The filter existed but nothing called it.** `assessClaim` was exported,
   documented, and had **zero callers inside the library**. It was a filter the
   consumer had to remember to invoke. Meanwhile a live index filled with
   `casual-greeting`, `miscounting-words-in-constrained-length-response`, and
   `five-word-salutation` — 24 patterns a human eventually had to quarantine by
   hand. Every existing assertion was green the whole time, because every
   existing suite tested *mechanisms* (parse this, write atomically, contain
   that path) and none of them asked the only question that mattered: **given a
   realistic day's output, is the resulting index worth reading?**

The fix was to move the gate onto the promotion path so it is structural rather
than advisory, then measure it against six sessions of real model-emitted
content rather than `"Hello world"` fixtures. Measured BEFORE → AFTER, via
`node tools/real-corpus-probe.mjs`:

| | before | after |
|---|---|---|
| noise promoted | 15 | **0** |
| knowledge kept | 8 / 8 | **8 / 8** |
| promoted patterns carrying an audit trail | 0 / 5 | **5 / 5** |

Full detail, including the exact reproduction commands and the mutation testing
that verifies the test can fail: [`docs/2026-09-25-promotion-defect.md`](docs/2026-09-25-promotion-defect.md).

**And the honest part: the filter still has a measurable ceiling.** It is
lexical, so over the 85 real quarantined pattern names it rejects 74 and **11
still get through**. Those 11 are not all failures, and splitting them is the
point: **7 are still noise** (`System recovery check`, `Clear communication
pattern`, `Factual accuracy error`, `Information synthesis pattern`,
`Incomplete adherence to specifications`, `Local-first AI agents explanation`,
`Progress tracking across parallel workstreams.`) and **4 are plausibly good
knowledge that must never be tightened away** (`Intra-session contradiction
tracking` — a feature of this very library — plus three from the real corpus).

Those 7 cannot be removed without taking the 4 with them: `System recovery
check` and `Clear communication pattern` are structurally identical to `Code
Review`, which *is* caught, and there is no line between them that does not also
take real knowledge. An earlier revision of this README reported **22**
survivors and called all 22 "false negatives". That label was wrong and it had
been asserted in a test, which is worse than the error — it locked a bad
judgement in place. Three narrower rules (`echoArtifact`, `nominalizedActivity`,
`bareProcessLabel`, each behind a predicate veto) took the residual 22 → 11 at
zero knowledge cost; a broader "no finite verb" rule was measured and
**rejected**, because it caught 4 and destroyed `Intra-session contradiction
tracking`. A rule that trades real knowledge for noise is a bad trade however
good the headline number looks.

So the ceiling is 11, enumerated verbatim in `test/test-real-corpus.mjs`, with
the 4 knowledge names asserted separately — so a future "improvement" that eats
them fails loudly. It is a number in a test that fails when it drifts, not a
sentence in a comment. Closing the remaining 7 needs a judge, and this repo has
ruled one out: no embeddings, no LLM call, no dependencies.

This history is why the sections below are blunt. A library that tells you what
it cannot do is worth more than one that lists what it can.

---

## What it actually does

Two tiers:

1. **Session working memory** — parses a ` ```memory ` block out of an agent's
   response, records its claims, patterns, and correspondences, and flags claims
   that contradict something already said in the same session.
2. **Patterns index** — patterns cross a session boundary, accumulate evidence,
   and are gated on it. A pattern promotes from `candidate` to `established`
   only when it has appeared in **3+ sessions across 2+ domains** and is not
   implicated in an unresolved contradiction.

That gate is the whole point. A memory system that stores everything is a log.
One that promotes on evidence is a record of what has held up. Contradiction
runs the other way: `demotePattern` drops a pattern back to `candidate`, and the
reason is recorded rather than deleted.

**When a pattern is held back, it says why.** The 2-domain half can be met two
ways: the `— domains: a, b` suffix above, or inference from the pattern's own
text using the domain vocabulary in the file. If neither supplies a second
domain, the pattern stays a `candidate` and `index.meta.trustGate` records it:

    index.meta.trustGate
    // { assessed: 12, established: 2, candidates: 10,
    //   heldBack: { 'ok.sessions+insufficientDomains': 8,
    //               'insufficientSessions+ok.domains': 2 },
    //   sessionsShort: 2, domainsShort: 8 }

So "why is my memory full of candidates" is a count, not an investigation. The
bar itself is unchanged — inference only supplies domains the text genuinely
supports, so a pattern that has met neither half stays held back.

Pattern ids are a slug of the name plus a short digest of the full slug when it
runs past 60 characters, so two patterns sharing a long prefix stay distinct
instead of collapsing into one key. Short ids are unchanged, and an index
written by earlier versions keeps its keys and its evidence — a pre-fix
truncated id is still resolved by name, so new sessions land on the existing
pattern rather than creating a second one.

---

## Usage, with real captured output

An agent ends its response with a `memory` fence:

    ```memory
    ### claims
    - Retry wrapper needs a jittered backoff — fixed backoff synchronises every client
    - Serialize writes with a unique temp path, then rename, so no writer truncates another
    ### patterns
    - Unique temp path plus rename makes a write atomic under concurrency — domains: code, ops
    - Draft, then review, then publish is the same shape as stage, then verify, then commit — domains: comms, code
    ### correspondences
    - serialize-then-commit ↔ draft-then-publish
    ```

```js
import {
  parseMemoryBlock, appendWorkingMemory,
  loadPatternsIndex, promoteSession, queryPatterns,
} from 'polymem';

const SESSION = '2026-09-30';

// 1. Decompose the agent's response.
const { display, memory } = parseMemoryBlock(agentOutput);
// display → user-facing text, memory fence stripped
// memory  → { claims, patterns, correspondences, contradictions }

// 2. Write to session working memory. Returns contradiction flags.
const flags = appendWorkingMemory(SESSION, {
  time: new Date().toISOString(),
  agent: 'chief',
  task: 'retry wrapper',
  claims: memory.claims,
  patterns: memory.patterns,
  correspondences: memory.correspondences,
  contradictions: memory.contradictions,
});

// 3. Promote this session's patterns into the long-term index.
const index = loadPatternsIndex();
const result = promoteSession(SESSION, index);

// 4. Query it later.
const hits = queryPatterns('temp path rename concurrency', index);
```

The output below is **not written by hand**. It is the literal stdout of
`node tools/readme-example.mjs`, and
[`tools/check-doc-claims.mjs`](tools/check-doc-claims.mjs) re-runs that script
and fails if this block and the script's real output ever diverge by a single
character. Only the timestamps are normalised, because they are the only part
that legitimately changes between runs.

<!-- BEGIN CAPTURED OUTPUT: tools/readme-example.mjs -->
```
--- display (user-facing text, memory fence stripped) ---
Wrote the retry wrapper. Two things worth remembering.

--- parsed patterns ---
• Unique temp path plus rename makes a write atomic under concurrency  [code, ops]
• Draft, then review, then publish is the same shape as stage, then verify, then commit  [comms, code]

--- contradictions flagged in-session ---
none

--- appendWorkingMemory → 0 contradiction flag(s) ---

--- promoteSession ---
{
  date: '2026-09-30',
  promoted: [
    'unique-temp-path-plus-rename-makes-a-write-atomic-u-b73dff75',
    'draft-then-review-then-publish-is-the-same-shape-as-a8d2fe44'
  ],
  demoted: [],
  consolidated: [],
  saved: true,
  patternCount: 2
}

--- queryPatterns("temp path rename concurrency") ---
• Unique temp path plus rename makes a write atomic under concurrency
  status=candidate  evidenceCount=1  domains=code,ops  score=4

--- the index file on disk (first 40 lines of 97) ---
{
  "version": 1,
  "patterns": {
    "unique-temp-path-plus-rename-makes-a-write-atomic-u-b73dff75": {
      "name": "Unique temp path plus rename makes a write atomic under concurrency",
      "domains": [
        "code",
        "ops"
      ],
      "sessions": [
        "2026-09-30"
      ],
      "evidenceCount": 1,
      "status": "candidate",
      "firstSeen": "2026-10-01T18:33:58.064Z",
      "lastSeen": "2026-10-01T18:33:58.064Z",
      "correspondences": [],
      "contradictions": [],
      "nameVariations": [],
      "implicatedBy": [],
      "sources": [
        {
          "session": "2026-09-30",
          "time": "2026-10-01T18:33:58.058Z",
          "task": "retry wrapper",
          "taskId": "unknown",
          "provider": "unknown",
          "model": "unknown",
          "agent": "chief",
          "routeSource": "unknown"
        }
      ]
    },
    "draft-then-review-then-publish-is-the-same-shape-as-a8d2fe44": {
      "name": "Draft, then review, then publish is the same shape as stage, then verify, then commit",
      "domains": [
        "comms",
        "code"
      ],
      "sessions": [
… truncated for the README; the whole file is the JSON above

--- queryPatterns("how do we avoid losing writes") ---
[]   ← same index, same library. See "Retrieval is keyword-based, not semantic".
```
<!-- END CAPTURED OUTPUT -->

Two things to read carefully in that output:

- **`status=candidate` after one session.** That is correct, not a bug — the
  gate is 3+ sessions across 2+ domains. A new install sees everything as
  `candidate` for a while, by design. Promote the same session three times and
  nothing changes; the count is sessions, not calls.
- **The last query returned `[]`.** Same index, same library, one sentence
  later. That is the next section, and it is the most important limitation here.

---

## Retrieval is keyword-based, not semantic

`queryPatterns` splits your query on whitespace, drops terms of two characters
or fewer, lowercases them, and counts how many appear as **literal substrings**
of a pattern's `name` or its `domains`. That is the entire algorithm. There is
no embedding, no stemming, no synonym expansion, and it does not search claims
at all.

Measured on the real six-session corpus, same index, same library:

```
  serialize concurrency       → 1 result   [candidate s=2] Serialize read-modify-write under a single write claim
  prototype pollution …       → 1 result   Use own-property checks for any key derived from model output
  deploy dirty tree           → 1 result   Refuse the deploy when the tree is dirty rather than stashing

  how do we avoid losing writes → 0 results
  greeting                     → 0 results   (correct: those were filtered out)
  word count                   → 0 results   (correct: also filtered out)
```

The first three hit because their terms literally appear in the stored text. The
fourth is the one that matters: *"how do we avoid losing writes"* is a
**perfectly good question with a perfect answer sitting in the index** —
"Serialize read-modify-write under a single write claim" is exactly it — and it
returns nothing, because none of `how`, `avoid`, `losing`, `writes` appears in
that name. No amount of synonym handling fixes this properly; only embeddings do.

Read this before you design a workflow on top of Polymem. If your agent needs to
*recall by meaning*, this is the wrong tool and no amount of prompt work will
change that. If it needs to *check a specific technique it already knows the
name of*, substring matching is exactly right and free.

One more sharp edge: the domain vocabulary is fixed and normalized at write time
(`coding`/`engineering`/`dev` all collapse to `code`), but **query terms are not
normalized the same way.** Querying `coding` will not match a pattern tagged
`code`.

---

## Install

```bash
npm install polymem
```

Requires Node >= 18. Zero dependencies, so there is nothing to resolve.

Or from source:

```bash
git clone https://github.com/jwatson1283/Polymem.git
cd Polymem
npm test
```

---

## Who this is for

People building **long-term memory for agents that do recurring work** — coding
agents, research agents, ops agents — where the valuable thing to remember is
*how this codebase/team/operation actually works*, and where that knowledge is
earned by recurrence rather than stated up front.

The unit of memory is a **technique with evidence**, not a fact about a user. If
you are building a support bot that must remember "Alice prefers aisle seats,"
this is the wrong library.

You will also like it if any of these is true: you cannot run Postgres in the
target environment; you want to read and hand-edit your agent's memory with an
editor; the memory has to survive as plain files you can commit, diff, or
delete; or a supply-chain dependency is a risk you would rather not take in a
component that holds everything your agent knows.

---

## When NOT to use this

Read this section before installing. It is the shortest path to the right tool.

**Do not use Polymem if you need any of these:**

- **Fuzzy or semantic recall.** `queryPatterns` is literal substring matching.
  See [Retrieval is keyword-based, not semantic](#retrieval-is-keyword-based-not-semantic)
  above for the measured demonstration — a question with a correct answer in the
  index returned `[]`. Use a vector store.
- **Facts about people, entities, or relationships.** Polymem promotes
  recurring techniques. It is not a fact store and has no entity model.
- **A knowledge graph.** The correspondence layer is stored as flat strings.
  It is not queryable as a graph, and cross-domain structural identity testing
  is designed but not implemented. See [What is NOT done yet](#what-is-not-done-yet).
- **Multi-user or multi-tenant isolation.** One index file, one session
  directory, no scoping key. There is no `user_id`.
- **Concurrent writers against one index.** Saves are merged, so overlapping
  writers no longer lose each other's patterns. Two limits remain and neither
  is hidden: counters (`meta.promotions`) merge by `max()`, so two processes
  promoting at once can undercount by one, and the write claim only coordinates
  writers that go through this library. See
  [Durability and privacy](#durability-and-privacy).
- **Compliance requiring encryption at rest.** Off by default: with no
  `OMEGA_MEMORY_PASSPHRASE` set, files are plaintext at mode `0600`. Optional
  AES-256-GCM is available and is not a compliance control — see
  [Durability and privacy](#durability-and-privacy).
- **Network filesystems.** The write claim and the atomic `rename()` both rely on
  POSIX atomicity. NFS and SMB do not give the same guarantees with the same
  timing, so on a network mount the merge degrades towards last-writer-wins.
  This is a property of the filesystem, not a bug that was left unfixed.
- **Windows, for the write claim.** The claim is `open(path, 'wx')`
  (`O_CREAT|O_EXCL`) precisely because `flock(2)` does not exist on Windows, so
  the lock does not narrow the platform floor — but POSIX ownership semantics
  are the thing being relied on, and that has only been exercised on macOS,
  Linux, Alpine and Debian.

---

## How this compares

Honest positioning. Every claim here is checkable against the linked source;
none of it is a benchmark, because **no benchmark comparing these has been run**
and inventing one would be the easiest way to make this page worthless.

| | **Polymem** | **Mem0** | **Hindsight** | **LangChain memory** |
|---|---|---|---|---|
| Unit stored | technique + evidence | extracted fact | typed fact / observation | arbitrary JSON doc |
| Embeddings | no | yes | yes | depends on store |
| Calls an LLM | no | yes, to extract facts | yes, to retain and reflect | no (store only) |
| Infrastructure | none — JSON files | SQL + vector DB + entity store | Postgres + pgvector, or embedded, or cloud | a LangGraph store |
| Multi-user scoping | none | `user_id` / `agent_id` / `run_id` | one memory bank per user/agent | namespace + key |
| Promotion rule | evidence-gated | not applicable — no status | observation consolidation | not applicable |
| Dependencies | **0** | several | several | several |
| License | MIT | Apache-2.0 | see repo | MIT |

Sources: [Mem0 architecture](https://docs.mem0.ai/core-concepts/how-it-works),
[Mem0 repo](https://github.com/mem0ai/mem0),
[Hindsight](https://hindsight.vectorize.io/),
[LangChain long-term memory](https://docs.langchain.com/oss/python/langchain/long-term-memory).

Read that table honestly and it says something narrow and true: **these are
different products, not competitors on a leaderboard.** Mem0 and Hindsight are
sophisticated *retrieval* systems — they answer "what do we know that is
relevant to this query," using embeddings and, in Hindsight's case, a
cross-encoder re-ranker over four parallel retrieval strategies. LangChain
memory is a *store abstraction* inside an agent framework.

Polymem is a *pattern ledger*. Its distinguishing property is that a pattern
must clear an evidence bar before it is trusted, and that being contradicted
demotes it — a status machine that none of the others implement, because their
job is recall rather than adjudication. It also does the whole thing with a
JSON file and no dependencies, which matters when you cannot run Postgres, when
you want to read and edit the memory by hand, or when the memory has to survive
as plain files you can commit, diff, or delete.

If your problem is retrieval, use a retrieval system. This is the other thing.

---

## What is NOT done yet

Unchanged, and not going to be smoothed over:

- **Demotion tuning** — the thresholds (3+ sessions, 2+ domains) are initial
  values, not empirically tuned. They need adjustment against real recurrence
  and false-positive rates.
- **The filter's ceiling is measured, not solved.** Lexical rules reject 74 of
  the 85 real quarantined names; **11 pass** — 7 of them still noise, 4
  plausibly good knowledge that must never be tightened away. Asserted as a
  number in `test/test-real-corpus.mjs`, with the 4 knowledge names asserted
  separately, so the ceiling can neither silently improve nor silently eat real
  knowledge.
- **Cross-domain retrieval** — the correspondence layer is stored as flat
  strings, not a queryable graph. Structural identity testing across domains is
  designed but not implemented.
- **Computer-activity tier** — the three-tier observation model (raw
  observation → derived claims → patterns) for learning from user computer
  activity is designed in
  [`docs/2026-09-24-polymem-computer-activity-design.md`](docs/2026-09-24-polymem-computer-activity-design.md)
  (in the repository, not in the npm tarball) but not implemented.
- **Portability is exercised, not proven.** CI runs Linux on Node 18 and 20. The
  suite has been run green on macOS, Linux, Alpine, Debian, root and non-root,
  but there is no Windows CI job and no arm64 CI job.
- **No crash telemetry, no migration framework, no plugin API.** The schema is
  `version: 1` and there is no forward-migration path yet. Do not build a
  system whose memory you cannot rebuild from a backup.

Also worth stating plainly, because it is the kind of thing that is easy to
leave implicit: `queryPatterns` does substring matching on `name` + `domains`.
It does not search `claims`, does not embed, does not stem, and does not
expand synonyms. The fixed domain vocabulary collapses `coding`/`engineering`/
`dev` into `code` at write time, but query terms are not normalized the same
way.

---

## The polymathic thesis

Most AI memory systems are context-window fillers: slurp files, append a session
log, retrieve by similarity. They accumulate files but not institutional
knowledge.

Polymem is built on a different premise: that the distinctive value of a memory
system is **structural correspondence** — the ability to see that a pattern in
one domain ("serialize-then-write under concurrency" in code) is structurally
the same as a pattern in another ("draft-then-review-then-publish" in comms).
This is the polymathic property: knowledge compounds not just by volume but by
cross-domain connection.

Note that this is a *design intent stated honestly*. The correspondence layer
exists and stores strings; the cross-domain retrieval that would exploit it is
not implemented. See above.

---

## API

### Decomposition

- `parseMemoryBlock(raw)` — Parse a fenced ` ```memory ` block from agent
  output. Returns `{ display, memory }`. Never throws: a malformed block
  degrades to `memory: null`, and a `### constructor` header no longer
  crashes it.

### Session working memory

- `workingMemoryPath(dateStr)` — Path to the working memory file for a date.
- `loadWorkingMemory(dateStr)` — Load working memory for a date.
- `saveWorkingMemory(dateStr, working)` — Save working memory. Returns `false`
  on I/O failure; **throws** on a malformed date, because a bad date is a caller
  bug and no disk change fixes it.
- `appendWorkingMemory(dateStr, entry)` — Append an entry, returns contradiction
  flags.
- `checkIntraSessionContradictions(working, newClaims)` — Check new claims
  against existing entries.

### Patterns index

- `loadPatternsIndex()` — Load the patterns index (empty index if missing).
  Throws `DecryptionError` on a sealed store it cannot open — see
  [Durability and privacy](#durability-and-privacy).
- `savePatternsIndex(index)` — Save the index atomically. Never throws.
- `promoteSession(dateStr, index)` — Promote a session's patterns. Throws
  `QuarantineError` if the corpus is quarantined.
- `queryPatterns(query, index)` — Query by terms. Top 10.
- `computeStatus(p)` — Compute status from evidence. This is the gate, exported
  so you can test your own thresholds against it.
- `demotePattern(index, id, reason)` / `restorePattern(index, id, reason)`
- `consolidateNearDuplicates(index)` — Merge fragmented near-duplicates into the
  stronger entry. Nothing is destroyed silently: the absorbed record is copied
  into `meta.absorbedPatterns` first.
- `findNearDuplicatePatternId(name, index)` — Find a near-duplicate by name.
- `removeMetaKey(index, key)` — **Required** to remove a `meta` key. See
  [Durability and privacy](#durability-and-privacy) for why a bare `delete`
  does not work.
- `mergeConcurrentIndex(...)` / `withIndexLock(...)` — the merge and the write
  claim, exported for consumers building their own save paths.
- `ContentionError` — thrown/reported when a write could not take the claim.

### Utilities

- `normalizeDomain(raw)` — Normalize to the fixed vocabulary.
- `patternId(name)` — Generate a URL-safe pattern ID from a name.
- `assessClaim(claim, seenThisSession)` — Negative-only gate: rejects claims
  that are provably not durable. Does not score quality.
- `assessPatternName(name)` — Same filter applied to a pattern name. Separate
  entry point because `assessClaim`'s duplicate-in-session check would make a
  name that legitimately recurs inside one session look like a duplicate.
  **`promoteSession` calls this on every session pattern**, so the filter is
  structural rather than advisory — a consumer that forgets to gate still gets a
  filtered index. Rejections are counted in `index.meta.patternGate`
  (`{accepted, rejected, byReason}`) rather than deleted, so an operator can see
  what was dropped and why.
  Over the 85 real pattern names that caused the 2026-09-25 quarantine it
  rejects 74; **11 still pass** — 7 residual noise plus 4 names
  (`Intra-session contradiction tracking`, `Chief of Staff handles simple direct
  requests without delegation`, `Edge computing architecture prioritizes
  privacy, latency, and offline resilience`, `Generate and review code snippets`)
  that are plausibly good knowledge and must never be tightened away. All 11
  are enumerated verbatim in `test/test-real-corpus.mjs`, and the 4 knowledge
  names are asserted separately — so the ceiling is a number in a test that
  fails in both directions, not a claim in a comment.
- `stampProvenance(claims, opts)` — Stamp provider/model/task/taskId/agent/
  routeSource. Absent provenance is `'unknown'` and never inferred.
- `stampProvenance` semantics also apply to **patterns**: each promoted pattern
  carries `p.sources`, one entry per distinct `(taskId, session)` dispatch that
  produced it. Fields are read off the session entry and never derived — on real
  data `model` reads `'unknown'` because the provider string carries it.
- `isImplicatedBy(name, contradiction)` — Does this contradiction implicate
  this pattern?
- `QuarantineError` — Thrown when the corpus is quarantined.
- `DecryptionError`, `PASSPHRASE_ENV` — see
  [Durability and privacy](#durability-and-privacy).

See `docs/2026-09-25-promotion-defect.md` for the BEFORE/AFTER measurement and
`node tools/real-corpus-probe.mjs` to re-derive it.

---

## Configuration

Three environment variables control where state is stored:

- `OMEGA_MEMORY_INDEX` — patterns index file. Defaults to
  `$HOME/.computer-agent/memory/patterns-index.json`.
- `OMEGA_MEMORY_SESSIONS_DIR` — sessions directory. Defaults to
  `$HOME/Documents/Obsidian Vault/11_COMPUTER_AGENT/sessions`.
- `OMEGA_MEMORY_PASSPHRASE` — enables AES-256-GCM encryption at rest for **both**
  stores. Unset or blank means off and the files are plaintext, so an existing
  deployment is unaffected. Read once at load. If you lose it, the sealed data
  is unrecoverable — see [Durability and privacy](#durability-and-privacy).

Both paths default outside the package. **The library refuses to run if either
resolves inside its own directory**, or if either is not absolute — a write
there re-dirties your checkout and makes deploys unreachable. This is enforced
at load, not left to caller discipline.

---

## Durability and privacy

Three things worth knowing before you point this at real data.

**Concurrent writers: merged saves.** Every write goes to a unique temp file
and is then `rename()`d into place, so a reader never sees a half-written index
and one writer cannot truncate another writer's in-flight bytes.

Around that, the save is a read-modify-write cycle: it takes a claim on the
index, re-reads the current file *inside* the claim, merges your snapshot into
it, and commits. Two processes saving overlapping indexes therefore both
survive — measured with 8 concurrent processes adding 8 distinct patterns, all
8 are present afterwards (previously between 1 and 7 of 8 on the pre-fix code,
with every writer still reporting `saved: true` — the count varies run to run
because it is a race, so it is given as a range rather than a figure).

The claim is `open(path, 'wx')` — `O_CREAT|O_EXCL`, atomic create-if-absent.
That choice is deliberate and portable: `flock(2)` does not exist on Windows,
so a `flock`-based lock would have quietly narrowed the supported platforms.
The claim records its owner's pid and hostname, so one abandoned by a process
that is provably dead is broken automatically and a crash needs no manual
recovery. A claim held by a *live* process is never stolen: the writer gives up
after a bounded wait and reports contention, because breaking a live claim
would be a double writer — the bug this exists to prevent.

Two limits worth knowing:

- **The claim covers this library's writers, not every writer.** It cannot
  coordinate a human with an editor open on the file, a backup restore, or a
  second tool. The save re-checks the file's hash immediately before committing
  and retries on top of any change it did not make, but that is best-effort
  against a writer that ignores the file entirely.
- **Counter fields merge by `max`, not by sum.** Two processes promoting on the
  same day each increment `meta.promotions` from 5 to 6; the merge keeps 6, so a
  concurrent pair can undercount by one. Per-pattern evidence is unioned
  exactly — nothing recorded is dropped. Counters here are observability, not
  data, and `max()` can never over-report.

Because the merge preserves anything it did not see, **removing a `meta` key
needs `removeMetaKey(index, key)`**, not `delete index.meta[key]`. Absence is
ambiguous — it means "never saw it" — so a bare `delete` is silently undone by
the next merge. Pattern deletions are different: `dedupe` tombstones them in
`meta.absorbedPatterns`, and that record is load-bearing. Do not prune it.

**By default nothing is encrypted.** The index and the session working-memory
files contain verbatim agent output: absolute filesystem paths, provider and
model names, task ids, agent identity, and whatever a user's claim happened to
contain. Out of the box those files are written mode `0600` — owner-only, so
they are not readable by other accounts on a shared machine. That is a
file-permission boundary, not encryption. On a multi-user or multi-tenant host,
anything that can run as your user can read them, and a backup, a sync client,
or a `patterns-index.json` committed to a repo will carry the same content
everywhere it goes. **If you do not set `OMEGA_MEMORY_PASSPHRASE`, your memory is
plaintext on disk.**

**Optional encryption at rest, off unless you turn it on.** Set
`OMEGA_MEMORY_PASSPHRASE` and both stores are sealed with **AES-256-GCM** from
`node:crypto` — no new dependencies, so the zero-dependency property is intact.
The passphrase is run through **scrypt** (N=16384, r=8, p=1) with a per-file
salt; the IV is random on every write; the authentication tag is verified on
every read. A sealed file is a single line beginning `POLYMEM-ENC-V1`, so you
can tell at a glance whether a store is sealed:

```bash
export OMEGA_MEMORY_PASSPHRASE='a long passphrase'
node -e "await import('./src/polymem.mjs').then(m=>m.savePatternsIndex(m.loadPatternsIndex()))"
head -c 14 ~/.computer-agent/memory/patterns-index.json   # POLYMEM-ENC-V1
```

What it **does** protect: the contents of the index and session files against
anything that reads the bytes without the passphrase — a stolen disk, a synced
folder, a backup, a repo, another account on the host, another process running
as you.

What it **does not** protect, and this is the part to read before relying on it:

- **Anything running as you, right now.** A key in an environment variable is
  readable by every process you can read, and by anything that can read
  `/proc/<pid>/environ` or your shell history. Encryption at rest protects data
  *at rest*; it does nothing against code executing as the same user.
- **Your shell history and your process list.** Export the passphrase from a
  secrets manager or a `.env` you keep out of git, not from a typed command
  line.
- **Tampering is detected, not rolled back.** A modified ciphertext is rejected
  loudly, which is a real guarantee (see below). There is no backup and no
  recovery, so a rejected read is a read you must fix by restoring the file
  yourself.
- **It is not a compliance control.** No audit trail, no key rotation, no
  separation of duties, no attestation. Treat it as "the file is not readable
  text anymore", which is exactly what it is.

**Both stores are sealed, or neither is.** A promoted pattern's claim text lands
first in the session working-memory file and only then in the index
(`promoteSession` reads the session file and writes the index). Sealing only the
index would leave every promoted claim readable in the clear one directory over,
so the boundary is deliberately uniform: one flag, both stores. There is no
configuration in which the index is sealed and a session file is not.

**Turning it on does not rewrite history.** A store written before you set the
variable keeps loading unchanged, and reading it does not migrate it. Each file
is sealed the next time it is written. So a store with history is briefly mixed
— old files plaintext, new ones sealed — and it becomes uniformly sealed only as
files come up for rewrite. If you need it uniform now, rewrite the files once
while the variable is set. A sealed file read *without* the variable set fails
loudly rather than returning an empty index, so you cannot lose data by
forgetting to export it.

**If you lose the passphrase, the data is gone.** There is no recovery path, no
escrow, no fallback to plaintext, and no way to tell a lost passphrase from a
tampered file — GCM cannot distinguish them, and guessing would be worse than
failing. A wrong passphrase, a missing one, and a flipped byte in the ciphertext
all produce the same loud failure: a `DecryptionError` with
`code: 'DECRYPTION_FAILED'`, thrown rather than returned. This is deliberate and
is the property worth knowing about:

> A read that cannot decrypt **throws**. It never returns an empty index.

That is the whole design of the read path. Returning `{}` on a decryption
failure would be the worst possible outcome — the caller would believe its
memory was empty, and the next save would overwrite a full index with an empty
one. Measured against the pre-encryption build: with a wrong passphrase set, the
old code returned the index in plaintext with no error at all. Failing soft on
the sealed path would introduce the data loss the feature exists to prevent.
Note the deliberate asymmetry — a **corrupt or unreadable plaintext** file
still degrades to an empty index and logs to stderr, exactly as before. Only the
sealed path is fatal, because only there does "I could not read it" risk
destroying it.

**What this means for callers.** `loadPatternsIndex`, `loadWorkingMemory`, and
therefore `appendWorkingMemory` and `promoteSession` can now throw a
`DecryptionError` where they previously always returned. That is the intended
behaviour, and it is caught by identity:

```js
import { loadPatternsIndex, DecryptionError } from 'polymem';
try {
  const idx = loadPatternsIndex();
} catch (e) {
  if (e instanceof DecryptionError) {
    // Wrong or missing passphrase, or a modified file. Do NOT continue: a
    // save from here would overwrite the real store. Surface it and stop.
    logger.error({ err: e }, 'memory index unreadable — refusing to overwrite it');
    return;
  }
  throw e;
}
```

The write path is unchanged and still never throws: `savePatternsIndex` and
`saveWorkingMemory` continue to log once and return `false`. A read failure and
a write failure are treated asymmetrically on purpose — one risks destroying the
data, the other merely loses it.

So: back up the passphrase as carefully as you back up the data. Store it
somewhere other than the machine, because a passphrase that only exists in the
environment of the machine it protects is one reboot away from being lost.

The write claim sits next to the index as `<index>.claim` and contains only a
pid, a hostname, and a timestamp — no memory content. It is transient, but on a
shared machine that pid and hostname are visible to other accounts for the
lifetime of the write.

---

## The simulation harness (`sim/`)

> **Status: in development, not yet committed.** The files exist in the working
> tree and are being finished on a sibling task. What follows was read from
> `sim/run.sh` and `sim/run.mjs` directly, not guessed — but treat the details
> as provisional until that task lands, and re-check them against the source
> before you rely on any of it. `sim/` is **not** in the npm `files` allowlist,
> so it can never ride into a published tarball.

Polymem's test suite proves mechanisms work: parse this, write atomically,
contain that path. It does **not** answer "given a realistic, messy day of agent
output, does this library hold up?" — which is exactly the question that let
`casual-greeting` sit in a live index while 182 assertions stayed green.

`sim/` is the instrument for that question. It runs Polymem, through its public
API only, inside a pinned Docker container against generated bot personas with
deliberately different memory-writing styles (chatty, terse, noisy, degenerate,
knowledgeable), a deterministic hostile-input suite, and a real multi-process
concurrency case.

**One command:**

```bash
./sim/run.sh
```

That builds the pinned image, runs the suite in the container, copies the JSON
report out, and prints the verdict.

**The verdict line is the whole interface for CI:**

| Line | Exit | Meaning |
|---|---|---|
| `SIM: CLEAN` | 0 | No crash, no hang, no swallowed error, no prototype pollution, no lost update, and nothing the judge called noise reached the index. |
| `SIM: FOUND n ISSUES` | 1 | `n` issues were recorded. The JSON report separates `BLOCKER`s from `FINDING`s, and lists every issue with the persona and input that caused it. |
| `SIM: BLOCKED — the suite did not run` | 2 | The harness could not run at all — in practice, Ollama is unreachable. |

**BLOCKED is a real state, not an error to ignore.** The simulation generates
every persona with a real model and has no fixture fallback, so if Ollama is
down it fails with a named cause and a fix instead of quietly degrading to
green. If you see `SIM: BLOCKED`, read the message before drawing any
conclusion: nothing was tested.

```bash
ollama serve                      # start the server
ollama pull qwen2.5-coder:14b     # make sure the model exists
ollama ps                         # confirm nothing is mid-load
./sim/run.sh                      # then re-run
```

Point it at a different model with `SIM_MODEL=qwen2.5vl:7b ./sim/run.sh`. The
report is written to `sim-report.json` at the repo root; `sim-out/` holds the
scratch data.

Two design rules the harness holds itself to, because their opposites have
already cost this project time: **no silent degradation** (a harness that
quietly degrades converts "I could not test this" into "I tested this"), and
**no unlabeled judgment** (promoted patterns are classified knowledge/noise by
an independent model that has never seen the library's filter, and that judge is
calibrated against undisputed labels before its verdict is recorded — an
uncalibrated judge's opinion is decoration).

---

## How this repo verifies its own claims

This project has been bitten by documentation drift before, in a specific and
embarrassing way: `README.md` claimed **270 assertions across 10 suites** while
`npm test` reported **346 across 12**, because the number lives in prose and
nothing connected it to the code. A wrong number in a README is not cosmetic —
it is often the only number a stranger has.

So the claims in this file are checked, not trusted:

```bash
npm test              # the suite
npm run docs:check    # every number in the docs vs. what actually runs
```

[`tools/check-doc-claims.mjs`](tools/check-doc-claims.mjs) runs the suite and
`npm pack --dry-run`, then verifies:

- the assertion/suite count in [Status](#status) equals what just ran;
- every per-suite assertion count quoted in `CHANGELOG.md` equals what that
  suite reported;
- the floors named in `.github/workflows/ci.yml` match `test/suite-floors.mjs`;
- the captured output block above is byte-identical to a fresh run of
  `tools/readme-example.mjs`;
- every TOC anchor resolves to a real heading (19 hand-written links are 19
  chances to 404 within the page);
- the "DRAFT — NOT PUBLISHED" banner is still on both release drafts, so a
  verified-looking draft can never be mistaken for a publishable one;
- the known false negatives the README names still pass the filter (if a future
  improvement fixes one, the doc gets updated instead of lying);
- `npm pack --dry-run` ships exactly the public files and nothing else;
- the suite is green right now — a doc guard over a red suite is decoration.

The one design rule worth knowing, because it is the bug the guard had to avoid
in itself: **an unreadable claim is a failure, not a skip.** If the README
deletes its assertion-count sentence, or the captured-output markers, this
script fails loudly rather than reporting a clean bill of health for a check it
never performed. A guard that cannot tell "the doc is wrong" from "I could not
read the doc" will be believed to be passing either way.

Reproduce the promotion-defect measurements yourself:

```bash
node tools/real-corpus-probe.mjs      # AFTER (current HEAD)
node tools/readme-example.mjs         # the block above, live
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: `npm test` must stay
green, a new test suite must register an assertion floor or the run fails, any
fix needs a proof it fails without the fix, and the shipped package stays at
zero dependencies.

---

## Status

Polymem runs in production inside OmegaShell. It processes real agent output,
promotes real patterns, and serves real queries. It has 548 assertions across 16
suites and CI on Node 18 and 20.

That number is not maintained by hand. `npm run docs:check` fails if it drifts.

This library is **pre-1.0**. The API may change.

---

## License

MIT © 2026 Josh Watson