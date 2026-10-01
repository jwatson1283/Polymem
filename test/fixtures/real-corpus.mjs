// test/fixtures/real-corpus.mjs
//
// A CORPUS OF REAL CONTENT, NOT "HELLO WORLD".
//
// WHY THIS FILE EXISTS. Every other fixture in this repo is synthetic: a pattern
// name typed to make an assertion pass. That is fine for testing a status
// machine, and it is exactly why a 182-assertion suite (now 270) shipped a
// library whose live corpus promoted "casual-greeting" and
// "miscounting-words-in-constrained-length-response". Synthetic fixtures cannot
// fail in the direction that matters, because their content was chosen by the
// person writing the assertion.
//
// So this corpus is written the way a real model writes when it is doing real
// work for Josh: substantive claims about agent orchestration, memory
// architecture, security findings and deployment practice, MIXED AT THE REAL
// RATE with the noise a live corpus actually contains — greetings,
// acknowledgements, restatements of the ask, transient status, and the agent
// narrating its own output quality.
//
// The noise is not padding. It is the control. A filter that rejects this
// corpus's noise AND keeps its knowledge is doing something; a filter tuned to
// this file's exact strings would pass today and fail on tomorrow's corpus.
//
// FORMAT. Each session is the raw text a model emits: display prose followed
// by a ```memory fence. The suite runs parseMemoryBlock over it, so this file
// exercises the real parse path rather than handing the library pre-parsed
// objects it would never see.
//
// DATES. 2026-10-02..07, deliberately outside the live corpus's window so a
// test run can never collide with ~/.computer-agent state.

export const CORPUS_DATES = [
  '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
];

// ── Knowledge that MUST survive the filter ───────────────────────────────────
// Each session's real content. Recurring across sessions by design, because a
// pattern that only ever appears once cannot reach `established` and would
// therefore prove nothing about a filter.
//
// THE NOISE BELOW IS FED TO THE LIBRARY. An earlier draft of this fixture kept
// MUST_DROP in a separate list that was never emitted in any session, and the
// probe then reported "rejected 15/15" — measuring that the corpus did not
// contain the noise, not that the filter rejected it. That control could not
// fail, which is the no-op-in-a-different-costume defect this repo has been
// bitten by before (see 10_BRAIN researcher-lobe, "The Negative-Control
// Defect"). Every MUST_DROP name now appears verbatim in a session below, so
// the obligation is measured against text the library actually saw.
export const SESSIONS = [
  {
    date: '2026-10-02',
    raw: `Traced the memory pipeline end to end and found the real defect.

\`\`\`memory
### Claims
- Omega routes all Omega-team work through hermes because hermes is the lead — domains: ops
- The kanban board is a shared SQLite database, not per-agent state — domains: code, ops
- Memory promotion requires 3 sessions and 2 domains before a pattern is established — domains: code
- Josh's standing order is no push and no publish without explicit approval — domains: ops
### Patterns
- Serialize read-modify-write under a single write claim — domains: code, ops
- Evidence-gated promotion defers trust until a pattern recurs — domains: code
- Casual greeting — domains: comms
- Miscounting words in constrained-length responses — domains: code, comms
### Contradictions
\`\`\``,
  },
  {
    date: '2026-10-03',
    raw: `Hi — continuing the memory architecture review.

\`\`\`memory
### Claims
- A pattern promoted on one session is a candidate, never established — domains: code
- Josh treats a green test run as necessary but not sufficient evidence — domains: ops
- Concurrent writers to one index lose updates unless the save merges — domains: code, ops
### Patterns
- Serialize read-modify-write under a single write claim — domains: ops
- A claim about the conversation is not durable knowledge — domains: code
- Standard greeting response. — domains: comms
- The task was completed by the researcher — domains: ops
- Word Constraint — domains: code
### Contradictions
\`\`\``,
  },
  {
    date: '2026-10-04',
    raw: `Two security findings in the memory store, both worth fixing.

\`\`\`memory
### Claims
- A model-supplied key that indexes a plain object can reach Object.prototype — domains: code
- Session dates become filenames, so an unvalidated date is an arbitrary-path primitive — domains: code
- Memory files hold agent output verbatim, so mode 0600 is a disclosure control — domains: ops
- Josh prefers direct action over a plan document — domains: ops
- The user prefers concise responses — domains: comms
### Patterns
- Use own-property checks for any key derived from model output — domains: code, ops
- Validate a path segment at the single point it becomes a path — domains: code
- Simple greeting task — domains: comms
- Friendly greeting — domains: comms
- Running the deploy checks now — domains: ops
- Connection is live — domains: ops
- Task processing pattern: The system processes tasks sequentially or concurrently based on configuration — domains: design, ops
### Contradictions
\`\`\``,
  },
  {
    date: '2026-10-05',
    raw: `Acknowledged. Running the deploy checks now.

\`\`\`memory
### Claims
- A dirty worktree makes the sanctioned deploy unreachable — domains: ops
- One writer per file prevents interleaved edits in a shared checkout — domains: code, ops
### Patterns
- Refuse the deploy when the tree is dirty rather than stashing — domains: ops
- Simple greeting pattern — domains: comms
- Short welcoming message — domains: other
- Five-word salutation — domains: comms
- Minimalist greeting acknowledgment — domains: comms
- The user prefers concise responses — domains: comms
- Miscounting words in constrained-length response. — domains: code
### Contradictions
\`\`\``,
  },
  {
    date: '2026-10-06',
    raw: `Fixed the prototype hazard and confirmed the own-property guard.

\`\`\`memory
### Claims
- Merging two indexes must keep patterns the caller never saw, or it is a lost update — domains: code
- Encryption at rest is opt-in because a sealed file with a lost key is unrecoverable — domains: ops
- A counter merged by max can undercount by one under a concurrent pair — domains: code
- Josh wants errors and learnings saved immediately, not at session end — domains: ops
### Patterns
- Use own-property checks for any key derived from model output — domains: code
- Merge the caller's snapshot with what is actually on disk — domains: code, ops
### Contradictions
\`\`\``,
  },
  {
    date: '2026-10-07',
    raw: `Final pass on provenance and the audit trail.

\`\`\`memory
### Claims
- A promoted pattern must be reconcilable against the session record that produced it — domains: code, ops
- Absence of provenance is recorded as unknown and never inferred — domains: code
- Josh's default is free local models; a paid API is the escape hatch — domains: ops, finance
### Patterns
- Record provenance in the same write as the claim, because it cannot be reconstructed later — domains: code, ops
### Contradictions
\`\`\``,
  },
];

