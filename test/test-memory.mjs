// test-memory.mjs — Phase 1 smoke test. Runs against temp dirs; never touches the real vault.
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'omega-memory-test-'));
process.env.OMEGA_MEMORY_INDEX = join(tmp, 'patterns-index.json');
process.env.OMEGA_MEMORY_SESSIONS_DIR = join(tmp, 'sessions');

const m = await import('../src/polymem.mjs');

import { createSuite } from './harness.mjs';

const { ok, done } = createSuite('test-memory.mjs');

// ── parseMemoryBlock ──
console.log('parseMemoryBlock:');
const sample = `Here is my analysis of the codebase.

\`\`\`memory
### Claims
- The loader reads the wrong path — domain: code
- SQLite WAL mode is required — domain: coding
### Patterns
- Serialize-then-write under concurrency — domains: code, ops
### Correspondences
- This write queue corresponds to single-writer-principle in database design
### Contradictions
- Claim A contradicts claim B
\`\`\``;

const { display, memory } = m.parseMemoryBlock(sample);
ok(display.startsWith('Here is my analysis') && !display.includes('### Claims'), 'display text excludes fenced block');
ok(memory.claims.length === 2, 'claims parsed (2)');
ok(memory.claims[0].domains[0] === 'code', 'domain "code" passes through');
ok(memory.claims[1].domains[0] === 'code', 'domain "coding" normalized to "code"');
ok(memory.patterns.length === 1 && memory.patterns[0].domains.length === 2, 'pattern with 2 domains parsed');
ok(memory.correspondences.length === 1, 'correspondence parsed');
ok(memory.contradictions.length === 1, 'contradiction parsed');

const noBlock = m.parseMemoryBlock('just plain output, no block');
ok(noBlock.memory === null && noBlock.display === 'just plain output, no block', 'no-block output degrades to null memory');
const empty = m.parseMemoryBlock('');
ok(empty.memory === null, 'empty input degrades safely');

// ── working memory + intra-session contradiction ──
console.log('appendWorkingMemory + contradictions:');
const date = '2026-09-23';
let flags = m.appendWorkingMemory(date, {
  time: 't1', agent: 'sparks', task: 'test',
  claims: [{ text: 'SQLite WAL mode is required for concurrent readers', domains: ['code'] }],
  patterns: [{ text: 'Serialize-then-write under concurrency', domains: ['code', 'ops'] }],
  correspondences: [], contradictions: [],
});
ok(flags.length === 0, 'first write: no contradictions');

flags = m.appendWorkingMemory(date, {
  time: 't2', agent: 'sentry', task: 'test',
  claims: [{ text: 'SQLite WAL mode is not required for concurrent readers', domains: ['code'] }],
  patterns: [], correspondences: [], contradictions: [],
});
ok(flags.length === 1, 'contradicting claim flagged');
ok(flags[0].existingClaim.includes('WAL mode is required'), 'flag references the earlier claim');

const wm = m.loadWorkingMemory(date);
ok(wm.entries.length === 2 && wm.contradictions.length === 1, 'working memory persisted with contradiction record');

// ── promotion ──
console.log('promoteSession:');
let index = m.loadPatternsIndex();
const r1 = m.promoteSession(date, index);
ok(r1.promoted.includes('serialize-then-write-under-concurrency'), 'pattern promoted to candidate');
ok(index.patterns['serialize-then-write-under-concurrency'].evidenceCount === 1, 'evidence count 1 after first session');
ok(index.patterns['serialize-then-write-under-concurrency'].status === 'candidate', 'status candidate (1 session)');

