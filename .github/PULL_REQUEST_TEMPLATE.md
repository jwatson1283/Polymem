## What this changes

<!-- One or two sentences. -->

## Verification

<!--
  Required. Not "tested locally" — paste the commands and what they printed.

  If this fixes a bug, `npm run docs:check` will tell you if a number in the
  README, CHANGELOG, or SECURITY.md went stale, and it runs the suite itself.
  Run it before you push. If it fails, fix the documentation rather than
  silencing the check: a number that drifted is the exact defect this project
  already shipped once.
-->

- [ ] `npm test` — passes
- [ ] `npm run docs:check` — passes (or not applicable)
- [ ] Failing-first proof attached, if this is a bug fix (see CONTRIBUTING.md)

## Checklist

- [ ] New suite registered in `test/suite-floors.mjs`, with the measured count
- [ ] `TOTAL_ASSERTION_FLOOR` / `SUITE_COUNT_FLOOR` updated if totals moved
- [ ] No new runtime dependency (`src/` imports only `node:` builtins)
- [ ] `npm pack --dry-run` still lists exactly the intended files
- [ ] `CHANGELOG.md` updated under `[Unreleased]`, if this is user-facing
- [ ] Comments still describe the code as it now is
- [ ] Staged files committed **by explicit path** — not `git add -A`
- [ ] Nothing about the "what is NOT done yet" section removed to tidy the diff

## Notes for the reviewer

<!--
  Worth measuring if the change touches concurrency, the promotion gate, or
  anything touching disk: the number before, the number after, and the command
  that produced both. "Verified" without a number is the habit this project
  wrote its docs guard to break.
-->