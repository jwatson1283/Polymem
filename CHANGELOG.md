# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version `0.x` means the API may still change. Nothing here is stable yet.

## [Unreleased]

### Fixed

- **A model that quoted the fence opener in its prose lost the entire memory
  block, and lost part of its answer with it.** `parseMemoryBlock` located the
  block with `text.indexOf('```memory')` — the first occurrence of that substring
  *anywhere* in the reply. A model that mentions the opener in a sentence hit
  that mention first, the body regex ran from there, found no section headers
  inside the quoted fragment, and returned a well-formed but **empty** memory
  object. No throw, no `memory: null`, no diagnostic: the index received nothing
  and nothing anywhere said so. The simulation hit this on 3 of 6 personas while
  filing the cause as "not isolated". It is not a contrived input — the fence
  contract the harness itself sends contains the literal string ```memory inside
  its instruction text, so any persona that restates the instruction writes the
  opener into its prose. The opener is now anchored to a line whose only content
  is ```memory, and among those the last one that yields bullets wins, which
  matches the documented contract ("end your reply with EXACTLY ONE fenced
  block"). A worked example of the format shown in prose no longer wins over the
  model's real memory. Separately, `display` is computed from the same chosen
  fence, so the user-facing answer is no longer truncated mid-sentence at the
  point where the model said the word "memory" — that second harm was
  unreported by the simulation and was worse than the lost memory.

- **Four `TypeError`s in `promoteSession` on a malformed session file**, not one.
  The filed reproduction was `patterns: [null]` crashing on `.text`; measured
  against the real module the same loop head also threw on `patterns:
  [undefined]`, on `entries: [null]`, and on `entries` that was missing or not an
  array, and a *second* pass over the same data threw again on
  `.correspondences`. The existing `e.patterns || []` guard protected the array
  and nothing else — the array is fine, its elements are not — which is why only
  the innermost case was ever found. A half-written, hand-edited, or
  cross-version session file takes down the whole promotion. Every loop head now
  validates, and good patterns in a session with null siblings are still
  promoted. **Skips are counted, not swallowed:** `meta.patternGate.skipped` and
  a named `byReason` entry now record what was skipped and why, so a skip is as
  visible as a rejection. Silencing the `TypeError` would have stopped the crash
  and made the data loss invisible, which is the defect, not the fix.

- **Two disagreeing length thresholds for one field.** A bullet over 300
  characters was **discarded** while everything kept was truncated to 200 — so
  201-300 was silently shortened and 301+ was silently lost, up to 1901
  characters in a single bullet with no counter anywhere. Reconciled to one
  300-char cap that truncates and never drops. The direction is deliberate:
  these are cases where real model output was being *discarded*, so the fix keeps
  more rather than rejecting more. Truncation is now counted in
  `parseMemoryBlock().diagnostics.truncated`.

- **A silently empty memory block was indistinguishable from a bot that wrote
  nothing.** Two ordinary header shapes parsed to nothing: an *indented* header
  (`  ### Claims`) and a *bullet glued to its header* (`### Claims - the text`).
  Both are unambiguous and both now parse — Markdown indentation is not a
  different section, and keeping the header while dropping the fact was the worst
  of both outcomes. Bullets under an unknown or absent section are still not
  guessed at, but they are now **counted** (`diagnostics.droppedNoSection`,
  `droppedUnknownSection`, `unknownSections`), so a caller can tell "the model
  wrote nothing" from "the model wrote 14 bullets I could not attribute" — the
  distinction the filed finding said was impossible.

- **Non-calendar dates accepted as session keys.** `2026-13-45`, `2026-02-30`,
  `9999-99-99` and `0000-00-00` all matched the `YYYY-MM-DD` guard and were
  accepted, creating session files no caller can ever look up — the date is a
  *filename*, so "which sessions ran on the 30th" silently omits the 2026-02-30
  session. Now checked against a real calendar rather than a range: `2024-02-29`
  is accepted (leap year) and `2026-02-29` is not. No containment risk either
  way, so this was filed LOW; still throwing, still refusing, traversal guard
  untouched.

- **Two different patterns could merge into one, and fabricate the evidence
  needed to trust it.** `patternId` was `slug.slice(0, 60)`, which discarded the
  tail of a pattern's identity. Two distinct patterns sharing their first 60
  slug characters became one index key — so three sessions observing `...writes
  ALPHA` and three observing `...writes BETA` accumulated onto a single entry
  and reached `status: established`. The `near-duplicate` guard does not catch
  it: these names score 0.758 token containment, well under the 0.9 merge
  threshold, so both are accepted as genuinely distinct. A fact observed once
  was promoted to trusted on the strength of a different fact. Ids are now
  `slug` plus a short SHA-256 digest of the full slug when the slug exceeds 60
  characters, so they stay bounded and distinct. Short ids are unchanged, so
  nothing that already fits is disturbed, and **an index written by the previous
  code keeps its keys and its accumulated evidence** — a pre-fix truncated key
  is still found by name, so new sessions land on the existing pattern instead
  of minting a second entry beside it. No rewrite, no re-keying.
- **A concurrent merge could resurrect a deliberately absorbed pattern.** A
  writer that absorbed B into A recorded the tombstone; a second writer holding
  a stale snapshot that still contained B merged it back. The result was an
  index containing B while `meta.absorbedPatterns` still claimed B was
  absorbed — simultaneously deleted and live, with the tombstone being the one
  record that explained it. Both writers' tombstones are now unioned and gate
  the merge, so a stale reader can no longer undo a deliberate delete.
- **`promoteSession` reported a save it never checked.** The return value
  discarded the write's boolean, so a promotion could come back as
  `{ promoted: [...] }` while the index file did not exist — measured
  `index file written? false`. Same class as the id defect: a success signal
  outrunning the fact it reports. The result is now returned as `saved`. It is
  reported rather than thrown on purpose: the write path already degrades
  instead of failing a response when the disk is read-only, and throwing here
  would turn a read-only disk into a failed request. The caller decides.
- **A crashed writer blocked every later writer for ~3s per write, for 30
  seconds.** A claim left by a dead pid was not breakable until it was 30s old,
  and the waiter slept through its whole 5s budget anyway: 2295ms, 2474ms,
  2817ms of *blocked event loop* per write, in a module whose whole design
  premise is that it runs synchronously on the response path. None of it could
  have helped. The staleness **rule** is deliberately unchanged — a live pid is
  never declared dead, a foreign host's claim is never broken on age, and a
  claim that might still be released is still waited on. Only the futile
  waiting changed: a holder that is provably gone but not yet breakable now
  fails immediately with a message saying why it cannot be waited out. Measured
  0–2ms, with the live-pid control still waiting the full budget.
- **`queryPatterns` could not express trust, and dropped short terms in
  silence.** Terms of one or two characters were discarded with no return
  channel, so a caller could not distinguish "matched nothing" from "I ignored
  most of your query" — and a two-character *domain* term is exactly what the
  domain vocabulary is built on. Separately, a domain synonym could never match
  the normalized form it is stored under: `queryPatterns('ui')` returned nothing
  for the one pattern whose domain was `design`. Two-character terms are now
  searched, domain synonyms are searched in their stored form, dropped terms
  are reported on request, and `{ status }` filters by trust so a caller can
  ask which patterns it is actually entitled to rely on. With no options the
  return value is unchanged, so existing callers are unaffected.
- **`established` required a prose suffix the model may never write, and
  nothing said so.** Trust needs 2 domains, and domains came only from a
  `— domains: a, b` suffix in the model's memory block. Without it a pattern
  could never establish: `meta.promotions` climbed, the gate reported
  everything accepted, and the product's central promise was simply absent
  with no trace. The missing half is now inferred from the vocabulary already
  in the file. `meta.trustGate` counts what is held back and names the reason
  per pattern (`insufficientSessions`, `insufficientDomains`,
  `unresolvedContradiction`), so "why is my index full of candidates" has an
  answer. **An honest limit:** inference can only supply what the text
  actually supports. Measured against the shipped corpus, 30 of 47
  domain-declaring lines name no domain vocabulary at all and 17 name exactly
  one — including the fixture's own cross-domain line, which still supports
  only `code`, because "ops" is nowhere in its text. Inference therefore does
  *not* make the shipped corpus produce an established pattern; what it does is
  make the reason visible. A corpus that genuinely carries two-domain text is
  promoted with no code change.

### Fixed (concurrency)

- **A lost update that the concurrency fix had reintroduced inside itself.** The
  index's stale-claim breaker deleted a claim file after judging it abandoned,
  but it treated a claim it could not *stat* as abandoned. That is a writer
  racing the holder's release, not an abandoned writer, and the unlink it
  authorised removed whatever claim was at the path by then — frequently a
  different live holder. Two writers inside the "exclusive" section is the exact
  lost update the mechanism exists to prevent. With 8 barriered writers: 8 of 8
  patterns landed in 37 of 40 runs before, 8 of 8 in 80 of 80 runs after, and
  every lost run had all eight writers reporting `saved: true`. A claim that
  cannot be identified is now treated as contention, and a claim is only broken
  if it is still byte-for-byte the one judged stale.

### Documentation

- **Corrected a measurement that was quoted as a fact in eight files.** The
  concurrent-write data loss was documented as "5 of 8 survived". It is a race,
  so the count moves with scheduling: measured over 120 runs it ranged from 1 to
  7, most often 3. Every site now states the measured range. A second race — the
  shared fixed temp path — was quoted as "600 of 3000" in two files; over 30
  runs it ranged from 600 to 2400, most often 1200.
- **Corrected the pre-allowlist tarball size**, quoted as 35 files in four files.
  Measured at `322eb1f~1` it was 12. The test suite did ship, alongside two
  internal design documents.
- **Added two doc guards** (`tools/check-doc-claims.mjs`): a concurrent figure
  stated as a bare point estimate now fails, and so does a quoted tarball file
  count that does not match `npm pack --dry-run`. Both are verified by mutation —
  reverting each defect turns the corresponding check red.


### Added

- **Optional encryption at rest, off by default.** Set `OMEGA_MEMORY_PASSPHRASE`
  and both stores are sealed with AES-256-GCM from `node:crypto`; the passphrase
  is derived through scrypt (N=16384, r=8, p=1) with a per-file salt, the IV is
  random per write, and the auth tag is verified on read. Zero new dependencies —
  `src/encryption.mjs` imports only `node:crypto`.
- `DecryptionError` (exported from the package root, `code:
  'DECRYPTION_FAILED'`) and `PASSPHRASE_ENV`, so a consumer can catch a failed
  open by identity rather than by matching a message string.
- `test-encryption-at-rest.mjs` — 66 assertions covering round-trip, wrong-key
  failure, tamper detection (ciphertext, auth tag, truncation), plaintext
  backwards compatibility, lazy migration, the uniform two-store boundary, GCM
  IV hygiene, and the invariants encryption must not regress (`0600`, atomic
  write, zero dependencies).

### Fixed

- **Concurrent saves no longer lose each other's patterns.** `savePatternsIndex`
  published a whole snapshot verbatim, so two processes that each loaded the
  index, each added their own pattern, and each saved would keep only the last
  writer's file — valid JSON, every writer reporting `saved: true`. Measured on
  the pre-fix code: 8 processes adding 8 distinct patterns left between 1 and 7
  of 8 present (most often 3 of 8, measured over 120 runs — the count is a race
  outcome, so it is a range and not a figure). The save is now a read-modify-write cycle under a write claim
  (`withIndexLock`, `mergeConcurrentIndex`): it re-reads the file inside the
  claim, merges the caller's snapshot with what is actually on disk, and commits
  atomically. Re-measured with the same 8-process barrier: 8 of 8 survive.
- The claim is `open(path, 'wx')` (`O_CREAT|O_EXCL`) rather than `flock(2)`,
  which does not exist on Windows. A claim whose owner is provably dead is
  broken automatically; a claim held by a live process is never stolen, and the
  writer reports contention after a bounded wait instead of double-writing.
- `test-concurrent-writes.mjs` asserted that the last save wins "by design" —
  that was the data-loss bug written down as a requirement. Those assertions are
  inverted to require zero lost writes rather than deleted.
- `test-concurrency-rmw.mjs` — 23 assertions: a real 8-process barrier, claim
  exclusivity and portability, claim release, recovery from a dead owner's
  claim, refusal to steal a live claim, and the merge/encryption boundary.

### Changed

- The read path now distinguishes "no store yet" from "a store I could not open".
  A sealed file that cannot be decrypted **throws** instead of degrading to an
  empty index. Previously every error degraded to empty, which for a wrong key
  meant the next save would overwrite a real index with an empty one. A corrupt
  **plaintext** file still degrades to empty and logs, unchanged.
- README "Durability and privacy" rewritten to state that nothing is encrypted by
  default, what a passphrase does and does not protect, that enabling encryption
  does not retroactively seal existing files, and that a lost passphrase means
  unrecoverable data.

## [0.1.0] — 2026-09-30

First tagged-shaped release. Everything in this entry landed on 2026-09-30;
`0.1.0` is the version the package has carried since it was extracted.

### Added

- Two-tier memory core (`src/polymem.mjs`, `src/index.mjs`): memory-fence
  decomposition, per-session working memory, an evidence-gated patterns index,
  pattern query, demote/restore, and near-duplicate consolidation.
- Fixed domain vocabulary (`code`, `research`, `design`, `ops`, `finance`,
  `comms`, `other`) with a synonym table, so `coding` and `engineering` cannot
  fragment one domain into three.
- `assessClaim` — a negative-only gate that rejects claims which are provably
  not durable knowledge (self-output grading, event logs, request logs,
  infrastructure status). Deliberately does not score claim *quality*.
- `stampProvenance` — records provider, model, task, taskId, agent, and
  routeSource on every claim. Absent provenance is recorded as `'unknown'` and
  never inferred.
- `QuarantineError` and a quarantine gate inside `promoteSession`, which throws
  rather than returning an empty result.
- Atomic writes via a unique temp path plus `rename()`, with mode `0600`.
- Containment guards: runtime paths must be absolute and must resolve outside
  the package directory; session dates are validated against `YYYY-MM-DD` before
  becoming a filename.
- Prototype-safety guards (`Object.hasOwn`, null-prototype section map) on every
  key derived from model output.
- 182 assertions across 8 suites (`npm test`), with a per-suite assertion floor
  so a suite cannot silently go empty.
- CI on Node 18 and 20 (`.github/workflows/ci.yml`). No install step: the
  package has zero dependencies, so there is nothing to install.
- `npm pack` allowlist (`files`) so a scratch directory, fixture, or real
  memory file cannot ride into a published tarball.

### Changed

- `description` no longer claims `Markdown + JSON on disk`. Both write paths
  emit JSON; the Markdown half described OmegaShell's surrounding vault, not
  this package.

### Security

- Fixed a data-loss bug in concurrent writes. Two writers previously shared one
  fixed temp path, so one writer's completed payload was destroyed by the
  other's `open(O_TRUNC)`. Measured before the fix: 5 concurrent processes x
  600 patterns left between 600 and 2400 of 3000 patterns surviving (most often
  1200), and all five processes reported `saved: true`. The count is a race
  outcome, so it is a measured range over 30 runs rather than a single figure.
  Writes are now atomic and non-corrupting.
- Fixed a path-traversal primitive in both directions. The session date
  interpolated raw into a filename; a 3-segment date escaped the sessions
  directory on read and a 4-segment date on write.
- Fixed prototype pollution via model output. `index.patterns['constructor']`
  returned the inherited `Object` constructor, and `demotePattern` /
  `restorePattern` then wrote `status`, `demotedFrom`, and `demotedAt` onto
  `Object.prototype` — visible to every object in the process.
- Fixed a parser crash on a `### constructor` or `### __proto__` section
  header, which broke the documented never-throw contract on the
  per-response entry point.
- `promoteSession` now has a quarantine gate. `meta.quarantine` existed and
  nothing in the library read it, so one promote re-imported the corpus the
  quarantine exists to keep out.

### Known limitations

Carried forward from the 0.1.0 README, restated here so they are visible
without opening the README:

- Concurrent saves are now **merged** under a write claim, so overlapping writers
  no longer lose each other's patterns. Counters still merge by `max()`, so a
  concurrent pair can undercount `meta.promotions` by one, and the claim only
  coordinates writers going through this library.
- Files are plaintext at mode `0600` unless `OMEGA_MEMORY_PASSPHRASE` is set, in
  which case both stores are sealed with AES-256-GCM.
- Promotion thresholds (3+ sessions, 2+ domains) are initial values, not
  empirically tuned.
- The correspondence layer is flat strings, not a queryable graph. Cross-domain
  structural identity testing is designed but not implemented.
- `queryPatterns` is literal substring matching over pattern names and domain
  tags. It does not embed, does not read claims, and does not match
  synonyms.

[Unreleased]: https://github.com/jwatson1283/Polymem/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jwatson1283/Polymem/releases/tag/v0.1.0
