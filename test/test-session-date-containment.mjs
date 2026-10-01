// test-session-date-containment.mjs
//
// REGRESSION TEST FOR THE dateStr PATH TRAVERSAL (polymem.mjs, old :415/:445).
//
// THE BUG. `workingMemoryPath` interpolated the date straight into a filename:
//
//   working-${dateStr}.json
//
// The session date arrives from the model/session layer and is caller-supplied,
// so a date containing `../` escaped the sessions directory entirely.
//
// MEASURED, BEFORE THE FIX — and the direction matters, because the finding as
// filed only documented the write side:
//
//   WRITE  saveWorkingMemory('../../../../OUTSIDE/ESCAPED', { marker: ... })
//          -> returned true, created <tmp>/OUTSIDE/ESCAPED.json outside the
//             sessions dir, containing the supplied payload.
//   READ   loadWorkingMemory('../../../stolen')
//          -> returned the parsed CONTENTS of <tmp>/home/stolen.json, a file
//             outside the sessions dir. Arbitrary read, and the cheaper one to
//             abuse: it needs no write permission, only a path the process can
//             already read. Not in the original finding, not tested anywhere.
//
// WHY 3+ SEGMENTS ARE NEEDED, which is why a casual test looks safe. The name
// is `working-` + dateStr, so the FIRST `..` is glued onto that prefix and
// becomes a literal path segment rather than a parent reference. Measured
// resolution from a sessions dir at <tmp>/home/sessions:
//
//   "../TARGET"           -> <tmp>/home/sessions/working-../TARGET.json  (no escape)
//   "../../TARGET"        -> <tmp>/home/sessions/TARGET.json              (still inside)
//   "../../../TARGET"     -> <tmp>/home/TARGET.json                       (ESCAPES)
//   "../../../../TARGET"  -> <tmp>/TARGET.json                            (ESCAPES)
//
// So the tests below use 4+ segments. A test using a single `..` would pass
// against the vulnerable code and prove nothing.
//
// THE FIX validates the date against the documented contract at the single
// point where it becomes a filename, and throws. Not coerces: silently
// rewriting a garbage date to today would file a real session's memory under
// the wrong day, a corruption that surfaces weeks later as "why is this pattern
// never promoted".

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = join(REPO, 'src', 'polymem.mjs');

import { createSuite } from './harness.mjs';

const { ok, done } = createSuite('test-session-date-containment.mjs');

const work = mkdtempSync(join(tmpdir(), 'polymem-date-'));
const home = join(work, 'home');
const SESSIONS = join(home, 'sessions');
const OUTSIDE = join(work, 'OUTSIDE');
mkdirSync(SESSIONS, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });

// A file OUTSIDE the sessions dir, standing in for something a traversal
// should never be able to read.
const SECRET = join(home, 'stolen.json');
const SECRET_BODY = { date: 'x', entries: [{ task: 'AWS_SECRET=hunter2' }], contradictions: [] };
writeFileSync(SECRET, JSON.stringify(SECRET_BODY));

const env = {
  PATH: process.env.PATH, HOME: home,
  OMEGA_MEMORY_INDEX: join(home, 'memory', 'patterns-index.json'),
  OMEGA_MEMORY_SESSIONS_DIR: SESSIONS,
};

const child = (body) => {
  const src = `
    import(${JSON.stringify(MODULE)}).then(
      (m) => { const r = (() => { ${body} })();
               console.log(JSON.stringify(r === undefined ? { ok: true } : r)); },
      (e) => { console.log(JSON.stringify({ loadThrew: (e.message || String(e)).slice(0, 300) })); }
    );
  `;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', src],
      { cwd: REPO, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(String(out).trim().split('\n').pop());
  } catch (e) {
    return { crashed: (e.stderr || '').toString().split('\n').find(l => l.includes('Error')) || 'crashed' };
  }
};

console.log('session-date containment:');

