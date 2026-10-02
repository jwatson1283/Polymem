// test/test-forged-suite-detection.mjs
//
// THE REGRESSION TEST FOR THE FORGERY HOLE. This suite's job is to prove the
// runner still refuses a forged result line, so a later "simplification" cannot
// quietly reopen the hole.
//
// THE ATTACK, MEASURED ON A CLEAN CLONE AT bdce4bb, BEFORE THE FIX:
//
//   $ cat test/test-repo-root-containment.mjs
//   import { RESULT_PREFIX } from './harness.mjs';
//   for (let i = 0; i < 5; i++) console.log(`  ✓ forged assertion ${i + 1}`);
//   console.log(RESULT_PREFIX + ' ' + JSON.stringify(
//     { name: 'test-repo-root-containment.mjs', pass: 5, fail: 0, floor: 5, floorOk: true }));
//
//   $ grep -c 'src/' test/test-repo-root-containment.mjs   ->  0
//   $ npm test                                              ->  exit 0
//   $ npm run docs:check                                    ->  exit 0
//   16 suites, 548 assertions, 0 failing
//
// Both CI steps green on a suite that imports NOTHING from the library.
//
// Note the five `✓` lines: they MATCH the reported count exactly. That is
// deliberate, and it is the measured reason cross-checking the count against
// the emitted lines is not sufficient by itself — that forgery satisfies such a
// check exactly. The coverage gate (test/coverage-gate.mjs) is what catches it,
// because coverage is recorded by the engine and cannot be printed.
//
// THE SANDBOX. Each case builds a throwaway repo containing the REAL runner,
// harness, coverage gate and src/, plus ONE suite — never the live test/ dir.
// An earlier version of this file copied the whole test/ directory, which meant
// the inner runner also executed this suite, which built another sandbox, and
// so on: it recursed until the 300s timeout killed it. Copying only what the
// case needs makes the depth fixed at one. The live tree is never mutated — a
// test that can leave a forged suite behind on a failure path is a worse
// problem than the one it guards — and the temp dir is removed in `finally`.
//
// THE CONTROL IS THE IMPORTANT HALF. A suite that really does call into src/
// MUST still pass. Without that case a gate which rejected everything would
// look identical to a gate that works, and "the suite is green" would prove
// nothing about the gate.

import { createSuite } from './harness.mjs';
import { DISABLE_FLAG } from './coverage-gate.mjs';
import { parseMemoryBlock } from '../src/polymem.mjs';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const { ok, section, done } = createSuite('test-forged-suite-detection.mjs');

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VICTIM = 'test-sandbox-subject.mjs';
const RUNNER_TIMEOUT_MS = 120_000;

// The sandbox is a real repo with a single suite. Its floor table is written by
// SANDBOX_FLOORS below; every other file in test/ comes from the live repo, so
// the case runs the shipped runner, harness and coverage gate.

/**
 * A one-suite repo: real runner + real gate + real src/ + the given suite.
 * Runs the real runner and returns its verdict. Never touches the live tree.
 */
