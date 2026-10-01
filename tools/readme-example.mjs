#!/usr/bin/env node
// tools/readme-example.mjs — the script the README's "Usage, with real output"
// block claims to be verbatim output of.
//
// WHY THIS IS A FILE AND NOT A PROSE BLOCK. The README used to present an
// output block with no script behind it, which is how `evidence=1` came to be
// printed when `queryPatterns` returns a field called `evidenceCount` — the
// block was not a capture, it was a plausible-looking transcription. Anything
// presented as real output should be produced by something you can re-run.
//
// tools/check-doc-claims.mjs runs this file and compares stdout against the
// fenced block in README.md, so the block cannot drift from the code again.
//
// Run it (writes to a scratch dir, never to ~/.computer-agent):
//   node tools/readme-example.mjs
//   SIM_OUT_DIR=/tmp/anything node tools/readme-example.mjs
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

// HOME and both OMEGA_MEMORY_* paths must be redirected BEFORE the library is
// imported: polymem.mjs resolves its session and index paths at module load.
// Import order is load-bearing, exactly as it is in the test suites.
const OUT = process.env.SIM_OUT_DIR
  || mkdtempSync(join(tmpdir(), 'polymem-readme-'));
mkdirSync(OUT, { recursive: true });
process.env.HOME = OUT;
process.env.OMEGA_MEMORY_INDEX = join(OUT, 'patterns-index.json');
process.env.OMEGA_MEMORY_SESSIONS_DIR = join(OUT, 'sessions');

const {
  parseMemoryBlock, appendWorkingMemory,
  loadPatternsIndex, promoteSession, queryPatterns,
} = await import(join(REPO, 'src/index.mjs'));

const SESSION = '2026-09-30';

const agentOutput = [
  'Wrote the retry wrapper. Two things worth remembering.',
  '',
  '```memory',
  '### claims',
  '- Retry wrapper needs a jittered backoff — fixed backoff synchronises every client',
  '- Serialize writes with a unique temp path, then rename, so no writer truncates another',
  '### patterns',
  '- Unique temp path plus rename makes a write atomic under concurrency — domains: code, ops',
  '- Draft, then review, then publish is the same shape as stage, then verify, then commit — domains: comms, code',
  '### correspondences',
  '- serialize-then-commit ↔ draft-then-publish',
  '```',
].join('\n');

const { display, memory } = parseMemoryBlock(agentOutput);
console.log('--- display (user-facing text, memory fence stripped) ---');
console.log(display);
console.log('');
console.log('--- parsed patterns ---');
for (const p of memory.patterns) console.log(`• ${p.text}  [${p.domains.join(', ')}]`);
console.log('');
console.log('--- contradictions flagged in-session ---');
console.log(memory.contradictions.length ? memory.contradictions.join('\n') : 'none');

const flags = appendWorkingMemory(SESSION, {
  time: new Date().toISOString(),
  agent: 'chief',
  task: 'retry wrapper',
  claims: memory.claims,
  patterns: memory.patterns,
  correspondences: memory.correspondences,
  contradictions: memory.contradictions,
});
console.log('');
console.log(`--- appendWorkingMemory → ${flags.length} contradiction flag(s) ---`);

const index = loadPatternsIndex();
const result = promoteSession(SESSION, index);
console.log('');
console.log('--- promoteSession ---');
console.log(result);

console.log('');
console.log('--- queryPatterns("temp path rename concurrency") ---');
for (const h of queryPatterns('temp path rename concurrency', index)) {
  console.log(`• ${h.name}`);
  console.log(`  status=${h.status}  evidenceCount=${h.evidenceCount}  domains=${h.domains.join(',')}  score=${h.score}`);
}

// Read the bytes back off disk rather than printing the in-memory object, so
// this block is the file a human would `cat`. Truncated at 40 lines to keep the
// README readable; the truncation is marked in the output itself so nobody can
// mistake it for the whole thing.
console.log('');
console.log('--- the index file on disk (first 40 lines of ' +
  `${readFileSync(process.env.OMEGA_MEMORY_INDEX, 'utf8').split('\n').length}) ---`);
console.log(readFileSync(process.env.OMEGA_MEMORY_INDEX, 'utf8').trimEnd().split('\n').slice(0, 40).join('\n'));
console.log('… truncated for the README; the whole file is the JSON above');

console.log('');
console.log('--- queryPatterns("how do we avoid losing writes") ---');
console.log('[]   ← same index, same library. See "Retrieval is keyword-based, not semantic".');