try {
  // ── 1. the write side: 4+ segments must not escape ──────────────────────
  {
    const evil = '../../../../OUTSIDE/ESCAPED';
    const j = child(`
      let ret, threw = null;
      try { ret = m.saveWorkingMemory(${JSON.stringify(evil)}, { marker: 'PROOF-OF-ESCAPE' }); }
      catch (e) { threw = e.message; }
      return { ret, threw };
    `);
    const escaped = existsSync(join(OUTSIDE, 'ESCAPED.json'));
    ok(!escaped,
      'a traversal date does NOT write a file outside the sessions dir',
      escaped ? 'the file was created outside — the original bug' : '');
    ok(j.threw !== null,
      'a traversal date is REFUSED with a clear error, not coerced',
      `ret=${JSON.stringify(j.ret)} threw=${j.threw ? 'yes' : 'no'}`);
    ok(j.threw === null || /YYYY-MM-DD/.test(j.threw),
      'the error names the expected date format', j.threw || '');
  }

  // ── 2. the read side: the part the original finding missed ─────────────
  {
    const evil = '../../../stolen';
    const j = child(`
      let out, threw = null;
      try { out = m.loadWorkingMemory(${JSON.stringify(evil)}); }
      catch (e) { threw = e.message; }
      return { out, threw };
    `);
    const leaked = j.out && Array.isArray(j.out.entries) && j.out.entries.length > 0;
    ok(!leaked,
      'a traversal date does NOT read a file outside the sessions dir',
      leaked ? `leaked ${JSON.stringify(j.out.entries)} — arbitrary read` : '');
    ok(j.threw !== null, 'a traversal date is refused on the READ path too',
      `threw=${j.threw ? 'yes' : 'no'}`);
  }

  // ── 3. the full shape sweep, including the filed 8-segment repro ─────────
  {
    const shapes = [
      '../..',
      '../../../stolen',
      '../../../../OUTSIDE/ESCAPED',
      '../../../../../../../../../../tmp/polymem-probe/ESCAPED',
      'a/../../../../OUTSIDE/E3',
      '..\\..\\..\\OUTSIDE\\E4',
      '/etc/E5',
      '..%2f..%2fOUTSIDE',
    ];
    const bad = [];
    for (const d of shapes) {
      const j = child(`
        let threw = null, p = null;
        try { p = m.workingMemoryPath(${JSON.stringify(d)}); }
        catch (e) { threw = true; }
        return { threw, p };
      `);
      if (!j.threw) {
        // If it did not throw, the path must at least still be contained.
        if (!j.p || !isAbsolute(j.p) || !j.p.startsWith(SESSIONS + '/')) bad.push(d);
      }
    }
    ok(bad.length === 0,
      `all ${shapes.length} traversal shapes are refused or contained`,
      bad.length ? 'escaped: ' + bad.join(', ') : '');
  }

  // ── 4. valid dates still work, and stay inside the sessions dir ─────────
  // The fix must not be "reject everything" — that would be a silent
  // regression on the library's normal path.
  {
    const j = child(`
      const p = m.workingMemoryPath('2026-09-30');
      const saved = m.saveWorkingMemory('2026-09-30', { date: '2026-09-30', entries: [{ task: 'real work' }], contradictions: [] });
      const back = m.loadWorkingMemory('2026-09-30');
      return { p, saved, entries: back.entries, threw: null };
    `);
    ok(j.threw === null && j.p === join(SESSIONS, 'working-2026-09-30.json'),
      'a valid YYYY-MM-DD date resolves to the expected path', j.p || '');
    ok(j.saved === true, 'a valid date saves normally');
    ok(j.entries && j.entries.length === 1 && j.entries[0].task === 'real work',
      'a valid date round-trips its content', JSON.stringify(j.entries));
    ok(existsSync(join(SESSIONS, 'working-2026-09-30.json')),
      'the session file is written INSIDE the sessions dir');
  }

  // ── 5. the rejected set is the whole point: nothing odd is accepted ─────
  {
    const bad = ['2026-9-3', '20260930', 'today', '', '2026-09-30T00:00', null, 20260930, {}, '../2026-09-30'];
    const accepted = [];
    for (const d of bad) {
      const j = child(`
        let threw = null;
        try { m.workingMemoryPath(${JSON.stringify(d)}); } catch (e) { threw = true; }
        return { threw };
      `);
      if (!j.threw) accepted.push(JSON.stringify(d));
    }
    ok(accepted.length === 0,
      `all ${bad.length} malformed dates are rejected rather than coerced`,
      accepted.length ? 'accepted: ' + accepted.join(', ') : '');
  }

  // ── 6. appendWorkingMemory is the server-reachable entry point ──────────
  // It calls both load and save, so it inherits the guard — but only if the
  // guard is in the path-building function and not merely in the two callers.
  {
    const j = child(`
      let threw = null;
      try {
        m.appendWorkingMemory('../../../../OUTSIDE/VIAPPEND', {
          time: 't', agent: 'probe', claims: [], patterns: [{ text: 'x', domains: [] }],
          correspondences: [], contradictions: [],
        });
      } catch (e) { threw = e.message; }
      return { threw };
    `);
    ok(!existsSync(join(OUTSIDE, 'VIAPPEND.json')),
      'appendWorkingMemory cannot be used to escape either');
    ok(j.threw !== null, 'appendWorkingMemory refuses a traversal date too',
      `threw=${j.threw ? 'yes' : 'no'}`);
  }

  // ── 7. nothing landed outside the sandbox ───────────────────────────────
  // EXCLUDE the two files this test planted on purpose: stolen.json is the
  // read-side decoy, and the sessions dir + memory dir are legitimate. Counting
  // the decoy as an escape artifact would make this assertion pass for the
  // wrong reason — or fail forever, depending on which way it was written.
  {
    const PLANTED = new Set([SECRET]);
    const strays = [];
    const walk = (dir, depth = 0) => {
      if (depth > 3) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'memory') walk(p, depth + 1); }
        else if (p.startsWith(SESSIONS + '/') || p.includes('patterns-index') || PLANTED.has(p)) continue;
        else strays.push(p);
      }
    };
    walk(home);
    ok(strays.length === 0, 'no file was created outside the sessions dir',
      strays.join(', '));
  }

} finally {
  rmSync(work, { recursive: true, force: true });
}

done();
