# Security Policy

## Reporting a vulnerability

**Email security@example.com.** Please do not open a public GitHub issue for a
security problem — an issue is world-readable from the moment it is filed, and
so is the fix once a patch is pushed.

Useful to include: what an attacker can reach, what they can do with it, the
exact version or commit, and how to reproduce it. A proof beats a description.

There is **no bug bounty and no paid support.** This is a small library
maintained by one person. What you get is a genuine fix and a credit in the
commit message if you want one.

## Supported versions

Polymem is **pre-1.0**. Only the current `main` is supported. There is no
backport policy: a fix lands on `main` and you upgrade.

## The honest security posture

This section is the point of this file. A security policy that lists only
victories is marketing; here is what is actually true, split into what has been
fixed and what is still open.

### Fixed — each one reproduced before and after, each with a regression test

These were found by deliberately breaking the library on purpose. Every one has
a test that fails against the old code.

1. **Silent data loss under concurrency.** Every writer published a complete
   snapshot of the index; the last `rename()` won and the other writers'
   patterns were destroyed. Measured pre-fix: 8 concurrent processes each adding
   one pattern, released together off a real barrier — **between 1 and 7 of 8
   survived** (most often 3 of 8; the count is a race outcome and varies with
   scheduling), the file was valid JSON, and **all 8 reported `saved: true`**.
   Measured over 120 runs, so the figure is a range and not a point estimate. Now every save is a
   read-modify-write cycle under an exclusive write claim, and all 8 are
   present afterwards. The textbook `hash-compare-then-rename` fix was
   implemented faithfully and *also* failed (2 of 8, then 3, then 1) because
   `rename()` is unconditional — that negative result is why the design is what
   it is.

2. **Path traversal through the session date, on read *and* write.** The date
   was interpolated raw into a filename. Three path segments escaped the
   sessions directory on the read path, so `loadWorkingMemory` would return the
   contents of any JSON file the process could already reach — which needs no
   write permission and is the cheaper abuse. Now refused and contained on both
   paths; 8 traversal shapes and 9 malformed dates are asserted.

3. **Prototype-chain lookups on model-supplied keys.** A memory section header
   reading `### constructor` made `parseMemoryBlock` throw — breaking its own
   documented never-throw contract on the per-response path, with no attacker
   required: a model only has to emit the word. `demotePattern` and
   `restorePattern` went further and wrote `demotedFrom`/`status`/`demotedAt`
   onto `Object.prototype`, which is process-wide and visible to code that never
   touches memory. Now every key derived from model output goes through
   own-property checks.

4. **The npm tarball published everything.** With no `files` field the pack
   included whatever sat at the repo root — internal design docs under `docs/`
   and the test suite shipped alongside the library. Measured at `322eb1f~1`
   that was 12 files (an earlier draft of this doc said 35, which was wrong);
   anything else at the repo root, a scratch directory included, would have
   shipped with it. Now an explicit allowlist — measured at exactly 7 files.

5. **The pack was readable by every account on the host.** The index holds
   verbatim agent output — absolute paths, provider names, task ids — written at
   mode `0644`. Now `0600`.

### Open — read these before you point Polymem at anything you care about

1. **Nothing is encrypted by default.** With no `OMEGA_MEMORY_PASSPHRASE` set,
   the index and the session files are **plaintext on disk** at mode `0600`.
   `0600` is a file-permission boundary, not encryption: anything running as
   your user can read them, and so can a backup, a sync client, a container
   layer, or a file committed to a repo. Optional AES-256-GCM sealing is
   available and documented; it is off unless you turn it on.

2. **Encryption at rest is not a defence against code running as you.** The
   passphrase lives in an environment variable, readable by every process you
   can read and by anything able to read your shell history or
   `/proc/<pid>/environ`. It protects the bytes *at rest* — a stolen disk, a
   synced folder, a backup, another account on the host. It does nothing about
   a compromised process already running as your user.

3. **There is no passphrase recovery.** No escrow, no fallback to plaintext, no
   way to distinguish a lost passphrase from a tampered file. A wrong
   passphrase, a missing one, and a flipped byte in the ciphertext all produce
   the same loud failure. **Back the passphrase up somewhere other than the
   machine it protects**, or the data is unrecoverable by design.

4. **Turning encryption on does not rewrite history.** Stores written before
   the variable was set keep loading unchanged and are not migrated; each file
   is sealed the next time it is written. So a store with history is briefly
   mixed — old files plaintext, new ones sealed. Rewrite the files once while
   the variable is set if you need it uniform immediately. A sealed file read
   *without* the variable set fails loudly rather than returning an empty
   index, so you cannot silently lose data by forgetting to export it.

5. **The write claim is advisory against non-cooperating writers.** It
   coordinates writers that go through this library. It cannot coordinate a
   human with an editor open on the file, a backup restore, or a second tool.
   The save re-checks the file hash immediately before committing and retries
   on top of any change it did not make, but that is best-effort against a
   writer that ignores the file entirely.

6. **Counter fields merge by `max`, not by sum.** Two processes promoting on
   the same day can undercount `meta.promotions` by one. Per-pattern evidence
   is unioned exactly — nothing recorded is dropped. Counters here are
   observability, not data, and `max()` can never over-report.

7. **Content is whatever your agent emits.** Polymem stores claims and patterns
   verbatim, and its filter is lexical, not a privacy control. Measured over 85
   real quarantined names it rejects 74; **11 still pass**. Do not rely on it to
   stop sensitive material being stored — decide what goes into the input.

8. **No multi-user isolation.** One index file, one sessions directory, no
   scoping key and no `user_id`. Two users sharing an account share an index.
   If you need per-user isolation, give each user their own
   `OMEGA_MEMORY_INDEX` and `OMEGA_MEMORY_SESSIONS_DIR`.

9. **No audit trail, no key rotation, no attestation.** Optional encryption is
   "the file is not readable text anymore". It is not a compliance control and
   should not be described as one.

### Non-goals

- **Audited or certified.** No third-party security review, penetration test,
  or compliance attestation. Nobody has checked this code except the people who
  wrote it and the audits described above.
- **Safe on a hostile multi-tenant host.** There is no tenant boundary.
- **Safe on a network filesystem.** The write claim and the atomic `rename()`
  rely on POSIX atomicity. NFS and SMB do not give the same guarantees with the
  same timing, so on a network mount the merge degrades toward
  last-writer-wins.
- **A secrets store.** It is an agent memory system. If you have secrets in
  there, they are on disk in plaintext by default.

## Threat model in one paragraph

Assume the host, the Node process, and anything running as your user are
trustworthy, and that **agent output is not**. Model-emitted text reaches
`parseMemoryBlock` and becomes structured data, so the parser is the primary
attack surface — that is why prototype safety and the never-throw contract are
regression-tested rather than documented and forgotten. Assume a second writer
may appear concurrently, and that the operator may open the file in an editor.
Assume the network is fine; Polymem makes no network calls at all.

## Verifying these claims for yourself

Every number on this page is checked by `npm run docs:check`, which runs the
suite and re-measures rather than trusting a comment. The security-relevant
behaviours have named suites:

```
test/test-session-date-containment.mjs   14 assertions   traversal, read + write
test/test-prototype-safety.mjs           19 assertions   prototype-chain keys
test/test-concurrency-rmw.mjs            23 assertions   concurrent saves
test/test-encryption-at-rest.mjs         66 assertions   sealing, tampering, modes
```

Full before/after measurements and the reproduction commands:
[`docs/2026-09-25-promotion-defect.md`](docs/2026-09-25-promotion-defect.md).