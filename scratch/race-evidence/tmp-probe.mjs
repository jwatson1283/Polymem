#!/usr/bin/env node
// tmp-probe.mjs — measure the PRE-FIX fixed-tmp-name race, to replace a bare
// point estimate ("1 of 5 writers") in src/polymem.mjs with a measured range.
//
// 5 concurrent processes x 600 patterns each, all saving the same index. Every
// writer builds a FIXED tmp name, so they share one temp file and clobber each
// other. Reports how many of the 5 writers' patterns actually land.
//
// Usage: node tmp-probe.mjs <path-to-polymem.mjs> [runs]

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE = process.argv[2];
const RUNS = Number(process.argv[3] || 30);
const WRITERS = 5;
const PER_WRITER = 600;

const PATTERNS_PER_WRITER = (w) => Array.from({ length: PER_WRITER }, (_, i) => ({
  name: `t${w}-p${i}`,
  domains: [], sessions: [], evidenceCount: 1, status: 'candidate',
  correspondences: [], contradictions: [],
}));

function runOnce() {
  const workdir = mkdtempSync(join(tmpdir(), 'tmpprobe-'));
  const indexFile = join(workdir, 'patterns-index.json');
  const children = [];
  for (let w = 0; w < WRITERS; w++) {
    const src = `
      const m = await import(${JSON.stringify(MODULE)});
      let index;
      try { index = m.loadPatternsIndex(); } catch { index = { patterns: {} }; }
      if (!index.patterns) index.patterns = {};
      for (const p of ${JSON.stringify(PATTERNS_PER_WRITER(w))}) index.patterns[p.name] = p;
      console.log(JSON.stringify({ saved: m.savePatternsIndex(index) }));
    `;
    children.push(new Promise((res) => {
      execFile(process.execPath, ['--input-type=module', '-e', src], {
        env: { PATH: process.env.PATH, HOME: workdir,
               OMEGA_MEMORY_INDEX: indexFile,
               OMEGA_MEMORY_SESSIONS_DIR: join(workdir, 'sessions') },
        encoding: 'utf8',
      }, (e, stdout) => res({ ok: !e, stdout }));
    }));
  }
  return Promise.all(children).then((r) => {
    let pats = 0, parseError = null, represented = 0;
    try {
      const idx = JSON.parse(readFileSync(indexFile, 'utf8'));
      pats = Object.keys(idx.patterns || {}).length;
      represented = new Set(Object.keys(idx.patterns || {})
        .map((k) => k.split('-')[0])).size;
    } catch (e) { parseError = String(e.message || e); }
    rmSync(workdir, { recursive: true, force: true });
    return { pats, represented, parseError };
  });
}

const results = [];
for (let r = 0; r < RUNS; r++) results.push(await runOnce());

const counts = results.map((r) => r.pats);
const reps = results.map((r) => r.represented);
const freq = (a) => {
  const m = new Map();
  for (const v of a) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((x, y) => x[0] - y[0]).map(([k, n]) => `${k}x${n}`).join(' ');
};
const mode = (a) => {
  const m = new Map();
  for (const v of a) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((x, y) => y[1] - x[1])[0][0];
};
console.log(JSON.stringify({
  runs: RUNS,
  writers: WRITERS,
  patterns_per_writer: PER_WRITER,
  expected: WRITERS * PER_WRITER,
  patterns_range: `${Math.min(...counts)}-${Math.max(...counts)}`,
  patterns_mode: mode(counts),
  patterns_distribution: freq(counts),
  writers_represented_range: `${Math.min(...reps)}-${Math.max(...reps)}`,
  writers_represented_distribution: freq(reps),
  parse_failures: results.filter((r) => r.parseError).length,
}, null, 2));
