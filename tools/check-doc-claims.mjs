#!/usr/bin/env node
// tools/check-doc-claims.mjs — the doc-drift guard.
//
// THE DEFECT THIS EXISTS TO KILL. `README.md` stated "270 assertions across 10
// suites" while `npm test` reported 312/11. A wrong number in a README is not
// a cosmetic problem: it is the only number a stranger has, and it is the one
// thing in the repo nobody re-measures after shipping a suite.
//
// WHY A SCRIPT AND NOT A DISCIPLINE. Discipline worked for 14 commits. Every
// time a suite was added, the number went stale, because the number lives in a
// prose file and the suite count lives in code, and nothing connects them.
//
// THE PRIOR ATTEMPT AT THIS GUARD COULD ONLY REPORT A PARSE ERROR, which is
// worse than no guard in one specific way: a guard that cannot tell "the doc
// is wrong" from "I could not read the doc" will be believed to be passing
// either way. So the rule here is INVERTED:
//
//     AN UNREADABLE CLAIM IS A FAILURE, NOT A SKIP.
//
// Every check below has a positive obligation: it must find the marker it is
// looking for. A README that deletes the assertion-count sentence FAILS this
// script, loudly, rather than quietly passing a check that found nothing.
//
// WHAT IS ACTUALLY COMPARED. Nothing is hardcoded. Counts come from running
// the suite and running `npm pack --dry-run`; prose comes from the files. A
// number is only ever compared against a number somebody measured in this
// process, so this script cannot itself become the stale artifact.
//
// Usage:  node tools/check-doc-claims.mjs        (exit 0 = docs match reality)
//         npm run docs:check

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const p = (rel) => join(REPO, rel);

const GRN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', YEL = '\x1b[33m', OFF = '\x1b[0m';
const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail }); }

// ── 1. Measure reality ─────────────────────────────────────────────────────
//
// Two subprocesses. Both are the real command a person would type — this
// script does not reimplement the runner or reimplement npm's packer, because
// a guard that reimplements the thing it guards is measuring its own idea of
// it rather than the thing.

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const suiteRun = spawnSync(process.execPath, ['test/run-tests.mjs'], {
  cwd: REPO, encoding: 'utf8',
});
const suiteOut = stripAnsi(`${suiteRun.stdout || ''}${suiteRun.stderr || ''}`);

// The totals line the runner prints. Parsed from stdout, and if it is absent
// the whole script fails — a guard that cannot read the measurement cannot
// judge the claim.
const totalsLine = suiteOut.match(/(\d+)\s+suites,\s+(\d+)\s+assertions,\s+(\d+)\s+failing/);
if (!totalsLine) {
  console.error(`${RED}check-doc-claims could not read the suite totals at all.${OFF}`);
  console.error('Run `npm test` and look. This script refuses to pass a claim');
  console.error('it could not measure — that is the exact failure mode it exists to');
  console.error('prevent in the docs.');
  process.exit(1);
}
const MEASURED_SUITES = Number(totalsLine[1]);
const MEASURED_ASSERTIONS = Number(totalsLine[2]);
const MEASURED_FAILING = Number(totalsLine[3]);

const packRun = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: REPO, encoding: 'utf8',
});
let PACKED = [];
try {
  PACKED = JSON.parse(packRun.stdout)[0].files.map((f) => f.path).sort();
} catch {
  console.error(`${RED}check-doc-claims could not read \`npm pack --dry-run --json\`.${OFF}`);
  console.error('Without the packed file list this script cannot verify that the');
  console.error("package's own 'files' allowlist still contains only public files.");
  process.exit(1);
}

// ── 2. The claim helpers ───────────────────────────────────────────────────
//
// Every one of these THROWS on an unreadable file. That is deliberate and is
// the whole design: a missing or renamed doc is a failure here, not a pass.

function read(rel) {
  const abs = p(rel);
  if (!existsSync(abs)) {
    throw new Error(`${rel} is missing — this script cannot verify a claim in a file it cannot read, and treating that as a pass is the bug it was written to prevent.`);
  }
  return readFileSync(abs, 'utf8');
}

