// test-working-memory-location.mjs — the §6.11 door, asserted.
//
// WHAT THIS ASSERTS, and why it is not the same file as test-memory-index-location.mjs.
//
// That suite owns the INDEX. This one owns the SESSIONS dir, which is a
// different variable, a different file, and a different failure — §6.11 says so
// and the measurement agrees. Three things it pins, all of them measured:
//
//   1. HOME unset must not produce a relative "undefined/…" path, and must not
//      manufacture a directory tree inside the checkout. §6.11's first finding.
//
//   2. An unwritable sessions dir must NOT throw out of saveWorkingMemory.
//      §6.11's second finding, which is the one still open at 43b3b62:
//      memory.mjs:399-405 has no try/catch while loadWorkingMemory (:392) and
//      savePatternsIndex (:332) both do. Measured: {"saved":false,"threw":"EACCES"}.
//
//   3. appendWorkingMemory — the SERVER-reachable entry point, server.mjs:488 —
//      must still RETURN its flags when the write fails. This is the assertion
//      that was missing, and it is the one with a user-visible cost: server.mjs
//      does `flags = await queuedWrite(...)`, and queuedWrite's .catch resolves to
//      undefined (:67), so a failed write reaches :518's `contradictions: flags
//      || []` and reports ZERO contradictions for a session that had some. A
//      memory feature that cannot record a contradiction must not claim it found
//      none.
//
// WHY A CHILD PROCESS, and why the REAL MODULE IN PLACE.
//
// SESSIONS_DIR and INDEX_FILE resolve at module load, so an in-process import
// cannot vary them and would inherit whatever the parent exported. And
// REPO_ROOT = resolve(MODULE_DIR, '..', '..') resolves from the module's OWN
// location, so a scratch COPY silently redefines the repo root — the containment
// guard then fires on a path nowhere near the checkout and reads as a false
// positive in a guard that is correct. Copy-then-test measures a different
// program. This suite imports the real module, in place, in a child.
//
// THE REPO IS NEVER WRITTEN. Every case points HOME and the sessions dir at a
// throwaway tmpdir, and case 1 additionally asserts the worktree stayed clean, so
// a regression that reintroduces the checkout write is caught by the assertion
// rather than by a dirty tree someone notices later.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = join(REPO, 'src', 'polymem.mjs');

import { createSuite } from './harness.mjs';

const { ok, done } = createSuite('test-working-memory-location.mjs');

// Drive the real module in a child with a controlled env. `body` runs with the
// module namespace bound to `m`. Never throws on a non-zero exit, because
// "the child threw" is a RESULT here, not a failure of the harness.
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

console.log('working-memory (sessions dir) location:');

