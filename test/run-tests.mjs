#!/usr/bin/env node
// test/run-tests.mjs
//
// THE RUNNER. Sole entry point for `npm test`. Closes three gaps at once,
// because all three are the same underlying defect — the harness trusted a
// green exit code without ever looking at what produced it.
//
//   GAP 1  A gutted suite exits 0. This runner refuses to believe an exit code
//          alone: it requires each suite to REPORT its assertion count, and
//          fails when the count is below the floor in suite-floors.mjs or when
//          there is no report at all.
//   GAP 3  `npm test` used to hardcode eight suite paths in package.json, so a
//          ninth suite silently never ran. This runner globs test/ instead.
//
// Design notes worth knowing before editing:
//
//   * The floor check lives HERE, not in the suites. A suite truncated to zero
//     bytes has no code left to check itself. Truncate a suite and the only
//     thing still standing is this file.
//
//   * Suites run in SEPARATE PROCESSES, one at a time, via spawnSync. That is
//     not incidental isolation — several suites deliberately pollute
//     Object.prototype and then assert on it, and test-prototype-safety.mjs
//     spawns children to observe that pollution. Running suites in-process
//     would let one suite's contamination decide another's verdict, and would
//     make a floor failure unable to stop the run.
//
//   * Output is captured through a PIPE, not inherited. That is what lets the
//     runner read the result line. It is also why the harness sets
//     process.exitCode rather than calling process.exit() — see harness.mjs.
//
//   * Sorted order. Deterministic output, and a failure is reproducible by
//     reading top to bottom.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RESULT_PREFIX } from './harness.mjs';
import { disableFlagName, isGateEnabled, srcFilesExecuted } from './coverage-gate.mjs';
import {
  NON_SUITE_FILES,
  SUITE_COUNT_FLOOR,
  SUITE_FLOORS,
  SUITE_GLOB_PREFIX,
  TOTAL_ASSERTION_FLOOR,
} from './suite-floors.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');

// A suite that hangs must not hang CI forever.
const SUITE_TIMEOUT_MS = 120_000;

const BOLD = '[1m';
const RED = '[31m';
const GREEN = '[32m';
const DIM = '[2m';
const OFF = '[0m';
const c = (code, s) => `${code}${s}${OFF}`;

// ---------------------------------------------------------------- discover --

