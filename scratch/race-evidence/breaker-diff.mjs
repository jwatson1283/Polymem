// Distinguish: does the breaker delete a claim it cannot verify as abandoned?
//
// Runs the exact scenario the regression test uses, against whatever
// polymem.mjs is passed in, and reports the observable end state:
//
//   claimGone    — the planted claim file no longer exists afterwards
//   patternLanded— the child's pattern is in the index
//
// The two versions of the breaker differ exactly on `claimGone`.

import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';

const MODULE = resolve(process.argv[2]);
const workdir = mkdtempSync(join(tmpdir(), 'breaker-diff-'));
const home = join(workdir, 'home');
const indexFile = join(home, 'memory', 'patterns-index.json');
mkdirSync(join(home, 'memory'), { recursive: true });
mkdirSync(join(home, 'sessions'), { recursive: true });
const claimPath = `${indexFile}.claim`;

// An UNPARSEABLE claim, old mtime. A writer caught mid-write looks like this.
// Same host so the liveness check is allowed to reach a verdict.
writeFileSync(claimPath, '{ this is not json');
const old = new Date(Date.now() - 120_000);
utimesSync(claimPath, old, old);
console.log(`planted: unparseable claim, mtime 120s old, same host (${hostname()})`);

const src = `
  const m = await import(${JSON.stringify(MODULE)});
  const index = m.loadPatternsIndex();
  index.patterns['breaker-probe'] = { name: 'breaker probe', domains: [], sessions: [], evidenceCount: 1,
    status: 'candidate', correspondences: [], contradictions: [] };
  console.log(JSON.stringify({ saved: m.savePatternsIndex(index) }));
`;
const started = Date.now();
const out = await new Promise((res) => {
  execFile(process.execPath, ['--input-type=module', '-e', src], {
    env: { PATH: process.env.PATH, HOME: home, OMEGA_MEMORY_INDEX: indexFile,
           OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions') },
    encoding: 'utf8',
  }, (e, stdout, stderr) => res({ stdout, stderr }));
});
const elapsed = Date.now() - started;

let saved = null;
try { saved = JSON.parse(out.stdout.trim().split('\n').pop()).saved; } catch { /* below */ }
let patternLanded = false;
try { patternLanded = !!JSON.parse(readFileSync(indexFile, 'utf8')).patterns['breaker-probe']; } catch { /* absent */ }

console.log(`child saved:            ${saved}`);
console.log(`elapsed:                ${elapsed}ms`);
console.log(`claimGone (breaker ran): ${!existsSync(claimPath)}`);
console.log(`patternLanded:          ${patternLanded}`);
if (out.stderr.trim()) console.log(`stderr: ${out.stderr.trim().slice(0, 300)}`);
console.log('');
console.log(!existsSync(claimPath)
  ? 'VERDICT: the breaker DELETED a claim it could not prove abandoned (buggy).'
  : 'VERDICT: the claim SURVIVED — unreadable was not treated as abandoned (correct).');

rmSync(workdir, { recursive: true, force: true });