const workdir = mkdtempSync(join(tmpdir(), 'omega-wmloc-'));
try {
  // ── 1. HOME unset: the "undefined/…" door ───────────────────────────────
  // The literal string "undefined/Documents/…" is RELATIVE, so it resolves
  // against process.cwd() and mkdirSync(recursive:true) manufactures the whole
  // chain inside the app directory. Asserted on the PATH, because the path is
  // the defect; a save merely not throwing would pass on a relative path too.
  {
    const env = { PATH: process.env.PATH };
    delete env.HOME;                       // genuinely unset, not empty
    const r = child(`
      const p = m.workingMemoryPath('2026-09-28');
      console.log(JSON.stringify({ path: p, absolute: p.startsWith('/'), seg: p.split('/')[1] }));
    `, env);
    let j = {};
    try { j = JSON.parse(r.out.trim().split('\n').pop()); } catch { /* reported below */ }
    ok(j.absolute === true, 'HOME unset leaves the sessions dir an ABSOLUTE path',
      `got ${j.path}`);
    ok(j.seg !== 'undefined', 'HOME unset does not manufacture an "undefined/" tree',
      `first segment was ${j.seg}`);
  }

  // ── 2. the write path must degrade, not throw ────────────────────────────
  // The load-bearing assertion, and the one §6.11b left open. chmod 500 rather
  // than /dev/null/nope because EACCES is the symptom §6.11 actually recorded;
  // a non-directory proves a different error.
  {
    const ro = join(workdir, 'ro-sessions');
    mkdirSync(ro, { recursive: true });
    chmodSync(ro, 0o500);
    const r = child(`
      let threw = null;
      try { m.saveWorkingMemory('2026-09-28', { date: '2026-09-28', entries: [], contradictions: [] }); }
      catch (e) { threw = e.code || e.message; }
      console.log(JSON.stringify({ threw }));
    `, { HOME: join(workdir, 'home2'), OMEGA_MEMORY_SESSIONS_DIR: join(ro, 'sessions') });
    const j = JSON.parse(r.out.trim().split('\n').pop());
    ok(j.threw === null, 'an unwritable sessions dir does NOT throw out of saveWorkingMemory',
      `threw ${j.threw} — memory.mjs:399 has no try/catch, unlike :332 and :392`);
  }

  // ── 3. the SERVER-reachable path must still return its flags ─────────────
  // This is the assertion with a user-visible cost, and it is the one that was
  // missing. server.mjs:488 assigns `flags = await queuedWrite(...)`; queuedWrite's
  // .catch (server.mjs:67) resolves to undefined, so a failed write leaves flags
  // undefined and :518's `contradictions: flags || []` reports ZERO for a session
  // that had some. The return value is the contract; assert the contract.
  {
    const ro = join(workdir, 'ro-sessions-2');
    mkdirSync(ro, { recursive: true });
    chmodSync(ro, 0o500);
    const r = child(`
      let threw = null, flags = null;
      try {
        flags = m.appendWorkingMemory('2026-09-28', {
          time: new Date().toISOString(), agent: 'probe', task: 't',
          claims: [{ text: 'the sky is blue', domains: ['other'] }],
        });
      } catch (e) { threw = e.code || e.message; }
      console.log(JSON.stringify({
        threw,
        isArray: Array.isArray(flags),
        len: Array.isArray(flags) ? flags.length : null,
      }));
    `, { HOME: join(workdir, 'home3'), OMEGA_MEMORY_SESSIONS_DIR: join(ro, 'sessions') });
    const j = JSON.parse(r.out.trim().split('\n').pop());
    ok(j.threw === null, 'appendWorkingMemory does not throw when the write fails',
      `threw ${j.threw}`);
    ok(j.isArray === true, 'appendWorkingMemory still RETURNS an array when the write fails',
      'server.mjs:518 does `contradictions: flags || []`, so a non-array here reports ' +
      'zero contradictions for a session that had them');
  }

  // ── 4. the checkout stayed clean ─────────────────────────────────────────
  // A missing measurement is not a low one: if the module resolved anything into
  // the repo, the door is open again regardless of what the other three said.
  {
    const r = child(`
      const before = m.workingMemoryPath('2026-09-28');
      console.log(JSON.stringify({ before }));
    `, { HOME: join(workdir, 'home4') });
    const stray = [join(REPO, 'undefined'), join(REPO, 'backend', 'memory', 'undefined')];
    const found = stray.filter((p) => existsSync(p));
    ok(found.length === 0, 'no "undefined/" tree exists inside the checkout',
      found.join(', '));
  }

  // ── 5. the control, because §11.5 requires one ───────────────────────────
  // Every assertion above is a "does not happen". An instrument that has only
  // ever returned the expected answer has not been observed, so force a real
  // failure and show the same harness reporting it.
  //
  // The control asserts the OBSERVATION, not the verdict. A genuine failure now
  // surfaces as `saveWorkingMemory` returning false rather than throwing — that
  // IS the fix working — so requiring a throw here would be asserting the bug
  // is back. What must be proven is that the harness can still SEE a failed
  // write and say so, which is what the return value carries.
  {
    const r = child(`
      const saved = m.saveWorkingMemory('2026-09-28', { date: '2026-09-28', entries: [], contradictions: [] });
      console.log(JSON.stringify({ saved }));
    `, { HOME: join(workdir, 'home5'), OMEGA_MEMORY_SESSIONS_DIR: '/dev/null/nope/sessions' });
    const j = JSON.parse(r.out.trim().split('\n').pop());
    ok(j.saved === false,
      'CONTROL: a genuinely unwritable target is OBSERVED as a failed save, not a silent one',
      `saveWorkingMemory returned ${JSON.stringify(j.saved)} against /dev/null/nope — ` +
      'if this ever reads true, the write is being lost silently and this control is the only thing watching');
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

done();
