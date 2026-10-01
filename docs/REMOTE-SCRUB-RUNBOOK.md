# Remote scrub runbook — jwatson1283/Polymem

Prepared 2026-10-01 by hermes-ii for card `t_7dbe5dd8`. **Nothing in Section 2 has been run.**
Every number here was measured, not recalled; each command is annotated with how to check it
came out right.

## 1. State, measured 2026-10-01 (authenticated as jwatson1283)

| Fact | Value | How measured |
|---|---|---|
| Repo exists | yes, **private** | `gh api repos/jwatson1283/Polymem` → `private:true`, `visibility:private` |
| Created | 2026-10-01T15:16:40Z | `gh api ... --jq .created_at` |
| Remote HEAD | `a1f9915` (31 commits) | `git ls-remote origin` |
| Commit author | `<work-email>@redwar.com`, **31 of 31**, name `RedWar Studio` | `git log --all --format='%ae' \| sort -u` on a fresh clone |
| Committer | same email, 31/31 | `--format='%ce'` |
| Root commit | `3e31b44` — **unrelated** to the local clean repo's root | `git merge-base` → `fatal: Not a valid commit name` |
| PII in blobs | `/Users/<home>`, `<gmail>@gmail.com`, `<work-email2>@redwarstudio.com` in **18 of 31** historical trees, paths `src/polymem.mjs`, `test/test-encryption-at-rest.mjs`, `.github/ISSUE_TEMPLATE/bug_report.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md` | per-commit `git grep` over `git rev-list --all` |
| PII at remote HEAD | **zero** — scrubbed by commit `9956f63` "Scrub operator email from shipped docs" | `git grep -l <pii> HEAD` → empty |
| Forks / watchers / stars | **0 / 0 / 0** | `gh api ... --jq '{forks:.forks_count,...}'` |
| Collaborators | 1 — Josh himself, admin | `gh api .../collaborators` |
| Hooks / environments / secrets / pages | 0 / 0 / 0 / none | `gh api` on each |
| CI runs | 4 (3 green, head `a1f9915` red) | `gh api .../actions/runs` |
| Tags / releases | 0 / 0 | `gh api .../tags`, `.../releases` |
| Josh's GitHub plan | **free** (`gh api user --jq .plan.name` → `"free"`) | rulesets + branch protection both 403 with "Upgrade to GitHub Pro" |

### Why force-push is not enough
Force-pushing `main` makes `a1f9915` unreachable *from the branch*, but the commits stay
fetchable **by SHA** and the real email stays inside those objects. GitHub also keeps serving
cached views. This is the ordinary way a "we force-pushed" scrub fails.

### Option 3 is not available
GitHub's own docs: *"You can only contact GitHub Support to restore a repository if you are on
a paid GitHub plan."* Josh is on **free**, so the Support escalation cannot be filed. Option 1
is the only mechanism available that actually removes the objects.

## 2. The decision — Josh's call, awaiting go-ahead

**Recommended: delete and recreate the repo from the clean local repo, then push.**

Why this one:
- The histories are unrelated, so a delete loses no *lineage* that matters.
- Verified the clean repo is a strict **superset in content**: every file at remote HEAD exists
  locally, and the 5 files that differ (`.gitignore`, `README.md`,
  `docs/2026-09-25-promotion-defect.md`, `tools/check-doc-claims.mjs`, `package.json`) all
  differ by the clean repo being **newer** — verified by reading the diffs, not by line count.
- Private, 0 forks, 0 watchers, 0 collaborators but Josh, 0 hooks, 0 secrets: no consumer
  loses anything.
- Delete is the only available path that actually removes the identifiers.

### Reversibility — already secured, this is why the delete is safe to approve
The 31 commits exist nowhere else (`a1f9915` is **not** in `~/Projects/Polymem`, which is a
different 34-commit history). Before asking for approval I took a backup:

```
~/backups/polymem-REMOTE-preDelete-20261001.bundle   (clone-tested)
  git bundle verify  -> okay, "records a complete history", 4 refs
  git clone <bundle> -> 31 commits, HEAD a1f9915 readable WITHOUT the remote
```

So if the delete is regretted, the history is recoverable from that bundle. Restore this way:
`gh repo create jwatson1283/Polymem --private` then
`git push <bundle> refs/heads/main:refs/heads/main`.

### Commands, in order — do not run past a step that fails

```bash
# 0. Re-confirm nothing changed since this runbook was written (cheap, read-only)
gh api repos/jwatson1283/Polymem --jq '{private,fork,forks_count,watchers_count,archived}'

# 1. DELETE. Irreversible in the UI; recoverable only from the bundle above.
gh repo delete jwatson1283/Polymem --yes

# 2. RECREATE, private. Free plan: up to 10000 private repos, so no quota issue.
gh repo create jwatson1283/Polymem --private --description \
  "Two-tier memory for AI agents: session working memory plus an evidence-gated patterns index."

# 3. Push the clean history from the clean repo (2 commits, unrelated roots, so this is a
#    first push and needs no --force).
cd /Users/<home>/Projects/Polymem-clean
git push -u origin main

# 4. VERIFY the push landed and the old objects are gone.
gh api repos/jwatson1283/Polymem --jq '{private,default_branch,pushed_at}'
git ls-remote origin                       # expect a NEW sha, not a1f9915
gh api repos/jwatson1283/Polymem/actions/runs --jq '.total_count'   # expect 1 fresh CI run
```

### 4b. Verification that actually proves the scrub (this is the whole point)
A local check proves nothing — the claim is about remote reachability by SHA. Run this:

```bash
# Unauthenticated: must 404 (private repo seen from outside)
curl -s -o /dev/null -w '%{http_code}\n' https://api.github.com/repos/jwatson1283/Polymem

# The old commit must NOT be fetchable. Authenticated, before a forced GC it may still
# resolve on GitHub even though the branch no longer points at it -- that is EXPECTED and
# is exactly why delete beats force-push. Record the result either way.
git ls-remote origin | grep -i a1f9915 && echo "STILL PRESENT - escalate" || echo "gone from refs"

# Fresh authenticated clone: 0 of the 31 old commits, one author only.
rm -rf /tmp/pm-postverify
git clone https://github.com/jwatson1283/Polymem.git /tmp/pm-postverify
cd /tmp/pm-postverify
git rev-list --count --all                                  # expect 2
git log --all --format='%ae' | sort -u                      # expect ONLY the noreply address (no real/work email)
git cat-file -e a1f9915 2>/dev/null && echo "OLD COMMIT STILL FETCHABLE" || echo "old commit gone"
npm test                                                     # suite green in the clone
```

If `OLD COMMIT STILL FETCHABLE` appears, the delete did not take effect as expected — stop
and report rather than proceeding.

## 3. Also required, and already done

`package.json`'s `//repository` note shipped three false claims (repo does not exist / returns
404 / "nothing was pushed and no remote was added"). **Fixed and committed** as `e8a0b08`; docs
guard re-run after the edit — 44/44 claims, 508 assertions / 15 suites, 0 failing.

## 4. Open item NOT covered here — a third repo

`~/Projects/Polymem` is a **separate 34-commit history** with **no remote**, and it still holds:
- `<work-email>@redwar.com` on **34 of 34** commits
- `/Users/<home>` at **HEAD**, `sim/run.mjs:906`

The clean repo fixed line 906 to `/Users/exampleuser`; this copy never received the fix. It is
local-only so there is no leak today, but **pushing that repo would leak the same identifiers
plus a new one**. Flagged, not touched — it belongs to another lane.