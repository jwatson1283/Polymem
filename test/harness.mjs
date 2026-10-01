// test/harness.mjs
//
// Shared assertion harness. Two jobs, both about making a green run mean
// something.
//
// 1. Emit a machine-readable result line. The runner parses THIS to enforce the
//    floor — it does not scrape the human-readable `✓` lines, which were
//    formatted three different ways across the eight suites ("pass=12 fail=0",
//    "12 passed, 0 failed", ...). Parsing prose is how a harness rots; one
//    explicit marker is stable.
//
// 2. Re-check the floor when a suite runs on its own (`node test/test-memory.mjs`),
//    so the guard still fires for a developer who bypasses the runner.
//
// NOT A SUITE. This file is in test/ but is machinery; the runner excludes it.
// A `ok()` here that always returned true would be a suite asserting nothing.
//
// WHY done() SETS process.exitCode INSTEAD OF CALLING process.exit().
//
// This is the fragility the task brief flagged. `process.exit()` terminates the
// process synchronously, so:
//   - any code appended after it NEVER RUNS (silently, no error), and
//   - when stdout is a PIPE rather than a TTY, buffered output can be
//     TRUNCATED and lost.
//
// The second one is not hypothetical here: the runner captures each suite's
// output through a pipe. Two suites still called process.exit() at the end, so
// under the runner the tail of their output — including the result line this
// harness emits — could be cut off, making a healthy suite look like it
// reported nothing. Setting process.exitCode lets Node flush and exit
// naturally once the event loop drains, which fixes both problems at once.

import { SUITE_FLOORS } from './suite-floors.mjs';

// Distinctive enough to never collide with a test name or a module's own
// output, which some suites do print as raw JSON.
export const RESULT_PREFIX = '::polymem-suite-result::';

export function createSuite(name) {
  let pass = 0;
  let fail = 0;

  const ok = (cond, msg, detail = '') => {
    if (cond) {
      pass++;
      console.log(`  ✓ ${msg}`);
    } else {
      fail++;
      console.log(`  ✗ ${msg}${detail ? '  ' + detail : ''}`);
    }
  };

  const section = (title) => console.log(`${title}:`);

  const counts = () => ({ pass, fail });

  // Called once, last. Reports and sets the exit code; deliberately does not
  // call process.exit(), so anything a suite wants to run after this still
  // runs and stdout is flushed before the process ends.
  const done = () => {
    // Secondary layer. The runner re-checks this independently — the runner
    // is the one that matters, because it also catches a suite that never
    // reaches done() at all (empty file, early throw). This layer exists for
    // the standalone `node test/test-memory.mjs` path, so a developer
    // bypassing the runner is not silently running a weaker check.
    const floor = SUITE_FLOORS[name];
    let floorOk = true;
    if (floor === undefined) {
      console.log(
        `\n  ✗ FATAL: suite "${name}" is not registered in test/suite-floors.mjs. ` +
        `An unregistered suite has no floor, so it can be gutted silently — that is the ` +
        `exact failure this harness exists to prevent. Add it with a real count.`,
      );
      floorOk = false;
    } else if (pass < floor) {
      console.log(
        `\n  ✗ FATAL: suite "${name}" ran ${pass} assertions but its floor is ${floor}. ` +
        `${floor - pass} assertion(s) appear to have been deleted. The suite is gutted.`,
      );
      floorOk = false;
    }

    // Machine-readable, and always emitted — even on a floor failure, so the
    // runner can report the real number rather than "no result".
    console.log(
      RESULT_PREFIX + ' ' + JSON.stringify({
        name,
        pass,
        fail,
        floor: floor === undefined ? null : floor,
        floorOk,
      }),
    );

    if (fail > 0) {
      console.log(`\n${name}: ${pass} passed, ${fail} FAILED`);
    }
    process.exitCode = fail === 0 && floorOk ? 0 : 1;
  };

  return { ok, section, done, counts };
}
