// test/coverage-gate.mjs
//
// NOT A SUITE. Machinery, like harness.mjs — registered in NON_SUITE_FILES.
//
// WHAT THIS EXISTS TO KILL. The floors in suite-floors.mjs trust a number the
// SUITE ITSELF PRINTS. That number is not evidence; it is a claim. Measured on a
// clean clone at bdce4bb, this passes:
//
//   $ cat test/test-repo-root-containment.mjs
//   import { RESULT_PREFIX } from './harness.mjs';
//   for (let i = 0; i < 5; i++) console.log(`  ✓ forged assertion ${i + 1}`);
//   console.log(RESULT_PREFIX + ' ' + JSON.stringify(
//     { name: 'test-repo-root-containment.mjs', pass: 5, fail: 0, floor: 5, floorOk: true }));
//
//   $ grep -c 'src/' test/test-repo-root-containment.mjs   ->  0
//   $ npm test                                              ->  exit 0
//   16 suites, 548 assertions, 0 failing
//
// `grep -c 'src/'` is 0. The suite imports NOTHING from the library. It prints
// five green checkmarks and a well-formed result line, and both CI steps go
// green on a test that exercises no library code at all. The floors are
// satisfied by a STRING.
//
// WHY COUNTING THE `✓` LINES IS NOT ENOUGH. The obvious cheap fix is to
// cross-check reported.pass against the number of assertion lines actually
// emitted. Measured: that is defeated by the forgery above, which prints
// exactly five `✓` lines to match its lie. Any count the suite controls is a
// count the forger controls. (The cross-check is still worth having — it is
// cheap, and it catches the cruder forgeries — but on its own it is
// decoration. This file is the part that has teeth.)
//
// WHY COVERAGE IS THE SIGNAL. V8 coverage is produced by the ENGINE observing
// which functions actually ran. A suite cannot print its way to a covered
// range: to get one it has to genuinely call library code. So the question
// "did this suite exercise src/?" is asked of the runtime, not of the suite.
//
// MEASURED, per suite, at bdce4bb — src files with executed (count > 0)
// ranges under this exact gate:
//
//   all 16 suites        -> 2-3 src files each (polymem.mjs, encryption.mjs,
//                           index.mjs). Every healthy suite exercises the library.
//   forged suite         -> 0. Nothing to print, because nothing ran.
//
// NINE OF SIXTEEN SUITES GET THIS SIGNAL ONLY FROM A CHILD PROCESS.
// test-concurrency-rmw, test-concurrent-writes, test-encryption-at-rest,
// test-memory-index-location, test-prototype-safety, test-repo-root-containment,
// test-session-date-containment, test-trust-integrity and
// test-working-memory-location all drive the library through execFileSync/exec
// children and touch no src/ file in their own process. So coverage is
// AGGREGATED over every profile in the suite's coverage directory, not read
// from the parent alone. Dropping the aggregate would fail all nine on a
// correct tree — a gate that cries wolf on healthy code gets deleted.
//
// WHY THIS IS SAFE ACROSS THE CI MATRIX. Aggregating children only works if
// NODE_V8_COVERAGE reaches them, and nine suites pass an EXPLICIT env to their
// children (test-trust-integrity.mjs:70) that does not name it. Verified rather
// than assumed, on the exact versions CI runs:
//
//   node 18.20.8   child coverage from an explicit-env spawn: PROPAGATES
//   node 20.19.0   child coverage from an explicit-env spawn: PROPAGATES
//   node 26.5.1    child coverage from an explicit-env spawn: PROPAGATES
//
// (Node re-injects the variable into child_process spawns regardless of the
// env option. Confirmed with a sentinel: the explicit env really did replace
// the child's environment — an unrelated variable was absent — while
// NODE_V8_COVERAGE still arrived.)
//
// THE HONEST LIMIT, STATED PLAINLY. This defeats a suite that FORGES its
// result. It does not make the harness forgery-proof, and it is not a coverage
// threshold: a forger who genuinely calls one library function and then lies
// about everything else still clears this gate. A per-suite statement-coverage
// floor would close that, and it is not implemented here because it rots —
// every refactor moves the number, and a guard that needs re-measuring after
// unrelated edits is a guard that gets deleted. What this gate asserts is the
// weaker, durable claim: the suite RAN THE LIBRARY. Whether its assertions are
// any good remains a question for the assertions themselves.
//
// Cost, measured over the full 16-suite run: ~2.0s on an 18s suite (+11%) and
// ~38MB of coverage JSON, written to a temp dir and deleted per suite. That is
// paid only when the gate is enabled; see isGateEnabled below.

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

