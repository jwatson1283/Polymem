# Polymem — where it came from, how it works, when to use it

Three questions, answered in plain language. Every figure here is measured and
traceable to the shipped repo or to Professor's own session on 2026-09-23. Nothing
in this document is reconstructed from memory.

---

## 1. Where it came from

### It started as a research question, not a product idea

On **2026-09-23**, Professor was asked to look at how AI memory should work. The
brief was ordinary: review the existing memory approaches and recommend one.

What came back was not a comparison. Professor found a definition of *polymathic
cognition* that reframed the question entirely.

The load-bearing line, from Don Gunter's April 2026 essay *The Polymathic Mind*
(quoted by Professor, cited in session `20260817_174314_992db4`, 16:12:50):

> "The defining characteristic of polymathic cognition is not breadth of
> knowledge. It is the **simultaneous recognition of structural identity across
> domains.**"

That inverts the usual framing. The polymath is not someone who knows eight things
instead of one. It is a **different architecture** — one that holds the
*structural correspondence* between domains in immediate register, as a felt
recognition that these are instances of the same shape.

Professor's second finding from that same session: a polymath runs a
**high-bandwidth consistency check across every held domain simultaneously**. A
claim about music theory gets checked against mathematics. A claim about ethics
gets checked against thermodynamics. That is where the strength comes from — and
where the cost comes from, because it is slow and expensive to run.

### The mapping onto memory

Professor's architectural translation (16:16:17 in the same session):

| | |
|---|---|
| A specialist memory stores | "Event E happened on date D in domain X." |
| A polymathic memory stores | "Event E is an instance of pattern P. Pattern P also appears in domains A, B, C. Here are the correspondences, and here is what differs." |

That single sentence is Polymem. Everything else is consequence.

### The obvious competitor was considered and deferred

The same research pass looked hard at **Hindsight** (Vectorize.io), which does
consolidation, contradiction detection, and multi-strategy retrieval. It was
evaluated seriously as the long-term base.

It lost — not on capability, on **cost and fit**. The plan recorded the decision
as: stay file-based, zero infrastructure, zero new dependencies, no LLM calls
during consolidation. Hindsight remained a documented option, gated on two
measurable triggers rather than dismissed: pattern count above ~200 *and*
keyword queries visibly missing, **or** manual dedup becoming a chore.

**Both triggers are still unfired.** The index has never held 200 patterns.

### The part nobody planned: it failed at its own job

The system ran in production inside OmegaShell and looked healthy — green suite,
growing index, five promotions. Then someone read what it had actually stored.

**All 24 patterns it had promoted were quarantined by hand on 2026-09-25.**

What they were:

```
casual-greeting
direct-minimal-response-to-simple-greetings
five-word-salutation
miscounting-words-in-constrained-length-response   (+6 near-duplicates)
```

A week of real work, and the memory system had remembered that agents say "hi"
and miscount words.

**182 assertions stayed green the whole time.** No test could have caught this,
because every test used fixtures a human had tidied. It took a week of unfiltered
real output to find it — and that is now a number in the test suite rather than a
story.

The filter that resulted rejects **74 of the 85 real quarantined names**. It is
deliberately not tightened further: 11 still pass, and 4 of those are real
knowledge that a stricter rule would eat:

- *Intra-session contradiction tracking*
- *Chief of Staff handles simple direct requests without delegation*
- *Edge computing architecture prioritizes privacy, latency, and offline resilience*
- *Generate and review code snippets*

All 11 are enumerated verbatim in `test/test-real-corpus.mjs`, and the 4 are
asserted separately — so the filter's ceiling can neither silently improve nor
silently destroy something worth keeping.

---

## 2. How it functions

### The two shelves

**Working memory** — this conversation. Raw, disposable, discarded fast.

**The patterns index** — what survived long enough to prove itself. This is the
whole product, and it is a JSON file you can open.

### What happens when an agent finishes

1. **Decompose.** The agent's output is parsed for claims and candidate patterns.
2. **Check the gate.** Names matching chatter, greetings, status lines, or task
   restatements are rejected here — *structurally, inside `promoteSession`*, so a
   consumer who forgets to gate still gets a filtered index. Rejections are
   **counted in `index.meta.patternGate`, not deleted**, so an operator can see
   what was dropped and why.