// second session, different day, adds a domain → still candidate but evidence 2
m.appendWorkingMemory('2026-09-24', {
  time: 't3', agent: 'warden', task: 'test',
  claims: [], patterns: [{ text: 'Serialize-then-write under concurrency', domains: ['ops'] }],
  correspondences: [], contradictions: [],
});
index = m.loadPatternsIndex();
m.promoteSession('2026-09-24', index);
const p = m.loadPatternsIndex().patterns['serialize-then-write-under-concurrency'];
ok(p.evidenceCount === 2 && p.sessions.length === 2, 'evidence accumulates across sessions');
ok(p.domains.includes('ops') && p.domains.includes('code'), 'domains merge across sessions');
ok(p.status === 'candidate', '2 sessions + 2 domains → candidate (needs 3 sessions for established)');

// third session → established
m.appendWorkingMemory('2026-09-25', {
  time: 't4', agent: 'chief', task: 'test',
  claims: [], patterns: [{ text: 'Serialize-then-write under concurrency', domains: ['code'] }],
  correspondences: [], contradictions: [],
});
index = m.loadPatternsIndex();
m.promoteSession('2026-09-25', index);
const p2 = m.loadPatternsIndex().patterns['serialize-then-write-under-concurrency'];
ok(p2.status === 'established', '3 sessions + 2 domains → established');

// ── query ──
console.log('queryPatterns:');
const results = m.queryPatterns('serialize write concurrency', m.loadPatternsIndex());
ok(results.length >= 1 && results[0].id === 'serialize-then-write-under-concurrency', 'query matches by terms');
ok(results[0].evidenceCount === 3 && results[0].status === 'established', 'query returns evidence + status');
ok(m.queryPatterns('zzz-nothing', m.loadPatternsIndex()).length === 0, 'no-match query returns empty');

// ── negator coverage (negative-valence words, not just syntactic "not") ──
console.log('negator coverage:');
const negDate = '2026-09-26';
m.appendWorkingMemory(negDate, {
  time: 'n1', agent: 'sparks', task: 'test',
  claims: [{ text: 'The retry approach is useful for flaky network calls', domains: ['code'] }],
  patterns: [], correspondences: [], contradictions: [],
});
const negFlags = m.appendWorkingMemory(negDate, {
  time: 'n2', agent: 'sentry', task: 'test',
  claims: [{ text: 'The retry approach is useless for flaky network calls', domains: ['code'] }],
  patterns: [], correspondences: [], contradictions: [],
});
ok(negFlags.length === 1, 'negative-valence word ("useless") reads as a polarity flip');
ok(m.checkIntraSessionContradictions({ entries: [] }, [{ text: 'this is flawed and inadequate' }]).length === 0, 'single claim never self-contradicts');

// ── pattern-id fragmentation guard ──
console.log('pattern id fragmentation:');
const fragDate = '2026-09-27';
m.appendWorkingMemory(fragDate, {
  time: 'f1', agent: 'sparks', task: 'test',
  claims: [], patterns: [{ text: 'Use atomic tmp+rename writes for state files', domains: ['code'] }],
  correspondences: [], contradictions: [],
});
index = m.loadPatternsIndex();
m.promoteSession(fragDate, index);
// same pattern, trailing words added by a differently-worded agent
m.appendWorkingMemory(fragDate, {
  time: 'f2', agent: 'warden', task: 'test',
  claims: [], patterns: [{ text: 'Use atomic tmp+rename writes for state files safely', domains: ['ops'] }],
  correspondences: [], contradictions: [],
});
index = m.loadPatternsIndex();
m.promoteSession(fragDate, index);
const fragHits = Object.values(m.loadPatternsIndex().patterns).filter(p => /atomic tmp\+rename/i.test(p.name));
ok(fragHits.length === 1, 'near-duplicate pattern name merged into a single index entry');
ok(fragHits[0].domains.includes('ops') && fragHits[0].domains.includes('code'), 'merged entry keeps domains from both phrasings');
ok(Array.isArray(fragHits[0].nameVariations) && fragHits[0].nameVariations.length === 1, 'alternate name recorded in nameVariations');
ok(m.findNearDuplicatePatternId('Use atomic tmp+rename writes for state files safely', { patterns: { 'x': { name: 'Use atomic tmp+rename writes for state files' } } }) === 'x', 'near-duplicate lookup finds existing entry');
ok(m.findNearDuplicatePatternId('Totally unrelated billing reconciliation approach', { patterns: { 'x': { name: 'Use atomic tmp+rename writes for state files' } } }) === null, 'unrelated name is not merged');
// real-world case from the live index: same pattern, a word inserted mid-name
ok(m.findNearDuplicatePatternId('copy-on-write-atomic-rename', { patterns: { 'copy-on-write-with-atomic-rename': { name: 'copy-on-write-with-atomic-rename' } } }) === 'copy-on-write-with-atomic-rename', 'mid-name insertion still merges (copy-on-write vs copy-on-write-with-atomic)');
// guard: a different leading word is a genuinely different pattern, must NOT merge
ok(m.findNearDuplicatePatternId('parallel-then-write under concurrency', { patterns: { 'serialize-then-write-under-concurrency': { name: 'Serialize-then-write under concurrency' } } }) === null, 'different leading word is NOT merged');
ok(m.findNearDuplicatePatternId('mysql wal mode', { patterns: { 'sql-wal-mode': { name: 'SQL WAL mode' } } }) === null, 'short names with one differing token are NOT merged');
ok(m.findNearDuplicatePatternId('hi', { patterns: { 'greeting': { name: 'hi' } } }) === null, 'sub-threshold name returns null rather than false match');