const entries = readdirSync(TEST_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
  .map((e) => e.name)
  .sort();

const suites = entries.filter((n) => n.startsWith(SUITE_GLOB_PREFIX));

const strays = entries.filter(
  (n) => !n.startsWith(SUITE_GLOB_PREFIX) && !NON_SUITE_FILES.has(n),
);

const missing = suites.filter((n) => SUITE_FLOORS[n] === undefined);

// THE INVERSE OF THE CHECK ABOVE, and the half that was missing. `missing`
// catches a suite with no floor row. Nothing caught the reverse: a floor row
// whose suite file was DELETED. That row keeps certifying coverage that no
// longer exists.
//
// It is also why pinning SUITE_COUNT_FLOOR alone was not enough. A count floor
// with any slack tolerates a deletion, and the slack comes back silently every
// time a suite is added without the floor being raised — which is how this got
// to two suites' worth of hole. This check has no slack to give back: it is an
// identity test, not a threshold. Together the two make the directory and the
// table mutually exhaustive, so neither side can drift without the run failing
// loudly — and the suite-count floor stays as the net for the one case this
// cannot see, a suite deleted *together with* its floor row.
const staleFloors = Object.keys(SUITE_FLOORS).filter((n) => !suites.includes(n));

console.log(c(BOLD, `polymem test harness`) + c(DIM, ` — ${suites.length} suites discovered`));

// A file in test/ that is neither a `test-*.mjs` suite nor known machinery is
// almost always a suite that was misnamed. Running it would be right; IGNORING
// it would be the GAP 3 failure all over again, so it fails loudly instead.
if (strays.length) {
  console.log(
    c(RED, `\n✗ FATAL: ${strays.length} file(s) in test/ are neither a suite nor registered machinery:`),
  );
  for (const s of strays) {
    console.log(
      c(RED, `    ${s}`) +
        c(DIM, ` — suites must be named "${SUITE_GLOB_PREFIX}*.mjs" or be listed in NON_SUITE_FILES`),
    );
  }
  console.log(c(DIM, '  A suite the runner cannot recognise is a suite that never runs.\n'));
}

// A suite with no floor row is the GAP 1 hole reopened by a new file: it would
// run, and it could be gutted with nothing to catch it.
if (missing.length) {
  console.log(c(RED, `\n✗ FATAL: ${missing.length} suite(s) have no floor in test/suite-floors.mjs:`));
  for (const m of missing) console.log(c(RED, `    ${m}`));
  console.log(c(DIM, '  Add a row with a real measured count before this suite can run.\n'));
}

// A floor row whose suite is gone is a deleted suite nothing noticed. Without
// this the row sits in the table looking like a guarantee while nothing runs
// behind it.
if (staleFloors.length) {
  console.log(
    c(RED, `\n✗ FATAL: ${staleFloors.length} floor row(s) in test/suite-floors.mjs have no suite file:`),
  );
  for (const stale of staleFloors) {
    console.log(
      c(RED, `    ${stale}`) +
        c(DIM, ` — the suite was deleted or renamed, but its floor row survived`),
    );
  }
  console.log(
    c(DIM, '  A row with no suite certifies coverage that does not exist. Delete the row\n') +
      c(DIM, '  too — and then SUITE_COUNT_FLOOR is the net that stops you.\n'),
  );
}

// -------------------------------------------------------------------- run ---

const rows = [];
let hardFailure =
  strays.length > 0 || missing.length > 0 || staleFloors.length > 0;

const COVERAGE_GATE_ON = isGateEnabled();

if (!COVERAGE_GATE_ON) {
  console.log(
    c(RED, `\n✗ WARNING: ${disableFlagName()}=1 — the forged-suite coverage gate is DISABLED.`),
  );
  console.log(
    c(DIM, '  A suite can report any assertion count it likes without running the\n') +
      c(DIM, '  library. Never set this in CI; it exists for local iteration only.\n'),
  );
}

for (const name of suites) {
  const path = join(TEST_DIR, name);
  const floor = SUITE_FLOORS[name];

  // Coverage goes to a fresh temp dir per suite, so profiles cannot leak
  // between suites and a suite cannot be credited with another's library calls.
  const covDir = COVERAGE_GATE_ON ? mkdtempSync(join(tmpdir(), 'polymem-cov-')) : null;

  const proc = spawnSync(process.execPath, [path], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: SUITE_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    // NODE_V8_COVERAGE is what makes the engine record which functions ran.
    // Node propagates it to child_process spawns even when the child is given
    // an explicit env (verified on node 18/20/26) — which matters, because nine
    // of the sixteen suites only reach src/ through a child process.
    env: covDir ? { ...process.env, NODE_V8_COVERAGE: covDir } : process.env,
  });

  const stdout = proc.stdout || '';
  const stderr = proc.stderr || '';

  // Suites print human-readable output; show it, minus the marker line the
  // runner consumes. A failing suite's output is the whole point.
  const body = stdout
    .split('\n')
    .filter((l) => !l.startsWith(RESULT_PREFIX))
    .join('\n')
    .trimEnd();
  if (body) console.log(`\n${body}`);

  const problems = [];

  if (proc.error) {
    problems.push(
      proc.error.code === 'ETIMEDOUT'
        ? `timed out after ${SUITE_TIMEOUT_MS / 1000}s`
        : `failed to launch: ${proc.error.message}`,
    );
  }

  // Parse the machine-readable result line. NO LINE IS THE GUTTED-SUITE CASE
  // and is the single most important check in this file: a suite truncated to
  // zero bytes runs, asserts nothing, and exits 0, so the exit code alone
  // would call that a pass.
  const markerLine = stdout.split('\n').find((l) => l.startsWith(RESULT_PREFIX));
  let reported = null;

  if (!markerLine) {
    // The file size makes the diagnosis instant: 0 bytes means truncated, a
    // large size means it crashed or returned early before done().
    let size = 'unknown';
    try {
      size = `${statSync(path).size} bytes`;
    } catch {
      /* file vanished mid-run; the message below still stands */
    }
    problems.push(
      `reported no result — it never called done() and therefore asserted nothing ` +
        `(file is ${size}). An empty or gutted suite is a FAILURE, not a pass.`,
    );
  } else {
    try {
      reported = JSON.parse(markerLine.slice(RESULT_PREFIX.length).trim());
    } catch (e) {
      problems.push(`emitted a malformed result line: ${e.message}`);
    }
  }

  if (reported) {
    // 1. Real assertion failures.
    if (reported.fail > 0) problems.push(`${reported.fail} assertion(s) failed`);

    // 2. THE FLOOR. This is the guard the task asked for. It also catches a
    //    partial gut — someone deleting 20 of 57 assertions while leaving the
    //    file syntactically intact and the remaining 37 passing.
    if (reported.pass < floor) {
      problems.push(
        `ran ${reported.pass} assertions but its floor is ${floor} — ` +
          `${floor - reported.pass} assertion(s) appear to have been deleted`,
      );
    }

    // 3. The suite's self-check is a second opinion, not a tiebreaker. It
    //    reporting false here is the CORRECT outcome (it agrees the floor was
    //    missed) and is not an error in itself — the two layers are
    //    independent, and a floor miss must be reported as a floor miss.
    //    The real defect is the inverse: the suite believing it passed while
    //    the table says otherwise.
    if (reported.floor === null || reported.floor !== floor) {
      problems.push(
        `reports floor ${reported.floor} but the table says ${floor} — ` +
          `harness and floor table disagree; one of them is stale`,
      );
    }

    // 4. A suite that reports failures but exits 0 is lying about its own
    //    result. Catch the inconsistency rather than picking a winner.
    const exitOk = proc.status === 0;
    if (reported.fail > 0 && exitOk) {
      problems.push(`reported ${reported.fail} failure(s) but exited 0 — harness is inconsistent`);
    }

    // 5. THE EMITTED-LINE CROSS-CHECK. The result line is a CLAIM; the `✓`/`✗`
    //    lines are the suite's own account of what it did. Comparing them
    //    catches a forger who reports a count it never emitted.
    //
    //    Honest scope, measured: this alone does NOT close the hole. A forger
    //    who prints one `✓` per asserted lie satisfies it exactly — verified,
    //    see test/test-forged-suite-detection.mjs, which forges five matching
    //    lines and is caught only by check 6. This check is kept because it is
    //    free and catches the cruder forgeries; it is not the gate.
    const passLines = stdout.split('\n').filter((l) => /^ {2}✓ /.test(l)).length;
    const failLines = stdout.split('\n').filter((l) => /^ {2}✗ /.test(l)).length;
    if (passLines !== reported.pass) {
      problems.push(
        `reported pass=${reported.pass} but emitted ${passLines} passing assertion line(s) — ` +
          `the count and the output disagree`,
      );
    }
    if (failLines !== reported.fail) {
      problems.push(
        `reported fail=${reported.fail} but emitted ${failLines} failing assertion line(s) — ` +
          `the count and the output disagree`,
      );
    }
  }

  // 6. THE COVERAGE GATE — the check with teeth. Everything above trusts
  //    something the suite printed; this asks the ENGINE whether the library
  //    ran. A suite that forges its result line cannot forge a coverage range:
  //    to have one, it has to genuinely call src/ code. Measured at bdce4bb,
  //    all 16 healthy suites execute 2-3 src files each and a forged suite
  //    executes none. See test/coverage-gate.mjs for the full evidence,
  //    including why this aggregates child profiles and why that holds on
  //    node 18/20.
  //
  //    Only meaningful for a suite that otherwise claims success: a suite
  //    already failing for another reason has told us it is broken, and adding
  //    a second diagnosis for the same file is noise.
  if (covDir) {
    // try/finally: a throw while reading the profiles must not skip the
    // delete, or a throwing gate accumulates ~40MB of coverage JSON per suite
    // in tmpdir for the rest of the run. (A SIGKILLed runner still leaks — the
    // measured 78 stale dirs on this machine were from runs I killed — so this
    // only covers the in-process paths, not an aborted CI job.)
    let instrumented = false;
    let files = [];
    try {
      ({ instrumented, files } = srcFilesExecuted(covDir, REPO_ROOT));
    } finally {
      rmSync(covDir, { recursive: true, force: true });
    }
    if (!instrumented) {
      // Not the same as "ran nothing". No profile at all means the measurement
      // itself failed, which is a problem with this runner, not evidence about
      // the suite. Never let a broken measurement read as a forged suite.
      problems.push(
        'coverage produced no profile for this suite — the forgery gate could not ' +
          'evaluate it. Treat this runner as broken, not the suite.',
      );
    } else if (files.length === 0 && problems.length === 0) {
      problems.push(
        'executed NO code in src/ yet reported a passing result — a suite that ' +
          'never runs the library can print any assertion count it likes. ' +
          'This is the forged-suite shape (see test/coverage-gate.mjs).',
      );
    }
  }

  const pass = reported ? reported.pass : 0;
  const ok = problems.length === 0;

  rows.push({ name, pass, floor, ok, problems });
  if (!ok) hardFailure = true;
}

