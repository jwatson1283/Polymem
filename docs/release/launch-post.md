<!--
  ============================================================================
  DRAFT — NOT PUBLISHED. DO NOT POST ANYWHERE WITHOUT EXPLICIT GO-AHEAD.
  ============================================================================

  This is a draft launch post held in the repository. It has NOT been posted to
  Hacker News, Reddit, or anywhere else. No repository exists PUBLICLY yet:
  github.com/jwatson1283/Polymem was created 2026-10-01 and is `private: true`,
  so an unauthenticated request — a reader, a search engine, HN — gets a 404.
  No announcement has been made.

  Before posting: confirm the repo URL is live, re-measure the numbers (they are
  from a run of 437 assertions / 14 suites), and check the title still fits the
  platform's rules — HN in particular is strict about marketing framing, and the
  second title option below is the safer one there.

  Word count: 597 words of body prose (measured, excluding the title options
  and the posting notes below). Within the 300-600 range requested.
  ============================================================================
-->

# Launch post (DRAFT, not posted)

Platform: Hacker News, then Reddit (r/LocalLLaMA, r/AI_Agents, r/opensource).

**Title options, HN first:**

1. *"I had my agent memory library adversarially audited. It found five real bugs, including one that was silently deleting data."*
2. *"Zero-dependency agent memory in plain JSON files — then I broke it on purpose five times"*

HN prefers 2; Reddit tolerates 1. Do not use 1 on HN — it reads as a
manufactured hook and that is how a launch gets downvoted into nothing.

---

I built a memory library for AI agents and then tried to break it. It had five
real bugs, and one had been quietly deleting data for months.

**Polymem.** An agent's memory learns *which techniques keep working*, stored as
plain JSON files. Zero dependencies — `src/` imports nothing but Node builtins.
No database, no server, no embeddings. The memory is a file you can open in an
editor, diff, and commit.

Most agent memory systems store everything and retrieve by similarity, which
makes them a log. Polymem promotes a pattern only after 3+ sessions across 2+
domains, and demotes it when contradicted — a record of what has held up.

Then I had someone break it on purpose.

- **Silent data loss.** Every save published a whole snapshot; last writer won.
  With 8 processes saving at once, **between 1 and 7 of 8 patterns survived**
  (most often 3 of 8 — it is a race, so the count moves run to run) — valid
  JSON, and every writer reported `saved: true`. The obvious fix (hash-compare-then-rename)
  I implemented faithfully and it got worse: 2 of 8, then 3, then 1, because
  `rename()` is unconditional. The real fix was a read-modify-write under an
  exclusive write claim. Now 8 of 8.
- **Path traversal via the session date**, on read as well as write. Three path
  segments and `loadWorkingMemory` returns any JSON file the process can already
  reach — no write permission needed, so it is the cheaper abuse.
- **Prototype pollution from model output.** A header reading `### constructor`
  crashed the parser. No attacker required: a model only has to emit the word.
  Two other functions wrote onto `Object.prototype` — process-wide.
- **The npm tarball shipped everything** — no `files` field, so internal design
  docs and the test suite went out with the library, and anything else at the repo
  root went too. Measured: 12 files then, 7 now.
- **The files were mode `0644`** while holding absolute paths and task ids. Now
  `0600`.

The fifth is worth pausing on, because it was not a security bug. The filter
deciding what counts as knowledge existed, was exported, was documented — and had
**zero callers inside the library**. It was a filter the consumer had to remember
to invoke. Meanwhile a live index filled with `casual-greeting` and
`miscounting-words-in-constrained-length-response`, and a human quarantined 24
patterns by hand. Every assertion stayed green, because every test asked "did
each mechanism work?" and none asked "is the resulting index worth reading?"

The fix moved the gate onto the promotion path so it is structural rather than
advisory, then measured it against six sessions of *real* model output: noise
promoted 15 → 0, knowledge kept 8 of 8.

What I could not fix: the filter is lexical, so of 85 real quarantined names it
rejects 74 and **11 still get through**, 7 still noise. Closing those needs a
judge — embeddings or an LLM call — and this library rules both out. So the
ceiling is a number in a test, with the 4 survivors that are plausibly *good*
knowledge protected separately.

Two things I would rather say than have you discover.

Retrieval is **keyword substring matching**. "serialize concurrency" finds the
pattern. "how do we avoid losing writes" returns **nothing** — though the index
holds a pattern answering it exactly. If you need fuzzy recall, wrong library.

And nothing is encrypted by default: plaintext at `0600`, a permission boundary
rather than encryption. Optional AES-256-GCM exists; lose the passphrase and the
data is gone, by design.

437 assertions, 14 suites, no dependencies. MIT.

**Before you install:** the README's "When NOT to use this" is the most useful
page in it. If you need semantic retrieval, multi-user isolation, or compliance
controls, this is not the tool.

Repo and install instructions in the comments.

---

## Posting notes (not part of the post)

- **Do not claim** any benchmark comparison. There is no head-to-head benchmark
  against Mem0, Hindsight, or anything else, and the README's comparison table is
  explicitly framed as positioning, not measured results.
- **Do not claim** users, stars, production adoption numbers, or that anyone
  depends on it. It runs in production inside one internal project (OmegaShell)
  and that is the whole of it.
- The "adversarially audited" framing is accurate — the defects were found by
  deliberately breaking the code — but do not imply an external security
  professional reviewed it. Nobody has. SECURITY.md says so explicitly.
- If asked "why not just use a vector DB?": the answer is the evidence gate and
  demotion, not the retrieval. If you need retrieval, use a retrieval system. That
  is a real answer, not a dodge — but only give it if you would also happily
  tell someone the vector DB is the better choice for their use case.