function runRunnerOn(suiteSource) {
  const dir = mkdtempSync(join(tmpdir(), 'polymem-forge-'));
  try {
    cpSync(join(REPO_ROOT, 'src'), join(dir, 'src'), { recursive: true });
    cpSync(join(REPO_ROOT, 'package.json'), join(dir, 'package.json'));
    // The suites live in <dir>/test/ exactly as in the real repo. This layout is
    // load-bearing, not cosmetic: the runner derives its repo root from
    // dirname(itself)/.. and spawns each suite with cwd set to it. Dropping the
    // suites beside the runner instead makes it resolve to the sandbox PARENT,
    // so its src/ prefix never matches and an honest suite gets reported as
    // having executed no library code — a false positive that looks exactly
    // like the gate working.
    cpSync(join(REPO_ROOT, 'test'), join(dir, 'test'), {
      recursive: true,
      filter: (src) => !src.includes(`${sep}test${sep}test-`),
    });
    // Replace the copied floor table with the sandbox's one-suite table.
    writeFileSync(join(dir, 'test', 'suite-floors.mjs'), SANDBOX_FLOORS);
    writeFileSync(join(dir, 'test', VICTIM), suiteSource);

    const proc = spawnSync(process.execPath, [join(dir, 'test', 'run-tests.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      timeout: RUNNER_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      // Strip the gate-disable flag from the sandbox. If it leaked through, the
      // child runner would have the gate off and would ACCEPT the forgery this
      // suite exists to prove is rejected — so the test would pass for the
      // wrong reason, or fail confusingly, depending on the outer environment.
      // A guard that cannot be tested when the guard is switched off is not a
      // guard. Measured: the flag does inherit through process.env by default,
      // which is exactly why it is removed here.
      env: { ...process.env, [DISABLE_FLAG]: '' },
    });
    return { status: proc.status, output: (proc.stdout || '') + (proc.stderr || '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A floor table sized for the one-suite sandbox. The victim is floored at 5 so
// that BOTH forgeries below satisfy every floor and clear the count
// cross-check: whatever catches them has to be the coverage gate, not a
// number they can out-run.
const SANDBOX_FLOORS = `export const SUITE_FLOORS = { '${VICTIM}': 5 };
export const TOTAL_ASSERTION_FLOOR = 5;
export const SUITE_COUNT_FLOOR = 1;
export const NON_SUITE_FILES = new Set(['harness.mjs', 'suite-floors.mjs', 'run-tests.mjs', 'coverage-gate.mjs']);
export const SUITE_GLOB_PREFIX = 'test-';
`;

// A suite that genuinely imports and calls the library. The control.
const HONEST_SUITE = `import { createSuite } from './harness.mjs';
import { parseMemoryBlock } from '../src/polymem.mjs';
const { ok, done } = createSuite('${VICTIM}');
const sample = ['Here is my analysis.', '', '\`\`\`memory', '### Claims',
  '- The loader reads the wrong path — domain: code',
  '- SQLite WAL mode is required — domain: coding', '\`\`\`'].join('\\n');
const { display, memory } = parseMemoryBlock(sample);
ok(display.startsWith('Here is my analysis') && !display.includes('### Claims'), 'display excludes the fenced block');
ok(memory.claims.length === 2, 'claims parsed');
ok(memory.claims[0].domains[0] === 'code', 'first claim domain');
ok(memory.claims[1].domains[0] === 'code', 'second claim domain normalized');
ok(parseMemoryBlock('plain text').memory === null, 'plain text degrades to null memory');
done();
`;

// The forgery: five ✓ lines matching pass=5 exactly, plus a well-formed result
// line. Clears every floor and the count cross-check. Touches no src/ file.
const FORGED_SUITE = `import { RESULT_PREFIX } from './harness.mjs';
for (let i = 0; i < 5; i++) console.log(\`  ✓ forged assertion \${i + 1}\`);
console.log(RESULT_PREFIX + ' ' + JSON.stringify(
  { name: '${VICTIM}', pass: 5, fail: 0, floor: 5, floorOk: true }));
`;

// A cruder forgery: the result line with no assertion lines at all.
const BARE_FORGERY = `import { RESULT_PREFIX } from './harness.mjs';
console.log(RESULT_PREFIX + ' ' + JSON.stringify(
  { name: '${VICTIM}', pass: 5, fail: 0, floor: 5, floorOk: true }));
`;

// ------------------------------------------------------------- the premise ---

section('premise: the sandbox fixture reflects real src/ behaviour');
{
  // This block is not gate-satisfying filler. The control case below is only
  // trustworthy if HONEST_SUITE describes how the REAL library behaves, so
  // assert that directly here. It also means this suite genuinely executes
  // src/ code, which the coverage gate requires of every suite — a suite that
  // never runs the library has not tested anything, including the gate.
  //
  // (An earlier version of this file spawned sandboxes only. The gate correctly
  // reported that this suite "executed NO code in src/", and that was right: it
  // was a suite about the harness that never touched the library it protects.
  // Weakening the gate to accommodate it would have been the wrong fix.)
  const sample = [
    'Here is my analysis.',
    '',
    '```memory',
    '### Claims',
    '- The loader reads the wrong path — domain: code',
    '- SQLite WAL mode is required — domain: coding',
    '```',
  ].join('\n');
  const { display, memory } = parseMemoryBlock(sample);

  ok(
    display.startsWith('Here is my analysis') && !display.includes('### Claims'),
    'display excludes the fenced memory block',
    `display was: ${JSON.stringify(display?.slice(0, 120))}`,
  );
  ok(memory.claims.length === 2, 'both claims parsed from the real library', `claims: ${memory?.claims?.length}`);
  ok(
    memory.claims[0].domains[0] === 'code' && memory.claims[1].domains[0] === 'code',
    'claim domains normalize to code',
    JSON.stringify(memory?.claims?.map((c) => c.domains)),
  );
}

// ---------------------------------------------------------------- control ---

section('control: an honest suite still passes (the gate must not false-positive)');
{
  const r = runRunnerOn(HONEST_SUITE);
  ok(
    r.status === 0,
    `runner exits 0 on a suite that really calls src/ (got ${r.status})`,
    r.status === 0 ? '' : r.output.slice(-1200),
  );
  ok(
    !/executed NO code in src\//.test(r.output),
    'coverage gate did NOT fire against a suite that calls src/',
    r.output.slice(-1200),
  );
  ok(
    /1 suites, 5 assertions, 0 failing/.test(r.output),
    'honest suite reports its 5 assertions and the run is green',
    r.output.slice(-800),
  );
}

// --------------------------------------------------------------- forgeries ---

section('forgery: five MATCHING ✓ lines and a well-formed result line');
{
  const r = runRunnerOn(FORGED_SUITE);
  ok(
    r.status === 1,
    `runner exits 1 on the matching-lines forgery (got ${r.status})`,
    r.status === 1 ? '' : r.output.slice(-1200),
  );
  ok(
    /executed NO code in src\//.test(r.output),
    'diagnosed as a suite that never ran the library',
    r.output.slice(-1200),
  );
  // The claim worth locking down: this forgery satisfies the count cross-check,
  // so the coverage gate is provably the thing that caught it.
  ok(
    !/emitted \d+ passing assertion line/.test(r.output),
    'the count cross-check was satisfied by the forged lines — coverage caught it',
    r.output.slice(-1200),
  );
}

section('forgery: a bare result line with no assertion output');
{
  const r = runRunnerOn(BARE_FORGERY);
  ok(
    r.status === 1,
    `runner exits 1 on the bare forgery (got ${r.status})`,
    r.status === 1 ? '' : r.output.slice(-1200),
  );
  ok(
    /emitted 0 passing assertion line/.test(r.output),
    'diagnosed as a count that disagrees with the emitted output',
    r.output.slice(-1200),
  );
}

done();