// ----------------------------------------------------------------- report ---

const totalPass = rows.reduce((n, r) => n + r.pass, 0);
const failedRows = rows.filter((r) => !r.ok);

console.log(`\n${c(BOLD, '── suite floors ' + '─'.repeat(52))}`);
for (const r of rows) {
  const mark = r.ok ? c(GREEN, '✓') : c(RED, '✗');
  const counts = `${String(r.pass).padStart(3)}/${String(r.floor).padStart(3)}`;
  console.log(`  ${mark} ${r.name.padEnd(38)} ${counts} assertions`);
  for (const p of r.problems) console.log(c(RED, `      ${p}`));
}

// The two nets the per-suite floors structurally cannot see. Deleting a whole
// suite leaves every remaining suite above its own floor, so without these
// the run is green with a hole in it.
const netProblems = [];
if (rows.length < SUITE_COUNT_FLOOR) {
  netProblems.push(
    `only ${rows.length} suite(s) ran, floor is ${SUITE_COUNT_FLOOR} — a suite was deleted or renamed`,
  );
}
if (totalPass < TOTAL_ASSERTION_FLOOR) {
  netProblems.push(
    `${totalPass} assertions ran across all suites, floor is ${TOTAL_ASSERTION_FLOOR} — ` +
      `${TOTAL_ASSERTION_FLOOR - totalPass} assertion(s) went missing somewhere`,
  );
}

console.log(c(BOLD, '── totals ' + '─'.repeat(58)));
console.log(
  `  ${rows.length} suites, ${totalPass} assertions, ${failedRows.length} failing`,
);
for (const p of netProblems) console.log(c(RED, `  ✗ ${p}`));

const grand = hardFailure || netProblems.length > 0;

console.log(
  '\n' +
    (grand
      ? c(RED, c(BOLD, `HARNESS TRUST FAILED — ${failedRows.length + netProblems.length} problem(s). `)) +
        c(DIM, 'A green run here is supposed to mean the code was exercised.')
      : c(GREEN, c(BOLD, `OK — ${totalPass} assertions across ${rows.length} suites.`)) +
        c(DIM, ' Every suite cleared its floor; no suite is empty.')),
);

process.exitCode = grand ? 1 : 0;