// ── demotion path ──
console.log('demotion:');
const demDate = '2026-09-28';
// claims only — the established pattern is NOT re-invoked in this session
m.appendWorkingMemory(demDate, {
  time: 'd1', agent: 'chief', task: 'test',
  claims: [{ text: 'Serialize-then-write under concurrency is required for the state store', domains: ['code'] }],
  patterns: [], correspondences: [], contradictions: [],
});
m.appendWorkingMemory(demDate, {
  time: 'd2', agent: 'sentry', task: 'test',
  claims: [{ text: 'Serialize-then-write under concurrency is not required for the state store', domains: ['code'] }],
  patterns: [], correspondences: [], contradictions: [],
});
ok(m.loadWorkingMemory(demDate).contradictions.length === 1, 'cross-claim contradiction recorded in the demoting session');
index = m.loadPatternsIndex();
m.promoteSession(demDate, index);
const dem = m.loadPatternsIndex().patterns['serialize-then-write-under-concurrency'];
ok(dem.status === 'candidate', 'established pattern demoted by a later contradiction in a different session');
ok(typeof dem.demotedAt === 'string' && dem.demotedAt.length > 0, 'demotion timestamped');
ok(dem.demotedFrom === 'established', 'previous status recorded for audit');

// ── contradiction detection observability ──
console.log('contradiction stats:');
const cs = m.loadPatternsIndex().meta.contradictionStats;
ok(cs && typeof cs.flagsRaised === 'number' && cs.flagsRaised > 0, 'flagsRaised recorded in index meta');
ok(typeof cs.claimsChecked === 'number' && cs.claimsChecked > 0, 'claimsChecked recorded in index meta');
ok(m.demotePattern(m.loadPatternsIndex(), 'serialize-then-write-under-concurrency', 'manual test') === false, 'demotePattern is a no-op on an already-candidate pattern');
// note: operate on ONE loaded object — loadPatternsIndex() re-reads from disk each call
const idxForTest = m.loadPatternsIndex();
const demotionsBefore = idxForTest.meta.demotions || 0;
idxForTest.patterns['use-atomic-tmp-rename-writes-for-state-files'].status = 'established';
ok(m.demotePattern(idxForTest, 'use-atomic-tmp-rename-writes-for-state-files', 'manual test') === true, 'demotePattern callable directly on an established pattern');
ok(idxForTest.patterns['use-atomic-tmp-rename-writes-for-state-files'].status === 'candidate', 'demotePattern sets candidate');
ok(idxForTest.patterns['use-atomic-tmp-rename-writes-for-state-files'].demotedFrom === 'established', 'demotePattern records prior status');
ok(idxForTest.meta.demotions === demotionsBefore + 1, 'demotion counted in index meta');