3. **Deduplicate.** Near-identical names merge, carrying their evidence forward
   rather than piling up.
4. **Test against what's known.** Does this match a pattern already held?
5. **Count independent recurrence.** This is the gate that matters. A pattern must
   surface across **independent sessions** — 3+ sessions *and* 2+ domains for
   `established`, 2+ of either for `candidate`. The same agent repeating itself in
   one chat does not count.
6. **Demote on contradiction.** A pattern that gets contradicted drops back to
   candidate. Nothing is permanent.

### The part that makes it trustworthy

Every drop is recorded with a reason. A system that quietly discards things is
worse than one that keeps everything, because you cannot tell the difference
between "nothing learned" and "everything was thrown away."

### Plain files, deliberately

No database. No embeddings. No daemon. No LLM call during write or promotion.
`src/` imports only `node:fs`, `node:path`, `node:crypto`, `node:os`. The tarball
is 7 files and about 30 kB.

That is not minimalism for its own sake. It means the memory can be **read,
edited, committed, diffed, and deleted by hand** — and it means it survives
as evidence rather than as a service you have to keep alive.

---

## 3. When to use it

### Use it when

- **Your agent keeps re-learning the same lesson.** If it rediscovers the same
  gotcha every week, this is the thing that stops that.
- **You want the memory readable and editable.** Open the file, fix a pattern,
  commit it. That workflow is impossible against a vector store you cannot query
  by hand.
- **You cannot run infrastructure.** No Postgres, no account, no daemon, no
  embeddings pipeline.
- **The memory must survive as evidence.** Plain files diff in git. A database
  does not.
- **It is one person or one agent.** That is the actual design centre.

### Do not use it when

Straight from the README, not softened:

- **You need semantic recall.** It matches words, not meaning. Ask it *"how do I
  avoid losing writes"* and it returns nothing while *"serialize concurrency"*
  finds the right pattern. **This is the limitation that will bite you first.**
- **You need facts about people, entities, or relationships.** It is not a fact
  store and has no entity model.
- **You need a knowledge graph.** The correspondence layer is flat strings, not
  a queryable graph. Cross-domain structural identity — the idea this whole
  project came from — is **designed but not implemented.**
- **You need multi-user or multi-tenant isolation.** One index, one session
  directory, no `user_id`.
- **You need compliance-grade encryption at rest.** Files are plaintext at
  `0600` unless you set the passphrase option, and that option is a convenience,
  not a compliance control.
- **You are on a network filesystem.** The atomicity the write depends on is a
  POSIX property. On NFS the behaviour degrades towards last-writer-wins.
- **You are on Windows and need the write claim.** The claim uses `O_CREAT|O_EXCL`
  precisely because `flock(2)` does not exist there. POSIX ownership semantics are
  what's actually relied on, and that has only been exercised on macOS, Linux,
  Alpine and Debian.

### The honest summary

**If your problem is retrieval, use a retrieval system.** Mem0, Hindsight, and
LangChain memory are sophisticated retrieval tools and they are better at
retrieval than Polymem will ever be. Polymem is not competing with them. It answers
a different question: *which of the things I've learned have earned trust?*

---

## 4. What is not finished

- **Demotion thresholds are untuned.** 3+ sessions and 2+ domains are initial
  values, not empirically calibrated.
- **Cross-domain correspondence is designed, not built.** This is the original
  insight and it is the largest gap.
- **The computer-activity tier is a design document.** Observing the user's screen
  to learn habits is specified and unbuilt.
- **Threshold variance is measured, not solved.** The pre-fix concurrency result
  was between 1 and 7 of 8 depending on scheduling — a range, because a single
  figure would be an artifact of one run.

---

*Sources: Professor session `20260817_174314_992db4` (2026-09-23), the Polymem
README at `Polymem-clean`, `docs/2026-09-23-polymathic-memory-plan.md`, and
`test/test-real-corpus.mjs`.*