// A regex that MUST match. `null` return is a failure, never a skip.
function mustMatch(rel, re, what, haystack) {
  const m = (haystack !== undefined ? haystack : read(rel)).match(re);
  if (!m) {
    throw new Error(`${rel} does not contain ${what} (expected ${re}). The claim this script checks is no longer in the document; a guard that reports "nothing to check" as "clean" is the false pass this repo already shipped once.`);
  }
  return m;
}

// ── 3. Claim: the README's assertion count is the measured one ─────────────

// Anchored to the Status section on purpose. This README also NARRATES the old
// stale numbers ("claimed 270 assertions across 10 suites while npm test
// reported 312/11"), so a repo-wide match would pick up the deliberately-wrong
// figure in the story and fail on it. The claim under test is the one a reader
// would act on.
const statusSection = read('README.md').split(/^## Status$/m)[1];
if (!statusSection) {
  throw new Error('README.md has no "## Status" section. The measured assertion/suite count lives there, and a guard that cannot find it must fail rather than pass.');
}
const readmeCounts = mustMatch(
  'README.md',
  /(\d+)\s+assertions across\s+(\d+)\s+suites/,
  'an "N assertions across M suites" sentence in the Status section',
  statusSection,
);
check(
  'README.md Status states the measured assertion/suite count',
  Number(readmeCounts[1]) === MEASURED_ASSERTIONS && Number(readmeCounts[2]) === MEASURED_SUITES,
  `README says ${readmeCounts[1]}/${readmeCounts[2]}, \`npm test\` measured ${MEASURED_ASSERTIONS}/${MEASURED_SUITES}`,
);

// ── 4a. No OTHER doc may state the suite size as a live fact ────────────────
//
// Sentry's MEDIUM finding: the guard read five files, and all four carriers of
// the false "5 of 8" and "35 files" figures lived in files it did not read. A
// guard that covers three of seven carriers of a number is not a guard for that
// number. Extending the read set (above) fixes the instances; this closes the
// CLASS, because the failure mode is a doc nobody put under the guard.
//
// A live claim is one phrased in the present tense -- "runs N assertions",
// "now runs N", "has N assertions" -- and it must equal the measured value.
// A historical claim ("was 270 while the suite ran 312", "at 7e7da33 the suite
// ran 346") is explicitly allowed, because those describe a past tree and are
// exactly what a CHANGELOG and a defect post are FOR.
//
// This is deliberately narrow. It catches a stale present-tense count; it does
// not try to judge whether a historical figure was ever accurate, which would
// require checking out old commits to be true and would be unmaintainable.

const LIVE_SUITE_SIZE_CLAIM =
  /(?:\bnow\s+runs|\bruns\b|\bhas\b|\bcurrently\s+runs)\s+(?:\*\*)?(\d+)\s+assertions(?:\s+across\s+(\d+)\s+suites)?/gi;

const SUITE_SIZE_TRACKED = new Set([
  'README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md',
  '.github/workflows/ci.yml', 'test/suite-floors.mjs',
  'docs/release/launch-post.md', 'docs/release/release-notes-v0.1.0.md',
]);
const SUITE_SIZE_SCANNED = [
  ...SUITE_SIZE_TRACKED,
  'docs/2026-09-25-promotion-defect.md',
];

const staleSuiteSize = [];
for (const rel of SUITE_SIZE_SCANNED) {
  if (!existsSync(join(REPO, rel))) continue;
  const text = readFileSync(join(REPO, rel), 'utf8');
  for (const m of text.matchAll(LIVE_SUITE_SIZE_CLAIM)) {
    const claimed = Number(m[1]);
    if (claimed !== MEASURED_ASSERTIONS) {
      const lineNo = text.slice(0, m.index).split('\n').length;
      staleSuiteSize.push(`${rel}:${lineNo} "${m[0].trim()}"`);
    }
  }
}
check(
  'no doc states the suite size as a live fact unless it matches npm test',
  staleSuiteSize.length === 0,
  staleSuiteSize.length
    ? `stale present-tense suite size: ${staleSuiteSize.join('; ')}`
    : `scanned ${SUITE_SIZE_SCANNED.length} doc(s); every live size claim equals ${MEASURED_ASSERTIONS}`,
);

// ── 4. Claim: CHANGELOG's per-suite counts are the measured ones ───────────
//
// The changelog quotes a count for specific suites. Each quoted number must
// equal that suite's real reported count. A changelog entry describing what a
// commit did is allowed to be historical; a changelog entry claiming a suite
// "has 66 assertions" when it has 71 is just wrong.

const suiteCounts = new Map();
for (const line of suiteOut.split('\n')) {
  const m = line.match(/✓\s+(\S+\.mjs)\s+(\d+)\/\s*\d+\s+assertions/);
  if (m) suiteCounts.set(m[1], Number(m[2]));
}

const changelog = read('CHANGELOG.md');
const changelogClaims = [...changelog.matchAll(/`(test-[\w.-]+\.mjs)` — (\d+) assertions/g)];
check(
  'CHANGELOG.md quotes real per-suite counts for every suite it names',
  changelogClaims.length > 0,
  changelogClaims.length === 0
    ? 'no "<suite> — N assertions" claims found to verify; the pattern may have been edited out of the changelog'
    : `${changelogClaims.length} claim(s) verified against the run`,
);
for (const [, suite, n] of changelogClaims) {
  const real = suiteCounts.get(suite);
  check(
    `CHANGELOG.md: ${suite} = ${n} assertions`,
    real !== undefined && real === Number(n),
    real === undefined
      ? `${suite} did not appear in the \`npm test\` output at all, so its count cannot be verified`
      : `${suite} actually reports ${real} assertions`,
  );
}

// ── 4b. Claim: the security suite counts SECURITY.md quotes are real ───────
//
// SECURITY.md tells a reader which suites cover which security property. A
// suite that is renamed, removed, or renumbered would leave that table quietly
// pointing at nothing — and a security table that points at nothing is worse
// than no table, because it reads as coverage.
//
// The first version of this check matched nothing and reported success, because
// the table's lines sit inside an indented code fence and the regex was
// anchored to column 0. That is the exact false pass this script exists to
// kill, committed by the person writing it. Hence the explicit
// `claims.length > 0` obligation below: zero matches is a failure, never a
// silent no-op.

// NB the `test/` path prefix: the table writes these as `test/<suite>.mjs`,
// while the runner prints bare `<suite>.mjs`. Comparing the whole path against
// the bare name would fail for every row.
const secClaims = [...read('SECURITY.md').matchAll(/^[ \t]*(?:test\/)?(test-[\w.-]+\.mjs)[ \t]+(\d+) assertions/gm)];
check(
  'SECURITY.md quotes per-suite assertion counts that were actually found',
  secClaims.length > 0,
  secClaims.length === 0
    ? 'no "<suite> N assertions" rows found in SECURITY.md — the security coverage table would be unverifiable'
    : `${secClaims.length} row(s) verified against the run`,
);
for (const [, suite, n] of secClaims) {
  const real = suiteCounts.get(suite);
  check(
    `SECURITY.md: ${suite} = ${n} assertions`,
    real !== undefined && real === Number(n),
    real === undefined
      ? `${suite} did not appear in the \`npm test\` output, so the security table points at a suite that does not run`
      : `${suite} actually reports ${real} assertions`,
  );
}

// ── 4c. Claim: every TOC anchor in the README resolves to a real heading ───
//
// The table of contents is 19 hand-written anchor links, so it is 19 chances to
// be wrong. A renamed section leaves a link that 404s within the same page,
// which is the quietest kind of doc rot: the README still looks complete and
// one entry does nothing.
//
// GitHub's anchor algorithm: lowercase, strip punctuation except hyphens and
// spaces, spaces -> hyphens. `## The simulation harness (`sim/`)` becomes
// `#the-simulation-harness-sim`, which is exactly why that entry is spelled
// that way in the TOC. Reproduced here rather than approximated, because an
// approximate slugger would disagree with GitHub on precisely the headings that
// contain punctuation — the ones most likely to break.

const slug = (heading) => heading
  .trim()
  .toLowerCase()
  .replace(/[^\w\s-]/g, '')
  .replace(/\s+/g, '-');

const readmeBody = read('README.md');
const realAnchors = new Set(
  [...readmeBody.matchAll(/^#{2,3}\s+(.+)$/gm)].map(([, h]) => slug(h)),
);
const tocLinks = [...readmeBody.matchAll(/^- \[[^\]]+\]\(#([^)]+)\)/gm)].map(([, a]) => a);
check(
  'README.md table of contents was found',
  tocLinks.length > 0,
  tocLinks.length === 0 ? 'no "- [Section](#anchor)" links found, so there is no TOC to verify' : `${tocLinks.length} link(s) checked`,
);
for (const anchorText of tocLinks) {
  check(
    `README.md TOC anchor #${anchorText}`,
    realAnchors.has(anchorText),
    `no heading in README.md slugifies to "${anchorText}" — the link 404s within the page`,
  );
}

// ── 4d. Claim: every release draft still says DRAFT ────────────────────────
//
// docs/release/ holds the v0.1.0 release notes and the HN/Reddit launch post.
// Neither has been published — that is deliberate, and Josh's rule is an
// explicit per-instance go-ahead, not a standing order. The only thing keeping
// that true is a banner at the top of each file, and a banner is invisible to
// every other check in this script: the drafts quote real numbers, so they pass
// the numeric guards, which makes "looks verified" and "safe to publish" look
// like the same thing.
//
// So: the banner is a claim, and it gets checked. Strip DRAFT/NOT PUBLISHED
// from a draft and this fails — which is the moment a human should notice, not
// the moment it gets pushed.
//
// The counts inside the drafts are deliberately NOT checked. They are written
// against the run at authoring time and are expected to go stale; the drafts
// carry an explicit "re-measure before publishing" instruction for that. A
// guard that failed every time a suite landed would train people to delete the
// banner to make the build green.

//
// WHY THE MATCH IS ANCHORED, NOT `/DRAFT/i`. First version of this check was
// "does the word DRAFT appear anywhere" — and it PASSED with the banner
// deleted, because the word also appears in the body prose ("a draft held in
// the repository", "Status: draft"). A guard that survives the exact mutation
// it exists to catch is worse than no guard, because it converts a real
// regression into a green tick. Verified by mutation, not by reading: stripping
// the banner line fails this; leaving the file untouched passes.
//
// So the obligation is on the BANNER BLOCK specifically — the `<!-- ... -->`
// header at the top of the file, before any prose.

for (const draft of ['docs/release/release-notes-v0.1.0.md', 'docs/release/launch-post.md']) {
  const body = read(draft);
  const banner = body.match(/^<!--([\s\S]*?)-->/);
  if (!banner) {
    throw new Error(`${draft} has no HTML-comment banner block. That block is the only thing marking this file as unpublished, so its absence must fail loudly rather than pass a check that found nothing.`);
  }
  const head = banner[1];
  const okBanner = /DRAFT/i.test(head) && /NOT (PUBLISHED|POSTED)/i.test(head);
  check(
    `${draft} carries an intact "DRAFT — NOT PUBLISHED" banner`,
    okBanner,
    okBanner
      ? 'banner intact in the header block — nothing here has been published'
      : 'the banner block at the top does not say DRAFT and NOT PUBLISHED/POSTED. This file has never been published; restoring the banner is what keeps it that way.',
  );
}

// ── 4e. Claim: a race outcome is never stated as a bare point estimate ─────
//
// THE DEFECT THIS EXISTS TO KILL. Eight files stated "5 of 8 survived" for the
// concurrent-write data loss. It was not 5 of 8 and never had been — the number
// is a RACE outcome, so it moves with scheduling. Measured over 120 runs it
// ranged from 1 to 7, most often 3. One run had produced "5 of 8", and eight
// files had laundered that single sample into a flat measurement. The CHANGELOG
// was the only file that had it right, as a range.
//
// THE RULE, stated so a machine can apply it. A "N of M" figure that describes
// concurrent writers must carry a qualifier admitting the number varies. Bare
// point estimates of DETERMINISTIC measurements are fine and are NOT this
// check's business — "20 of 26 real pattern lines carry only ONE domain" is a
// property of a fixed fixture, and demanding a range of it would be nonsense.
//
// HONEST SCOPE. This is a lint over prose, not a re-measurement. It cannot tell
// whether a stated range is the true range — only whether the text admits the
// number is variable. The ranges themselves were measured by hand (120 runs for
// the index race, 30 for the fixed-tmp-name race) and the probes live in
// scratch/race-evidence/. What this catches is the failure that actually
// happened: a race quietly re-stated as a constant.
//
// Like every check here, finding nothing is a FAILURE. If the figure is deleted
// from every doc, this reports a red tick rather than a green one for a rule
// that silently stopped running.

const RACE_FIGURE = /(\d+)\s+of\s+(\d+)(?=[\s\S]{0,60}?\b(?:patterns?|writers?|survived|survive|present|landed|lost|represented|persisted)\b)/g;
// Wording that admits the count is variable.
const QUALIFIER = /between\s+\d+\s+and\s+\d+|\d+\s*[\u2013\-]\s*\d+\s+of|most often|varies?|varying|range|race|scheduling|up to|at least|at most|every run|\d+\s+runs|\bruns\b/i;
// Wording that marks the measurement as CONCURRENT. Without one of these the
// figure is a deterministic property and this rule does not apply.
const CONCURRENT = /writers?|processes|concurrent|barrier|parallel|race|scheduling|saved:true|clobber|race\b/i;

// "8 of 8" is the post-fix claim: deterministic, and verified as a real
// assertion in test-concurrency-rmw.mjs rather than asserted here.
const DETERMINISTIC = new Set(['8']);

const RACE_DOCS = [
  'README.md', 'SECURITY.md', 'CHANGELOG.md',
  'docs/release/release-notes-v0.1.0.md', 'docs/release/launch-post.md',
  'src/polymem.mjs', 'test/test-concurrency-rmw.mjs',
];

let figuresSeen = 0;
const bareFigures = [];
const seen = new Set();
for (const rel of RACE_DOCS) {
  const lines = read(rel).split('\n');
  lines.forEach((line, idx) => {
    // The context window is the line plus the three above it, and the figure is
    // matched against the WINDOW, not the line. That is not a stylistic choice:
    // the claim wraps mid-figure, so "**5 of 8" ends one line and "survived**"
    // begins the next. Matching per line found nothing there and the original
    // defect slipped past a check that looked like it was covering exactly that
    // sentence. Prose wraps; the check has to read across the wrap.
    const from = Math.max(0, idx - 3);
    const window = lines.slice(from, idx + 1).join('\n');
    // Only consider a match whose figure lies on THIS line, so a figure is
    // checked once rather than once per line of context above it.
    const lineStart = lines.slice(from, idx).join('\n').length + (from < idx ? 1 : 0);
    for (const m of window.matchAll(RACE_FIGURE)) {
      if (m.index < lineStart) continue;
      const [, n, d] = m;
      if (DETERMINISTIC.has(n) && n === d) continue;
      if (!CONCURRENT.test(window)) continue;   // deterministic measurement
      const key = `${rel}:${idx + 1}:${m[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      figuresSeen++;
      if (!QUALIFIER.test(window)) bareFigures.push(`${rel}:${idx + 1}: "${m[0]}"`);
    }
  });
}
check(
  'race outcomes are stated as a measured range, never a bare point estimate',
  bareFigures.length === 0,
  bareFigures.length === 0
    ? `${figuresSeen} concurrent figure(s) checked, all carrying a qualifier (a range, "most often", or an explicit note that it varies)`
    : `${bareFigures.length} bare point estimate(s) — a race result stated as a constant:\n        ${bareFigures.join('\n        ')}`,
);
check(
  'the concurrency race figure is still present to verify (guard is not vacuous)',
  figuresSeen > 0,
  figuresSeen === 0
    ? 'no concurrent "N of M" figure found in any checked file — this rule has stopped verifying anything'
    : `${figuresSeen} figure(s) found across ${RACE_DOCS.length} files`,
);

// ── 4f. Claim: the packed-file count the docs quote is the measured one ─────
//
// The docs say the allowlist reduced the tarball to "exactly 7 files". That is
// checkable in this process — `npm pack --dry-run` already ran above — so it is
// checked rather than trusted. The PRE-fix count (12) is not checkable here: it
// needs a checkout of an old commit, and a guard that shell out to git to
// re-derive history is a guard that breaks when history is rewritten. The docs
// say so explicitly instead of asserting a figure nothing verifies.

const packClaims = [];
for (const rel of ['README.md', 'SECURITY.md', 'docs/release/launch-post.md',
                   'docs/release/release-notes-v0.1.0.md']) {
  const text = read(rel);
  for (const m of text.matchAll(/exactly (\d+) files|Now (\d+)\./g)) {
    const n = Number(m[1] ?? m[2]);
    if (Number.isInteger(n)) packClaims.push({ rel, n });
  }
}
check(
  'the docs quote a tarball file count that was actually measured',
  packClaims.length > 0 && packClaims.every((c) => c.n === PACKED.length),
  packClaims.length === 0
    ? 'no tarball file count found in the docs to verify'
    : `docs quote ${[...new Set(packClaims.map((c) => c.n))].join('/')}, \`npm pack --dry-run\` measured ${PACKED.length}`,
);

// ── 5. Claim: CI's floor sentence matches the floor table ──────────────────

const ci = read('.github/workflows/ci.yml');
const ciFloors = mustMatch(
  '.github/workflows/ci.yml',
  /run totals fall under (\d+) assertions \/ (\d+) suites/,
  'a sentence naming the total-assertion and suite-count floors',
);
const floorsSrc = read('test/suite-floors.mjs');
const realTotalFloor = Number(floorsSrc.match(/TOTAL_ASSERTION_FLOOR = (\d+)/)?.[1]);
const realSuiteFloor = Number(floorsSrc.match(/SUITE_COUNT_FLOOR = (\d+)/)?.[1]);
if (!realTotalFloor || !realSuiteFloor) {
  throw new Error('test/suite-floors.mjs does not export readable TOTAL_ASSERTION_FLOOR / SUITE_COUNT_FLOOR values.');
}
check(
  '.github/workflows/ci.yml names the real floors from test/suite-floors.mjs',
  Number(ciFloors[1]) === realTotalFloor && Number(ciFloors[2]) === realSuiteFloor,
  `ci.yml says ${ciFloors[1]}/${ciFloors[2]}, suite-floors.mjs says ${realTotalFloor}/${realSuiteFloor}`,
);

// ── 6. Claim: the floor table agrees with what actually ran ────────────────

check(
  'test/suite-floors.mjs TOTAL_ASSERTION_FLOOR is at or below the measured count',
  realTotalFloor <= MEASURED_ASSERTIONS,
  `floor ${realTotalFloor}, measured ${MEASURED_ASSERTIONS}`,
);
check(
  'test/suite-floors.mjs SUITE_COUNT_FLOOR is at or below the measured count',
  realSuiteFloor <= MEASURED_SUITES,
  `floor ${realSuiteFloor}, measured ${MEASURED_SUITES}`,
);

// ── 7. Claim: the README's "real output" block is an actual capture ────────
//
// The most seductive drift in a README: a plausible-looking output block that
// nobody ran. tools/readme-example.mjs is the script that is supposed to
// produce it, and this compares the two. Timestamps are normalised because they
// are the only legitimately variable part of that output.

const EXAMPLE = 'tools/readme-example.mjs';
const exampleRun = spawnSync(process.execPath, [EXAMPLE], { cwd: REPO, encoding: 'utf8' });
const exampleOut = `${exampleRun.stdout || ''}${exampleRun.stderr || ''}`;
const normalise = (s) => s
  .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<TIMESTAMP>')
  .replace(/\/private\/var\/[^\s'"]+|\/var\/folders\/[^\s'"]+|\/tmp\/[^\s'"]+/g, '<PATH>')
  .trimEnd();

const readmeSrc = read('README.md');
const blockRe = /<!-- BEGIN CAPTURED OUTPUT: tools\/readme-example\.mjs -->\n```\n([\s\S]*?)```\n<!-- END CAPTURED OUTPUT -->/;
const block = readmeSrc.match(blockRe);
if (!block) {
  throw new Error('README.md has no captured-output block delimited by the BEGIN/END CAPTURED OUTPUT markers. The block is what makes the usage example honest; deleting the markers must fail this check, not silently disable it.');
}
const captured = normalise(block[1]);
const produced = normalise(exampleOut);
check(
  'README.md usage block is byte-identical to `node tools/readme-example.mjs` output',
  captured === produced,
  captured === produced
    ? `${produced.split('\n').length} lines compared`
    : firstDiff(captured, produced),
);

// ── No personal data in anything that ships ──────────────────────────────
// The repo published a real operator email and home path once already, in
// test fixtures and then in SECURITY/CONTRIBUTING/CoC. Scrubbing by eye does
// not scale: the next doc author will do it again. This is a machine check so
// it cannot recur silently.
const PII_PATTERNS = [
  [/[\w.+-]+@[\w-]+\.[\w.]{2,}/g, 'an email address'],
  [/\/Users\/[A-Za-z0-9._-]+/g, 'an absolute macOS home path'],
  // Phone numbers: NANP shapes, with optional +country and separators. Kept
  // deliberately tight so it does not fire on packed timestamps (the corpus
  // contains 'task-1790260857672-1', which is an id, not a number).
  [/(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\b\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, 'a phone number'],
];
const SHIPPED = [
  'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md',
  'CHANGELOG.md', 'package.json', 'LICENSE',
  '.github/ISSUE_TEMPLATE/bug_report.md',
  '.github/ISSUE_TEMPLATE/feature_request.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'src/polymem.mjs', 'src/encryption.mjs', 'src/index.mjs',
];
for (const rel of SHIPPED) {
  let text;
  try { text = read(rel); } catch { continue; }  // optional files, e.g. templates
  for (const [re, what] of PII_PATTERNS) {
    for (const hit of new Set(text.match(re) || [])) {
      if (hit.includes('example.com') || hit.includes('exampleuser')) continue;
      check(`no personal data: ${rel}`, false, `contains ${what} — "${hit}"`);
    }
  }
}
check('no personal data in shipped files', true, `scanned ${SHIPPED.length} files`);

// Commit authorship is metadata, not file content — a file scan cannot see it,
// and this repo shipped a real email on every commit before it was checked.
const HIST = spawnSync('git', ['log', '--all', '--format=%an|%ae'], { encoding: 'utf8' }).stdout || '';
// Assembled from fragments so this file does not literally contain the strings
// it is scanning for -- otherwise the check flags itself on every run.
const BAD_ID = new RegExp([
  '@' + 'redwar' + '\\.com',
  '@' + 'redwar' + 'studio',
  'alfred' + '\\.' + 'redwar',
].join('|'), 'i');
const seenBad = new Set();
for (const line of HIST.split('\n')) {
  const [name, email] = line.split('|');
  const who = `${name} <${email}>`;
  if (BAD_ID.test(email || '') && !seenBad.has(who)) {
    seenBad.add(who);
    check('no personal data: commit authorship', false, `${who} — use a noreply address`);
  }
}
check('no personal data in commit authors', true, `${HIST.trim().split('\n').length} commit(s) scanned`);

function firstDiff(a, b) {
  const al = a.split('\n'), bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) return `first difference at line ${i + 1}:\n        README: ${JSON.stringify(al[i] ?? '<missing>')}\n        actual: ${JSON.stringify(bl[i] ?? '<missing>')}`;
  }
  return 'outputs differ only in trailing content';
}

// ── 8. Claim: the survivors the README quotes still pass the filter ────────
//
// The README tells a reader the filter's real ceiling and names examples. If a
// later filter improvement makes one of those examples get rejected, the README
// is advertising a limitation that no longer exists. This probes the 4 names
// the README commits to as "plausibly good knowledge that must never be
// tightened away" — the names whose rejection would mean a future filter
// improvement ate real knowledge. Verified by mutation: making any of them fail
// fails this check.

const KNOWN_FALSE_NEGATIVES = [
  'Intra-session contradiction tracking',
  'Chief of Staff handles simple direct requests without delegation',
  'Edge computing architecture prioritizes privacy, latency, and offline resilience',
  'Generate and review code snippets',
];
const fnProbe = spawnSync(process.execPath, ['-e', `
  import(${JSON.stringify(p('src/index.mjs'))}).then(m => {
    const names = ${JSON.stringify(KNOWN_FALSE_NEGATIVES)};
    console.log(JSON.stringify(names.map(n => !!m.assessPatternName(n).accept)));
  });
`], { cwd: REPO, encoding: 'utf8' });
let fnActual = null;
try { fnActual = JSON.parse(fnProbe.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
check(
  'the false negatives the README names still pass the filter',
  Array.isArray(fnActual) && fnActual.every(Boolean),
  Array.isArray(fnActual)
    ? `assessPatternName accepts ${fnActual.filter(Boolean).length}/${fnActual.length} of the names the README quotes`
    : 'could not read the filter probe — assessPatternName did not answer',
);

// ── 9. Claim: npm pack ships exactly the public files ─────────────────────

const EXPECTED_PACK = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'package.json',
  'src/encryption.mjs',
  'src/index.mjs',
  'src/polymem.mjs',
];
check(
  '`npm pack --dry-run` ships exactly the public files (zero-dependency package, no test/, docs/, sim/, tools/)',
  JSON.stringify(PACKED) === JSON.stringify(EXPECTED_PACK),
  `packed ${PACKED.length} file(s): ${PACKED.join(', ')}`,
);

// ── 10. Claim: the suite is actually green ─────────────────────────────────

check(
  'the suite is green right now (a doc guard over a red suite is decoration)',
  MEASURED_FAILING === 0 && suiteRun.status === 0,
  `${MEASURED_FAILING} failing across ${MEASURED_SUITES} suites, runner exit ${suiteRun.status}`,
);

// ── report ─────────────────────────────────────────────────────────────────

console.log(`\n${DIM}── doc claims vs measured reality ${'─'.repeat(44)}${OFF}`);
for (const r of results) {
  console.log(`  ${r.ok ? `${GRN}✓${OFF}` : `${RED}✗${OFF}`} ${r.name}`);
  console.log(`      ${DIM}${r.detail}${OFF}`);
}

const failed = results.filter((r) => !r.ok);
console.log();
if (failed.length) {
  console.log(`${RED}${failed.length} doc claim(s) do not match reality.${OFF}`);
  console.log(`${DIM}  measured: ${MEASURED_ASSERTIONS} assertions / ${MEASURED_SUITES} suites, ${PACKED.length} packed files${OFF}`);
  process.exit(1);
}
console.log(`${GRN}All ${results.length} doc claims match measured reality.${OFF}`);
console.log(`${DIM}  ${MEASURED_ASSERTIONS} assertions / ${MEASURED_SUITES} suites, ${PACKED.length} packed files${OFF}`);