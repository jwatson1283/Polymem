# Contributing to Polymem

Thanks for considering it. This document is short because the project has four
rules, and three of them exist to stop a specific failure this repo has already
hit once.

## The four rules

1. **`npm test` stays green.**
2. **A new suite registers an assertion floor**, or the run fails.
3. **Every fix ships with proof it fails without the fix.**
4. **The shipped package stays at zero dependencies.**

Everything below is those four, explained.

## Running things

```bash
npm test              # the suite — no install step, there are no dependencies
npm run docs:check    # do the docs still describe this code?
npm run verify        # syntax check + suite
```

**There is no `npm install` and that is not a bug.** The package has zero
runtime and zero dev dependencies, so there is no lockfile and nothing to
resolve. If a change makes you want to run `npm install`, you are about to break
rule 4.

Requires Node >= 18. CI runs 18 and 20.

## Rule 2: the assertion-floor rule

Every suite in `test/` has an entry in [`test/suite-floors.mjs`](test/suite-floors.mjs),
and the runner fails if one is missing. Adding a suite means adding a row:

```js
export const SUITE_FLOORS = {
  'test-your-thing.mjs':  12,   // the suite's real measured count
  // ...
};
export const TOTAL_ASSERTION_FLOOR = 428;
export const SUITE_COUNT_FLOOR = 14;
```

Three things to know, because they are the whole reason this mechanism exists:

**The number is the measured count, not a rounded floor.** A floor of 50 against
a suite of 57 lets someone delete 7 assertions and stay green — the same false
pass at a smaller scale. At the exact count, the only edit that keeps the suite
green is *adding* assertions.

**The friction is the feature.** If a suite legitimately needs fewer assertions,
that is a real change in coverage and it must appear as a deliberate edit to
`suite-floors.mjs` in your diff. You can weaken a floor. You cannot weaken one
invisibly.

**The file lives outside the suites on purpose.** The obvious fix — an
`if (pass < 50) fail++` at the bottom of each suite — does not work. Truncating a
suite to zero bytes deletes that check along with the assertions, and the guard
protects only against the case nobody performs by accident. Before the floor
table existed, truncating a suite to zero bytes and running `npm test` exited
**0** and printed "Passing." (the suite named in that original report was
`test-prototype-key-safety.mjs`, since renamed to `test-prototype-safety.mjs`.)
An empty file asserts nothing and exits 0. That is the worst class of test bug:
not a false failure, a false pass.

`TOTAL_ASSERTION_FLOOR` and `SUITE_COUNT_FLOOR` catch what per-suite floors
structurally cannot see: **deleting an entire suite** leaves every remaining
suite clearing its own floor, so the run goes green with a hole in it.

Machines, not suites, are listed in `NON_SUITE_FILES`. Anything else in `test/`
must be named `test-*.mjs`, so a suite cannot be silently skipped by being
called `foo.mjs`.

## Rule 3: failing-first proof

Any fix for a bug must come with evidence that the test detects the bug:

```bash
# 1. write the test, watch it fail
git stash push src/polymem.mjs   # remove the fix, keep the test
node test/test-thing.mjs         # MUST fail
git stash pop                     # restore the fix
node test/test-thing.mjs         # MUST pass
```

Paste both transcripts in the PR description. A test that has never been seen to
fail is not evidence.

If a test suite guards a defect, also verify it **catches the opposite
mistake**. A filter tuned until only noise passes is worse than no filter,
because it looks like it is working. `test/test-real-corpus.mjs` is verified in
both directions, and both were measured by mutating `src/polymem.mjs` and
restoring it:

| Mutation | Result |
|---|---|
| baseline | 46 pass, 0 fail |
| gate removed (every pattern accepted) | **7 fail** — the real noise re-promotes |
| gate rejects everything | **crashes** — all knowledge lost, so `sample` is `undefined` |

One direction is not enough. The second row is the one people forget: a gate
that always rejects passes every "noise must not survive" assertion while
destroying the entire index, and the crash is the honest signal that the
knowledge side went with it.

## Rule 4: zero dependencies

The shipped package must import nothing outside `node:` builtins.

```bash
npm pack --dry-run     # exactly 7 files, no test/, docs/, sim/, tools/
```

That number is checked by `npm run docs:check`, which fails if the packed file
list changes. `files` in `package.json` is an **allowlist**, not a blocklist,
which is the point: a new file is excluded by default and has to be added
deliberately, so a scratch directory or a stray memory file can never ride into a
published tarball. npm ignores `.gitignore` for the `files` field — it is npm's
own mechanism.

To use a library, do not add it as a dependency. Vendor the code, or reach for a
builtin, or reimplement the small piece you need.

## Rule 1, extended: documentation is not free

Numbers in prose drift, because the number lives in a file and the code lives
somewhere else. This repo shipped a README claiming 270 assertions while the
suite ran 312, and nobody noticed for fourteen commits.

So `npm run docs:check` verifies the docs against a live measurement: the
assertion count, every per-suite count quoted in `CHANGELOG.md` and
`SECURITY.md`, the CI floor sentence against `suite-floors.mjs`, the README's
captured usage block byte-for-byte, the exact packed file list, and that the
suite is currently green. It runs in CI.

If you change the library and a number in the docs should move, the guard will
tell you which one. Do not silence it — fix the doc.

When you add user-facing behaviour, add it to `CHANGELOG.md` under `[Unreleased]`
in Keep a Changelog format.

## Style

No linter is configured, deliberately — a zero-dependency project should not add
one. Match the surrounding code instead: two-space indent, `const` over `let`,
named exports, JSDoc on public functions.

**Comment the non-obvious reasoning, not the mechanics.** This codebase
documents *why* a decision was made and what was measured, including the
approaches that were tried and rejected — an earlier reader will otherwise
re-try the dead end. For example, `src/polymem.mjs` explains why the write claim
uses `O_CREAT|O_EXCL` (`flock` does not exist on Windows, so a `flock`-based lock
would quietly narrow supported platforms) and why a hash-compare-then-`rename`
fix was rejected (it does not work: `rename()` is unconditional, measured 2 of 8
survivors). Keep that habit.

Comments must stay true. If code changes, the comment above it is now wrong and
that is a bug — the suite-floor file and this document both record that stale
prose has already cost real time here.

## Pull requests

- One writer per file. If someone else is mid-edit on a file, wait or say so.
- Commit by explicit path. **Never `git add -A`** — this repo has had concurrent
  workers, and a blanket add will sweep up someone else's in-progress work.
- Say what you measured. A number you ran beats a number you remember.
- Do not delete an honesty section to make a PR look tidier. The parts that say
  what the library cannot do are the most credible parts; if you remove one, say
  why it stopped being true.

## Reporting bugs

Security issues: **email security@example.com**, not a public issue — see
[SECURITY.md](SECURITY.md). Everything else: a GitHub issue is fine.

A good bug report includes what you expected, what happened, the version or
commit, and a reproduction. If you have already fixed it, a failing test in the
report is worth more than a description.

## License

By contributing you agree your work is licensed under the [MIT License](LICENSE),
the same as the project.