// ── consolidation of pre-existing fragmented entries ──
console.log('consolidation:');
const consIdx = m.loadPatternsIndex();
consIdx.patterns['copy-on-write-with-atomic-rename'] = { name: 'copy-on-write-with-atomic-rename', domains: ['code'], sessions: ['2026-09-23'], evidenceCount: 1, status: 'candidate', firstSeen: 'x', lastSeen: 'x', correspondences: [], contradictions: [], nameVariations: [] };
consIdx.patterns['copy-on-write-atomic-rename'] = { name: 'copy-on-write-atomic-rename', domains: ['ops'], sessions: ['2026-09-24'], evidenceCount: 1, status: 'candidate', firstSeen: 'y', lastSeen: 'y', correspondences: ['note-a'], contradictions: [], nameVariations: [] };
consIdx.patterns['fail-fast-with-bounded-retries'] = { name: 'fail-fast-with-bounded-retries', domains: ['code'], sessions: ['2026-09-23'], evidenceCount: 2, status: 'candidate', firstSeen: 'z', lastSeen: 'z', correspondences: [], contradictions: [], nameVariations: [] };
const mergedPairs = m.consolidateNearDuplicates(consIdx);
ok(mergedPairs.length === 1, 'one fragmented pair consolidated');
ok(mergedPairs[0].absorbed === 'copy-on-write-atomic-rename' && mergedPairs[0].kept === 'copy-on-write-with-atomic-rename', 'merge reports kept + absorbed ids');
ok(consIdx.patterns['copy-on-write-atomic-rename'] === undefined, 'absorbed entry removed from active patterns');
const healed = consIdx.patterns['copy-on-write-with-atomic-rename'];
ok(healed.sessions.length === 2 && healed.evidenceCount === 2, 'sessions and evidence combined (no evidence lost)');
ok(healed.domains.includes('code') && healed.domains.includes('ops'), 'domains unioned');
ok(healed.correspondences.includes('note-a'), 'correspondences carried over');
ok(healed.nameVariations.includes('copy-on-write-atomic-rename'), 'absorbed name kept in nameVariations');
ok(consIdx.meta.absorbedPatterns.length === 1 && consIdx.meta.absorbedPatterns[0].absorbed === 'copy-on-write-atomic-rename', 'absorption recorded in meta for audit/reversal');
ok(m.consolidateNearDuplicates(consIdx).length === 0, 'consolidation is idempotent (second pass finds nothing)');
ok(consIdx.patterns['fail-fast-with-bounded-retries'] !== undefined, 'unrelated pattern untouched');

// ── index persistence + atomic save ──
console.log('persistence:');
ok(existsSync(join(tmp, 'patterns-index.json')), 'index file written to disk');
// Read the file back through the module's own loader rather than JSON.parse'ing
// the raw bytes. This asserts what a real consumer would actually observe —
// the index as it survives a round-trip through disk — instead of asserting the
// file's ENCODING.
//
// The raw-JSON form of this line broke the moment encryption was introduced: it
// hardcoded the assumption that the on-disk file is plaintext JSON, so running
// the suite with OMEGA_MEMORY_PASSPHRASE set in the ambient environment made
// JSON.parse throw on a `POLYMEM-ENC-V1` header. That is a latent
// environment-dependence bug, not a new assertion: an operator who exported a
// passphrase in their shell would see this suite fail with a SyntaxError that
// names neither the cause nor the fix. The encryption suite covers the sealed
// case directly; this suite is about persistence, so it should be reading
// through the public loader either way.
const onDisk = m.loadPatternsIndex();
ok(onDisk.patterns['serialize-then-write-under-concurrency'].sessions.length === 3, 'index on disk matches in-memory state');

rmSync(tmp, { recursive: true, force: true });
done();
