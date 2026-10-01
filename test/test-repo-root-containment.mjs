// test-repo-root-containment.mjs
//
// THE REGRESSION TEST FOR THE REPO_ROOT DEPTH BUG.
//
// WHAT THIS CATCHES: REPO_ROOT = resolve(MODULE_DIR, '..', '..') resolved to
// the PARENT of the repo (~/Projects) instead of the repo root itself. The
// containment guard then protected a SUPERSET — every sibling project — and
// threw a FALSE "resolves INSIDE the checkout" error for paths that were
// demonstrably outside the repo.
//
// WHY THE EXISTING 132 TESTS MISSED IT: every test writes to tmpdir(). None
// sets a path under ~/Projects, which is exactly the region where the bug
// lived. A one-character fix would turn the suite green while proving
// nothing.
//
// WHAT THIS TEST ASSERTS (both directions):
//   1. REPO_ROOT resolves to the Polymem repo root itself.
//   2. A path under a SIBLING directory is ALLOWED (does not throw).
//   3. A path genuinely INSIDE the checkout IS REFUSED (throws).
//
// Assertion 2 is the one that fails against the old line 82. Write it so it
// would have caught this bug.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = join(REPO, 'src', 'polymem.mjs');

import { createSuite } from './harness.mjs';

const { ok, done } = createSuite('test-repo-root-containment.mjs');

// Drive the real module in a child with a controlled env. The guard runs at
// module load, so we must spawn a fresh process for each scenario.
const child = (body, env) => {
  const src = `
    import(${JSON.stringify(MODULE)}).then(
      (m) => { ${body} },
      (e) => { console.log(JSON.stringify({ loadThrew: (e.message || String(e)).slice(0, 300) })); }
    );
  `;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', src],
      { cwd: REPO, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'] });
    return { out, err: '', code: 0 };
  } catch (e) {
    return { out: (e.stdout || ''), err: (e.stderr || ''), code: e.status ?? -1 };
  }
};

console.log('REPO_ROOT containment guard:');

const workdir = mkdtempSync(join(tmpdir(), 'omega-root-'));
try {
  // ── 1. REPO_ROOT resolves to the Polymem repo root itself ───────────────
  // We can't read REPO_ROOT directly (not exported), but we can infer it:
  // a path that is EXACTLY the repo root must be refused (the guard checks
  // `canonical(p) === canonical(REPO_ROOT)`).
  {
    const r = child(`
      let threw = null;
      try {
        // This path IS the repo root. The guard must refuse it.
        // We test this by setting OMEGA_MEMORY_INDEX to the repo root itself.
        // If REPO_ROOT is correct, this throws. If REPO_ROOT is the parent,
        // this also throws (repo root is inside parent), so this alone
        // doesn't distinguish. The sibling test below is the discriminator.
        // Here we just assert the guard is ACTIVE.
        m.loadPatternsIndex();
      } catch (e) { threw = e.message; }
      console.log(JSON.stringify({ threw: threw ? threw.slice(0, 200) : null }));
    `, { HOME: join(workdir, 'home1'), OMEGA_MEMORY_INDEX: REPO });
    const j = JSON.parse(r.out.trim().split('\n').pop());
    const refusal = j.loadThrew || j.threw || null;
    ok(refusal !== null, 'the containment guard is ACTIVE (refuses a path at the repo root)',
      `refusal: ${refusal}`);
  }

  // ── 2. A SIBLING directory path is ALLOWED ──────────────────────────────
  // This is the assertion that FAILS against the old line 82.
  // With REPO_ROOT = ~/Projects (wrong), a path under ~/Projects/OmegaShell-v5-her
  // is INSIDE the guard's protected set and throws a FALSE "inside the checkout" error.
  // With REPO_ROOT = ~/Projects/Polymem (correct), the same path is OUTSIDE
  // the guard's protected set and is allowed.
  {
    const siblingPath = join(REPO, '..', 'OmegaShell-v5-her', 'backend', 'memory', 'patterns-index.json');
    const r = child(`
      let threw = null;
      try {
        m.loadPatternsIndex();
      } catch (e) { threw = e.message; }
      console.log(JSON.stringify({ threw: threw ? threw.slice(0, 200) : null }));
    `, { HOME: join(workdir, 'home2'), OMEGA_MEMORY_INDEX: siblingPath });
    const j = JSON.parse(r.out.trim().split('\n').pop());
    const refusal = j.loadThrew || j.threw || null;
    ok(refusal === null,
      'a path under a SIBLING project is ALLOWED (not falsely refused as "inside the checkout")',
      `refusal: ${refusal}`);
  }

  // ── 3. A path genuinely INSIDE the checkout IS REFUSED ──────────────────
  // This must ALWAYS throw, regardless of the REPO_ROOT bug. It is the
  // control that proves the guard is still load-bearing after the fix.
  // The guard runs at module load, so the import itself rejects — the child
  // outputs `loadThrew`, not `threw`.
  {
    const insidePath = join(REPO, 'data', 'test-index.json');
    const r = child(`
      let threw = null;
      try {
        m.loadPatternsIndex();
      } catch (e) { threw = e.message; }
      console.log(JSON.stringify({ threw: threw ? threw.slice(0, 200) : null }));
    `, { HOME: join(workdir, 'home3'), OMEGA_MEMORY_INDEX: insidePath });
    const j = JSON.parse(r.out.trim().split('\n').pop());
    const refusal = j.loadThrew || j.threw || null;
    ok(refusal !== null,
      'a path genuinely INSIDE the checkout IS REFUSED (guard is load-bearing)',
      `refusal: ${refusal}`);
    ok(refusal && refusal.includes('INSIDE the checkout'),
      'the refusal message is the correct one (not a false positive)',
      `message: ${refusal}`);
  }

  // ── 4. The sibling path is not just "not throwing" — it actually works ──
  // A test that only checks "does not throw" would pass even if the module
  // silently did nothing. Prove the sibling path is actually usable.
  {
    const siblingPath = join(REPO, '..', 'OmegaShell-v5-her', 'backend', 'memory', 'patterns-index.json');
    const r = child(`
      let result = null;
      try {
        const idx = m.loadPatternsIndex();
        result = { loaded: true, hasPatterns: !!idx.patterns };
      } catch (e) { result = { loaded: false, error: e.message.slice(0, 200) }; }
      console.log(JSON.stringify(result));
    `, { HOME: join(workdir, 'home4'), OMEGA_MEMORY_INDEX: siblingPath });
    const j = JSON.parse(r.out.trim().split('\n').pop());
    ok(j.loaded === true,
      'the sibling path is actually USABLE (not just "not refused")',
      `result: ${JSON.stringify(j)}`);
    // If the guard falsely refused, loadThrew would be set and loaded=false.
    // If the guard correctly allowed, loaded=true and loadThrew is absent.
  }

} finally {
  rmSync(workdir, { recursive: true, force: true });
}

done();