// The library under test. A suite that never loads a file from here has not
// tested the library, whatever it printed.

// V8 coverage records file:// URLs built from the RESOLVED path, so /tmp/... and
// /var/... (both symlinks into /private/... on macOS) appear as their targets.
// Compare against the resolved repo root or the prefix never matches and every
// suite in a symlinked checkout — a /tmp clone, a CI workspace — is reported as
// having executed no library code. Measured: tmpdir() is /var/folders/... while
// its realpath is /private/var/folders/...
function resolvedRepoRoot(repoRoot) {
  try {
    return realpathSync(repoRoot);
  } catch {
    return repoRoot; // fall back; a wrong-but-narrow match beats a hard throw
  }
}

// Escape hatch for local iteration, NOT for CI. The gate must never be able to
// silently no-op where it matters, so this only ever *disables* it, and the
// runner prints a loud banner when it is off. If you are reading this to decide
// whether to set it in ci.yml: don't.
export const DISABLE_FLAG = 'POLYMEM_SKIP_COVERAGE_GATE';

export function isGateEnabled(env = process.env) {
  return env[DISABLE_FLAG] !== '1';
}

export function disableFlagName() {
  return DISABLE_FLAG;
}

/**
 * Did this suite actually execute library code?
 *
 * Aggregates EVERY V8 coverage profile in `covDir`, because nine of sixteen
 * suites exercise src/ only from spawned children. Returns the set of src
 * basenames with at least one range whose count > 0 — i.e. code that RAN, not
 * merely a file that was loaded and never called.
 *
 * @param {string} covDir directory holding this suite's coverage JSON
 * @param {string} [repoRoot] absolute path to the repo, to bound the src/ match
 * @returns {{instrumented: boolean, files: string[]}}
 *   `instrumented` is false when no coverage JSON was produced at all. That is
 *   a distinct condition from "ran no library code" and the caller reports it
 *   differently: an un-instrumented run means the measurement failed, which is
 *   not evidence of a forged suite.
 */
export function srcFilesExecuted(covDir, repoRoot) {
  const srcPrefix = repoRoot ? join(resolvedRepoRoot(repoRoot), 'src') + sep : null;
  const files = new Set();
  let sawProfile = false;

  let entries;
  try {
    entries = readdirSync(covDir);
  } catch {
    return { instrumented: false, files: [] };
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let profile;
    try {
      profile = JSON.parse(readFileSync(join(covDir, entry), 'utf8'));
    } catch {
      continue; // a half-written profile is not evidence either way
    }
    sawProfile = true;

    for (const script of profile.result || []) {
      if (!script.url.includes(`${sep}src${sep}`)) continue;
      // Bound the match to THIS repo's src/, so a suite that happens to load
      // some unrelated package's src/ directory cannot satisfy the gate.
      if (srcPrefix) {
        const path = script.url.replace(/^file:\/\//, '');
        if (!path.startsWith(srcPrefix)) continue;
      }
      const ran = (script.functions || [])
        .flatMap((fn) => fn.ranges || [])
        .some((r) => r.count > 0);
      if (ran) files.add(script.url.split(sep).pop());
    }
  }

  return { instrumented: sawProfile, files: [...files] };
}
