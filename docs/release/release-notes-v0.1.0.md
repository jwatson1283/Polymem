<!--
  ============================================================================
  DRAFT — NOT PUBLISHED. DO NOT PUBLISH WITHOUT EXPLICIT GO-AHEAD.
  ============================================================================

  Everything in docs/release/ is a draft held in the repository. Nothing here
  has been published: no GitHub release, no npm publish, no repository created,
  no remote configured, no announcement posted.

  Publishing requires a per-instance decision from Josh, not a standing order.
  Before any of this ships, re-measure every number — the suite is moving, and
  these drafts were written against 437 assertions / 14 suites.

  To publish a release later:
    1. Re-run `npm test` and `npm run docs:check`. Both must be green.
    2. Re-run `npm pack --dry-run` and confirm the file list below is still right.
    3. Update the counts in this file from that run, not from memory.
    4. Only then: make the repo public (it exists but is `private: true`, so an
       unauthenticated reader still gets a 404), tag, publish.
  ============================================================================
-->

# Release notes — v0.1.0 (DRAFT, not published)

**Status: draft. Nothing published.** Held in the repo pending an explicit
go-ahead.

**Measured at time of writing:** 437 assertions / 14 suites, 0 failing. 7 files in
the published tarball. Node 18 and 20 in CI. **Re-measure before publishing** —
the suite is moving and these numbers will be stale.

---

## Two-tier memory for AI agents. Zero dependencies. No vector database.

Polymem gives an agent a memory that learns **which techniques keep working**,
and stores it as plain JSON files you can read, diff, edit, and delete.

It is not a vector database and it does not do semantic search. It answers a
narrower question, and if you need fuzzy recall you want a different library —
[see "When NOT to use this"](https://github.com/jwatson1283/Polymem#when-not-to-use-this).
Read that before installing.

### Why it is different

Most agent memory stores everything and retrieves by similarity. Polymem
promotes a pattern only when it has **accumulated evidence across sessions and
domains**, and demotes it when it is contradicted. A pattern that recurs in one
session three times does not promote; a pattern seen in three sessions across
two domains does.

That is the whole idea: a memory system that stores everything is a log, and one
that promotes on evidence is a record of what has held up.

Three properties that follow from the implementation:

- **Zero dependencies.** Not zero-ish. `src/` imports nothing but `node:`
  builtins. There is nothing to resolve, nothing to audit, nothing to keep
  current.
- **No server, no database, no infrastructure.** The index is a JSON file. When
  you want to know what your agent knows, you open it in an editor.
- **Readable, editable memory.** Not a blob in Postgres. You can commit it, diff
  it, hand-edit it, or delete it.

### Install

```bash
npm install polymem
```

Node >= 18. No other requirements.

### Verify it yourself

```bash
npm test              # 437 assertions across 14 suites
npm run docs:check    # does the README still describe this code?
```

The second command exists because this project shipped a README claiming 270
assertions while the suite ran 312, and nobody noticed for fourteen commits.
Numbers in prose drift because prose and code live in different places. So every
number in the docs is checked against a live measurement in CI, and the check
fails loudly when a claim is unreadable rather than passing quietly for a check
it never performed.

### What is fixed

Five real defects, found by deliberately breaking the library, each reproduced
before and after and each now covered by a regression test that fails against
the old code:

1. **Silent data loss under concurrency** — 8 processes saving at once left
   **between 1 and 7 of 8** patterns present (most often 3 of 8; the count is a
   race outcome, so it is a measured range over 120 runs and not a single
   figure); valid JSON, every writer reporting `saved: true`.
   Now 8 of 8.
2. **Path traversal through the session date**, on read *and* write. Now refused
   on both paths.
3. **Prototype-chain pollution from model output** — a `### constructor` header
   crashed the parser on the per-response path.
4. **The npm tarball published everything** — no `files` field, so the test suite
   and internal design docs shipped with the library (measured: 12 files). Now
   exactly 7.
5. **World-readable memory files** — mode `0644` on data containing absolute
   paths and task ids. Now `0600`.

### Known limitations, stated plainly

- **Retrieval is keyword substring matching.** No embeddings. A query like
  "how do we avoid losing writes" returns **nothing** even when the index holds a
  pattern that answers it exactly. This is the single most important thing to
  know before you build on it.
- **Nothing is encrypted by default.** Files are plaintext at `0600` — a
  permission boundary, not encryption. Optional AES-256-GCM sealing is available
  and off unless you set `OMEGA_MEMORY_PASSPHRASE`. If you lose that passphrase
  the data is unrecoverable, by design.
- **The pattern filter is lexical and has a measured ceiling.** Over 85 real
  quarantined names it rejects 74; 11 still pass, 7 of them still noise. Closing
  those 7 needs a judge, and this library rules one out: no embeddings, no LLM
  calls, no dependencies.
- **No multi-user isolation.** One index file, no scoping key.
- **Not audited, not certified, no bug bounty.** No third-party security review
  has been performed.

Full list: [What is NOT done yet](https://github.com/jwatson1283/Polymem#what-is-not-done-yet)
and [SECURITY.md](https://github.com/jwatson1283/Polymem/blob/main/SECURITY.md).

### Requirements

Node >= 18. MIT licensed. Pre-1.0 — the API may still change.

### Honest positioning

Against Mem0 and Hindsight, Polymem is not a competitor on recall and does not
pretend to be one. Those are sophisticated retrieval systems using embeddings
and, in Hindsight's case, a cross-ranker. Polymem is a **pattern ledger** with an
evidence gate and a demotion path — a status machine they do not implement,
because their job is recall and this one's is adjudication. The trade is
deliberate: far less capability, zero infrastructure, readable files.