// ── The filter's obligation, stated so a test can check it ───────────────────
//
// KNOWLEDGE: pattern names a human would want remembered, i.e. it is about
// Josh's work, decisions, preferences or system state.
// NOISE: the classes the 2026-09-25 quarantine actually contained.
//
// These lists are the contract. If the filter starts rejecting a KNOWLEDGE
// name, that is a regression even though every assertion would otherwise pass.

export const MUST_KEEP = [
  'Serialize read-modify-write under a single write claim',
  'Evidence-gated promotion defers trust until a pattern recurs',
  'A claim about the conversation is not durable knowledge',
  'Use own-property checks for any key derived from model output',
  'Validate a path segment at the single point it becomes a path',
  'Refuse the deploy when the tree is dirty rather than stashing',
  'Merge the caller\'s snapshot with what is actually on disk',
  'Record provenance in the same write as the claim, because it cannot be reconstructed later',
];

// Deliberately awkward on purpose. These are the shapes a filter keyed on
// "looks technical" would wave through, and every one of them is noise:
// greeting family, agent self-narration, event log, task restatement,
// transient status, near-duplicate name variants.
export const MUST_DROP = [
  'Casual greeting',
  'Standard greeting response.',
  'Simple greeting task',
  'Short welcoming message',
  'Friendly greeting',
  'Five-word salutation',
  'Minimalist greeting acknowledgment',
  'The user prefers concise responses',
  'Miscounting words in constrained-length responses',
  'Miscounting words in constrained-length response.',
  'Word Constraint',
  'Task processing pattern: The system processes tasks sequentially or concurrently based on configuration',
  'Running the deploy checks now',
  'The task was completed by the researcher',
  'Connection is live',
];