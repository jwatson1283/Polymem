// test/test-trust-integrity.mjs
//
// SIX TRUST-MODEL DEFECTS, ONE SUITE. Each was found by an architecture review
// with a reproduction, then RE-MEASURED against this tree before being believed
// (sim/probe-arch-findings.mjs, kept in-repo so the numbers can be rechecked).
// All six reproduced here; the three the first draft of that probe "confirmed"
// that were module-load artifacts did not, and the suite asserts only what the
// real module does.
//
// THE UNIFIED THREAD. Every finding in this file is the same defect wearing
// different clothes: a caller is told a pattern is more trustworthy than the
// evidence supports. B1 fabricates corroboration. W1 hides the absence of it.
// B3 tells a caller a write landed when it did not. B5 cannot express the trust
// level that exists. B2 and B4 are the writer-side twins — a merge that undoes
// a deliberate deletion, and a writer that blocks a live process on a dead
// one's leftover claim. Polymem exists to make an agent's memory honest about
// what it knows. A silent overstatement is worse than no memory, because the
// agent stops looking.
//
// WHAT THIS SUITE REFUSES TO DO.
//
//   * No positive scorer. The calibration corpus contains no real
//     contradictions, so any "this looks like knowledge" threshold would be
//     fitted to noise. The gate stays NEGATIVE-only: it may reject, never
//     promote on its own judgement. See W1 — inference supplies a MISSING
//     domain, it never grants the 2-domain bar by itself.
//   * No weakening of the 3-session / 2-domain bar. W1 makes the bar
//     REACHABLE, not easier: a pattern with no inferable domain is still held
//     back, and now says so in meta.
//   * No test that passes vacuously. Every scenario that asserts absence is
//     paired with a control that proves the mechanism under test can produce
//     the thing it claims not to produce.
//
// CHILD PROCESSES ARE LOAD-BEARING. polymem.mjs resolves INDEX_FILE and
// SESSIONS_DIR at MODULE LOAD, so setting process.env after the import changes
// nothing. Every scenario here that needs its own index runs via execFileSync
// with the env already in place. A probe that got this wrong "measured" three
// findings that did not exist; the mistake is documented in each child below
// because it is the single easiest way to fake a result in this codebase.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSuite } from './harness.mjs';

const { section, ok, done } = createSuite('test-trust-integrity.mjs');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = join(REPO, 'src', 'polymem.mjs');

// Run a snippet in a fresh process with a private HOME and index path, and
// return whatever it printed after the @@ marker. A child that throws comes
// back as { error } so a crash is an assertion failure, never a silent skip.
function child(body, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'polymem-trust-'));
  mkdirSync(join(home, 'memory'), { recursive: true });
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const script = `
    const m = await import(${JSON.stringify(MODULE)});
    const out = (o) => process.stdout.write('@@' + JSON.stringify(o) + '\\n');
    ${body}
  `;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: home,
        OMEGA_MEMORY_INDEX: join(home, 'memory', 'patterns-index.json'),
        OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions'),
        ...extraEnv,
      },
    });
  } catch (e) {
    stdout = e.stdout || '';
    stderr = e.stderr || String(e.message);
  }
  const home2 = home;
  const lines = stdout.split('\n').filter((l) => l.startsWith('@@'));
  const result = lines.map((l) => JSON.parse(l.slice(2)));
  rmSync(home2, { recursive: true, force: true });
  return { rows: result, stderr, home };
}

// The two genuinely different facts from the review. They share their first 60
// slug characters and differ ONLY after the truncation point, which is why
// they collided. Written out rather than generated so a future edit to this
// file cannot quietly make them stop colliding.
const PREFIX = 'Atomic rename publishes a whole file or nothing, so a crash mid-write never leaves a torn index behind on disk even when';
const ALPHA = `${PREFIX} two writers race to publish the same state file simultaneously`;
const BETA = `${PREFIX} the decomposer crashes between reading and committing a pattern ledger`;

// ═══════════════════════════════════════════════ B1 — identity truncation ══

section('B1 — patternId truncation must not manufacture corroboration');

// ── the defect ─────────────────────────────────────────────────────────────
// `slice(0, 60)` threw away the tail of the identity, so two DIFFERENT
// patterns sharing a 60-character prefix became one index key. Three sessions
// — one of ALPHA and two of BETA — then accumulated onto a single entry and
// crossed the 3-session bar. The pattern reached `established` on the
// strength of a fact it was never stated in. Fabricated evidence.
{
  const { rows, stderr } = child(`
    const PREFIX = ${JSON.stringify(PREFIX)};
    const ALPHA = PREFIX + ' two writers race to publish the same state file simultaneously';
    const BETA  = PREFIX + ' the decomposer crashes between reading and committing a pattern ledger';
    const idA = m.patternId(ALPHA), idB = m.patternId(BETA);
    // ALPHA observed once. BETA observed twice. Two unrelated facts.
    for (const [date, name, doms] of [
      ['2026-04-01', ALPHA, ['code']],
      ['2026-04-02', BETA,  ['code', 'ops']],
      ['2026-04-03', BETA,  ['code', 'ops']],
    ]) {
      m.appendWorkingMemory(date, { time: date, agent: 'probe', task: 't', claims: [],
        patterns: [{ text: name, domains: doms }], correspondences: [], contradictions: [] });
      m.promoteSession(date, m.loadPatternsIndex());
    }
    const idx = m.loadPatternsIndex();
    const ids = Object.keys(idx.patterns);
    out({ idA, idB, collide: idA === idB, ids,
          statuses: ids.map(i => idx.patterns[i].status),
          evidence: ids.map(i => idx.patterns[i].evidenceCount),
          names: ids.map(i => idx.patterns[i].name) });
  `);

  const [r] = rows;
  ok(!stderr.trim() || rows.length > 0, 'B1 scenario runs to completion', stderr.split('\n')[0]);
  if (r) {
    ok(r.idA !== r.idB,
      'B1: two names sharing a 60-char prefix produce DIFFERENT ids',
      `both were "${r.idA}"`);

    // The load-bearing assertion. Two patterns must survive as two entries, and
    // neither may be established: ALPHA was seen once, BETA twice.
    ok(r.ids.length === 2,
      'B1: the two different patterns survive as two separate index entries',
      `got ${r.ids.length}: ${JSON.stringify(r.ids)}`);

    ok(!r.statuses.includes('established'),
      'B1: NEITHER pattern reaches established — 1 observation and 2 observations cannot corroborate',
      `statuses=${JSON.stringify(r.statuses)} evidence=${JSON.stringify(r.evidence)}`);

    ok(r.evidence.includes(1) && r.evidence.includes(2),
      'B1: each entry carries only the evidence actually observed for it',
      `evidence=${JSON.stringify(r.evidence)}`);

    // The audit trail. Pre-fix the surviving entry had nameVariations: [] — it
    // did not even record that two different facts had been merged.
    const drifted = r.names.length === 2 && new Set(r.names).size === 2;
    ok(drifted,
      'B1: the two entries keep their own names, so the drift is visible in the index',
      `names=${JSON.stringify(r.names)}`);
  }
}

// CONTROL: the mechanism is not simply refusing to build ids at all. Short,
// distinct names must still produce exactly the ids they always did, or every
// existing stored index would break — which is the compatibility obligation.
{
  const { rows } = child(`
    out({
      short: m.patternId('Serialize-then-write under concurrency'),
      constructorName: m.patternId('constructor'),
      toStringName: m.patternId('toString'),
      empty: m.patternId('!!!'),
      emptyHashIsStable: m.patternId('!!!') === m.patternId('!!!'),
      longUnchangedUnder60: m.patternId('a'.repeat(60)).length,
      longOver60: m.patternId('b'.repeat(61)).length,
    });
  `);
  const [r] = rows;
  ok(r.short === 'serialize-then-write-under-concurrency',
    'B1 CONTROL: a short, ordinary name still produces its original id verbatim',
    `got "${r.short}"`);
  ok(r.constructorName === 'constructor' && r.toStringName === 'tostring',
    'B1 CONTROL: prototype-shaped names are still ordinary ids (prototype safety preserved)',
    `got "${r.constructorName}" / "${r.toStringName}"`);
  ok(r.longUnchangedUnder60 === 60,
    'B1 CONTROL: a name that fits in 60 chars is not lengthened — existing ids do not change',
    `got ${r.longUnchangedUnder60}`);
  ok(r.longOver60 <= 80,
    'B1 CONTROL: a truncated id stays bounded — the hash suffix does not make ids unbounded',
    `got ${r.longOver60}`);
}

// The compatibility obligation, stated as an assertion rather than a promise:
// an index written by the PRE-fix code must still load, and its patterns must
// still be readable. Hand-built here with the old truncated key on purpose.
{
  const { rows, stderr } = child(`
    const home = process.env.HOME;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const idxPath = path.join(home, 'memory', 'patterns-index.json');
    // Exactly what the old patternId() wrote for ALPHA: first 60 slug chars.
    const legacyId = ${JSON.stringify(PREFIX)}.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const legacy = {
      version: 1,
      patterns: { [legacyId]: {
        name: ${JSON.stringify(ALPHA)}, domains: ['code'], sessions: ['2026-04-01'],
        evidenceCount: 1, status: 'candidate', firstSeen: '2026-04-01T00:00:00.000Z',
        lastSeen: '2026-04-01T00:00:00.000Z', correspondences: [], contradictions: [],
        nameVariations: [], implicatedBy: [], sources: [] } },
      meta: { promotions: 1, decompositionStats: {} },
    };
    fs.mkdirSync(path.dirname(idxPath), { recursive: true });
    fs.writeFileSync(idxPath, JSON.stringify(legacy));
    const idx = m.loadPatternsIndex();
    const ids = Object.keys(idx.patterns);
    const entry = idx.patterns[ids[0]];
    // Re-promoting the same session must find the SAME entry, not create a second.
    m.appendWorkingMemory('2026-04-01', { time: 't', agent: 'probe', task: 't', claims: [],
      patterns: [{ text: ${JSON.stringify(ALPHA)}, domains: ['code'] }],
      correspondences: [], contradictions: [] });
    m.promoteSession('2026-04-01', m.loadPatternsIndex());
    const after = m.loadPatternsIndex();
    out({ legacyId, loadedIds: ids, entryName: entry.name, entryEvidence: entry.evidenceCount,
          afterIds: Object.keys(after.patterns) });
  `);
  const [r] = rows;
  ok(!stderr.trim() || rows.length > 0, 'B1 compatibility scenario runs', stderr.split('\n')[0]);
  if (r) {
    ok(r.loadedIds.length === 1 && r.entryName === ALPHA,
      'B1 COMPAT: an index written with the old truncated key still loads, with its pattern intact',
      `ids=${JSON.stringify(r.loadedIds)}`);
    ok(r.afterIds.length === 1,
      'B1 COMPAT: re-promoting the same pattern does NOT fork a second entry — the legacy key is still findable',
      `got ${JSON.stringify(r.afterIds)} — a migration that orphans entries would double-count evidence`);
    ok(r.afterIds[0] === r.loadedIds[0],
      'B1 COMPAT: the legacy key is preserved rather than silently rewritten under the operator',
      `${r.loadedIds[0]} -> ${r.afterIds[0]}`);
  }
}

// ═════════════════════════════════ W1 — the invisible half of the bar ═════

section("W1 — a missing '— domains:' suffix must not be silent");

// The bar is 3 sessions AND 2 domains. The domain half is only reachable if
// the model writes a prose suffix in its memory fence — which it may not, and
// when it does not, nothing anywhere said why. meta.promotions climbed, the
// gate reported everything accepted, and the product's central promise was
// simply absent with no trace.
//
// A HONEST LIMIT, MEASURED AGAINST THE SHIPPED FIXTURE, NOT ASSUMED. Inference
// fills what the TEXT supports and nothing more. Of the fixture's 47
// domain-declaring lines, 30 name no domain vocabulary at all and 17 name
// exactly one — and the fixture's own cross-domain line, "Serialize
// read-modify-write under a single write claim — domains: code, ops", still
// supports only `code` from its text, because "ops" is nowhere in it. So
// inference alone does NOT rescue the shipped corpus, and this suite does not
// pretend otherwise. What it delivers is the second half of the requirement:
// the shortfall is now COUNTED, so "why is my index all candidates" has an
// answer. A future corpus change that DOES carry two-domain text is then
// promoted automatically, with no code change.
{
  const { rows, stderr } = child(`
    const NAME = 'Serialize read-modify-write under a single write claim before committing state';
    for (let d = 1; d <= 4; d++) {
      const date = '2026-05-0' + d;
      m.appendWorkingMemory(date, { time: date, agent: 'probe', task: 't', claims: [],
        patterns: [{ text: NAME, domains: [] }],          // no prose suffix at all
        correspondences: [], contradictions: [] });
      m.promoteSession(date, m.loadPatternsIndex());
    }
    const idx = m.loadPatternsIndex();
    const id = Object.keys(idx.patterns)[0];
    const p = idx.patterns[id];
    out({ sessions: p.sessions.length, domains: p.domains, status: p.status,
          promotions: idx.meta.promotions,
          patternGate: idx.meta.patternGate,
          trustGate: idx.meta.trustGate || null,
          metaKeys: Object.keys(idx.meta) });
  `);
  const [r] = rows;
  ok(!stderr.trim() || rows.length > 0, 'W1 scenario runs', stderr.split('\n')[0]);
  if (r) {
    ok(r.sessions === 4,
      'W1: all four sessions were recorded — the pattern IS accumulating evidence',
      `sessions=${r.sessions}`);
    ok(r.domains.length >= 1,
      'W1 FIX: the domain half is INFERRED from the pattern text when the model omits the suffix',
      `domains=${JSON.stringify(r.domains)}`);
    ok(r.domains.includes('code'),
      'W1 FIX: the inferred domain is the one the text actually supports ("code"), not a guess',
      `domains=${JSON.stringify(r.domains)}`);

    // THE VISIBILITY REQUIREMENT. The reason the review called this a bug is
    // the silence, not the count. meta must be able to answer "how many
    // patterns were held back and for what reason".
    const hasHeldBack = r.metaKeys.some((k) => /domain|held|gate|trust/i.test(k));
    ok(hasHeldBack,
      'W1 FIX: meta records WHY a pattern was held back — the failure is visible, not silent',
      `meta keys=${JSON.stringify(r.metaKeys)}`);

    ok(!!r.trustGate && r.trustGate.domainsShort >= 1,
      'W1 FIX: meta counts the patterns held back short on domains',
      `trustGate=${JSON.stringify(r.trustGate)}`);

    ok(!!r.trustGate && Object.keys(r.trustGate.heldBack || {}).length > 0,
      'W1 FIX: the held-back reason is named, not just counted',
      `heldBack=${JSON.stringify(r.trustGate && r.trustGate.heldBack)}`);

    // And the number must be honest about this pattern: it passed the session
    // bar, so its reason must mention domains and NOT sessions. A bag that
    // blamed sessions here would point an operator at the wrong problem.
    const reason = Object.keys(r.trustGate.heldBack)[0] || '';
    ok(reason.includes('insufficientDomains') && !reason.includes('insufficientSessions'),
      'W1 FIX: the reported reason is the TRUE one — 4 sessions were met, only domains were short',
      `reason="${reason}" sessions=${r.sessions}`);
  }
}

// W1 must not become a back door around the 2-domain bar. A pattern whose text
// names NO domain vocabulary stays held back, and says so. This is the
// direction that matters: a fix that only ever promotes is a new bug.
{
  const { rows, stderr } = child(`
    // No domain vocabulary anywhere in this text: not code, ops, ui, money,
    // research, comms, or any synonym. It is about widgets, which is not a
    // domain in this vocabulary and must not be invented into one.
    const NAME = 'Widgets render in batches before the frame is composited';
    for (let d = 1; d <= 4; d++) {
      const date = '2026-06-0' + d;
      m.appendWorkingMemory(date, { time: date, agent: 'probe', task: 't', claims: [],
        patterns: [{ text: NAME, domains: [] }], correspondences: [], contradictions: [] });
      m.promoteSession(date, m.loadPatternsIndex());
    }
    const idx = m.loadPatternsIndex();
    const id = Object.keys(idx.patterns)[0];
    const p = idx.patterns[id];
    out({ sessions: p.sessions.length, domains: p.domains, status: p.status,
          trustGate: idx.meta.trustGate || null });
  `);
  const [r] = rows;
  ok(!stderr.trim() || rows.length > 0, 'W1 held-back scenario runs', stderr.split('\n')[0]);
  if (r) {
    ok(r.sessions === 4,
      'W1 CONTROL: the held-back pattern still recorded its sessions — inference did not reject it',
      `sessions=${r.sessions}`);
    ok(r.domains.length < 2,
      'W1 CONTROL: no domain is INVENTED for text with no domain vocabulary',
      `domains=${JSON.stringify(r.domains)}`);
    ok(r.status === 'candidate',
      'W1 CONTROL: a pattern with no inferable domain is still held at candidate — the bar stands',
      `status=${r.status}`);
    ok(r.trustGate && r.trustGate.established === 0,
      'W1 CONTROL: nothing was established that should not have been',
      `trustGate=${JSON.stringify(r.trustGate)}`);
  }
}

// And where the text genuinely spans two domains, inference DOES unlock the
// bar — measured, not asserted. This is the forward path the corpus fix needs:
// a better corpus should promote with no code change.
{
  const { rows, stderr } = child(`
    const NAME = 'Every write to the shared index takes a claim before it commits to disk';
    for (let d = 1; d <= 4; d++) {
      const date = '2026-07-0' + d;
      m.appendWorkingMemory(date, { time: date, agent: 'probe', task: 't', claims: [],
        patterns: [{ text: NAME, domains: [] }], correspondences: [], contradictions: [] });
      m.promoteSession(date, m.loadPatternsIndex());
    }
    const idx = m.loadPatternsIndex();
    const id = Object.keys(idx.patterns)[0];
    const p = idx.patterns[id];
    out({ sessions: p.sessions.length, domains: p.domains, status: p.status,
          trustGate: idx.meta.trustGate || null });
  `);
  const [r] = rows;
  ok(!stderr.trim() || rows.length > 0, 'W1 established-path scenario runs', stderr.split('\n')[0]);
  if (r) {
    ok(r.domains.includes('code') && r.domains.includes('ops'),
      'W1: text spanning code and ops infers BOTH domains from its own words',
      `domains=${JSON.stringify(r.domains)}`);
    ok(r.status === 'established',
      'W1: that pattern reaches established with no prose suffix — inference is real, not cosmetic',
      `status=${r.status}`);
    ok(r.trustGate && r.trustGate.established >= 1,
      'W1: meta.trustGate reports it as established, so the two agree',
      `trustGate=${JSON.stringify(r.trustGate)}`);
  }
}

// ═════════════════════════════════════════════════ B2 — merge resurrection ══

section('MIGRATION — a pre-fix index must keep working, not be orphaned');

// This is the compatibility half of B1, and it is the half that is easy to
// skip. Making ids collision-safe by hashing the slug changes the id of every
// overlong pattern — so the obvious "fix" silently orphans every established
// pattern a user has, dropping a trusted index back to empty. That would be a
// worse bug than the collision it set out to remove.
//
// The requirement is that an existing on-disk index keeps its keys, keeps its
// accumulated evidence, and gains new evidence in place. No rewrite, no
// re-keying, no second entry for the same logical pattern.
{
  const { rows, stderr } = child(`
    import fs from 'node:fs';
    const NAME = 'Atomic rename publishes a whole file or nothing so a crash mid-write never ' +
      'leaves a torn index behind on disk even when two writers race to publish the same state file simultaneously';
    // Exactly the pre-fix id: lowercase, slugified, sliced to 60.
    const LEGACY = NAME.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+\$/g,'').slice(0,60);
    // A LEGACY-SHAPED entry: field-incomplete, as a pre-fix writer could leave
    // it. Loading it and then promoting against it is what crashed before.
    fs.writeFileSync(process.env.OMEGA_MEMORY_INDEX, JSON.stringify({ version: 1, patterns: {
      [LEGACY]: { name: NAME, domains: ['code'], sessions: ['2026-01-01','2026-01-02'],
                  evidenceCount: 2, status: 'candidate', firstSeen: '2026-01-01' },
    }, meta: {} }));

    const loaded = m.loadPatternsIndex();
    out({ legacyId: LEGACY, loadedKeys: Object.keys(loaded.patterns),
          newId: m.patternId(NAME), legacyScheme: m.legacyPatternId(NAME),
          resolvesViaCompatibility: !!m.findStoredPatternEntry(NAME, loaded) });

    for (const date of ['2026-01-01','2026-01-02']) {
      m.appendWorkingMemory(date, { time: date, agent: 'probe', task: 't', claims: [],
        patterns: [{ text: NAME, domains: ['code'] }], correspondences: [], contradictions: [] });
      m.promoteSession(date, m.loadPatternsIndex());
    }
    const after = m.loadPatternsIndex();
    const k = Object.keys(after.patterns);
    out({ afterKeys: k, count: k.length, sessions: k.length ? after.patterns[k[0]].sessions.length : 0 });
  `);
  const [loaded, after] = rows;
  ok(!stderr.trim() || rows.length > 0, 'MIGRATION: a pre-fix index loads without error', stderr.split('\n')[0]);

  if (loaded) {
    ok(loaded.legacyId !== loaded.newId,
      'MIGRATION: the new collision-safe id for this name IS different from the old truncated one',
      `legacy=${loaded.legacyId} new=${loaded.newId}`);
    ok(loaded.legacyScheme === loaded.legacyId,
      'MIGRATION: the legacy scheme is still computable, so the compatibility path is not guesswork',
      `legacyPatternId=${loaded.legacyScheme} onDisk=${loaded.legacyId}`);
    ok(loaded.loadedKeys.length === 1 && loaded.loadedKeys[0] === loaded.legacyId,
      'MIGRATION: the pre-fix key survives load UNCHANGED — a stored index is not re-keyed',
      `keys=${JSON.stringify(loaded.loadedKeys)}`);
    ok(loaded.resolvesViaCompatibility,
      'MIGRATION: a legacy entry is found by NAME, so new evidence lands on the existing pattern');
  }

  if (after) {
    ok(after.count === 1,
      'MIGRATION: promoting a known legacy pattern does NOT mint a second entry beside it',
      `keys=${JSON.stringify(after.afterKeys)} count=${after.count}`);
    ok(after.afterKeys[0] === loaded.legacyId,
      'MIGRATION: new evidence accumulated on the ORIGINAL legacy key, in place',
      `expected ${loaded.legacyId} got ${after.afterKeys[0]}`);
    ok(after.sessions === 2,
      'MIGRATION: the legacy entry kept and extended its session evidence',
      `sessions=${after.sessions}`);
  }
}

// A legacy entry missing fields must not throw when an operator demotes or
// restores it. This crashed before these fixes, and the crash was in the
// operator-repair pathway itself, which is the worst place for one.
{
  const { rows, stderr } = child(`
    import fs from 'node:fs';
    // demotePattern only acts on a non-candidate (returning false for
    // 'candidate' is correct, not a bug), so this entry is authored
    // established; restorePattern needs a non-established one. Both are
    // field-INCOMPLETE in the ways a pre-fix writer could leave them.
    fs.writeFileSync(process.env.OMEGA_MEMORY_INDEX, JSON.stringify({ version: 1, patterns: {
      'partial-entry': { name: 'Some pattern', domains: ['code'], sessions: ['2026-01-01','2026-01-02','2026-01-03'],
                         evidenceCount: 3, status: 'established' },
      'another-partial': { name: 'Another pattern', domains: ['ops'], sessions: ['2026-01-01','2026-01-02','2026-01-03'],
                           evidenceCount: 3, status: 'candidate' },
    }, meta: {} }));
    const idx = m.loadPatternsIndex();
    out({ demoted: m.demotePattern(idx, 'partial-entry', 'operator test'),
          restored: m.restorePattern(idx, 'another-partial', 'operator test'),
          contradictionsNowArray: Array.isArray(idx.patterns['partial-entry'].contradictions) });
  `);
  const [r] = rows;
  ok(!stderr.trim(), 'MIGRATION: demoting/restoring a field-incomplete legacy entry does not throw',
    stderr.split('\n').slice(0, 2).join(' | '));
  if (r) {
    ok(r.demoted === true, 'MIGRATION: the demote actually applied (not silently skipped)',
      `demoted=${r.demoted}`);
    ok(r.restored === true, 'MIGRATION: the restore actually applied (not silently skipped)',
      `restored=${r.restored}`);
    ok(r.contradictionsNowArray === true,
      'MIGRATION: the missing field is filled in, so the note is recorded rather than dropped',
      `isArray=${r.contradictionsNowArray}`);
  }
}

section('B2 — a merge must not resurrect a deliberately absorbed pattern');

// A tombstone in meta.absorbedPatterns is the ONLY evidence of a deliberate
// delete — the module says so itself. The merge honoured tombstones for
// patterns present on DISK, then unconditionally re-added anything the caller
// held that disk did not have. A stale caller's snapshot therefore brought
// back a pattern that had been absorbed, and the index then held a pattern
// that was simultaneously recorded as absorbed AND live.
{
  const { rows, stderr } = child(`
    const A = 'Serialize the write queue before committing ops state';
    const B = 'Absorb every pattern into one entry when consolidating evidence';
    const idA = m.patternId(A), idB = m.patternId(B);
    // Writer 1 has both patterns, then deliberately absorbs B.
    const mine = { version: 1, patterns: {
      [idA]: mk(idA, A), [idB]: mk(idB, B) },
      meta: { promotions: 1, absorbedPatterns: [{ absorbed: idB, into: idA, at: '2026-08-01T00:00:00.000Z', reason: 'near-duplicate' }] } };
    // Writer 2 still holds a STALE snapshot: both patterns, NO tombstone.
    const theirs = { version: 1, patterns: {
      [idA]: mk(idA, A), [idB]: mk(idB, B) },
      meta: { promotions: 1, absorbedPatterns: [] } };
    function mk(id, name) {
      return { name, domains: ['code'], sessions: ['2026-08-01'], evidenceCount: 1,
        status: 'candidate', firstSeen: '2026-08-01T00:00:00.000Z',
        lastSeen: '2026-08-01T00:00:00.000Z', correspondences: [], contradictions: [],
        nameVariations: [], implicatedBy: [], sources: [] };
    }
    const merged = m.mergeConcurrentIndex(mine, theirs);
    const ids = Object.keys(merged.patterns);
    const tombs = (merged.meta.absorbedPatterns || []).map(t => t.absorbed);
    out({ idA, idB, mergedIds: ids, tombs, resurrected: ids.includes(idB) && tombs.includes(idB) });
  `);
  const [r] = rows;
  ok(!stderr.trim() || rows.length > 0, 'B2 scenario runs', stderr.split('\n')[0]);
  if (r) {
    ok(!r.resurrected,
      'B2 FIX: a pattern recorded as absorbed is NOT brought back by the merge',
      `merged=${JSON.stringify(r.mergedIds)} tombstones=${JSON.stringify(r.tombs)}`);

    // The contradiction the review named: absorbed AND live at the same time.
    const simultaneously = r.mergedIds.some((id) => r.tombs.includes(id));
    ok(!simultaneously,
      'B2 FIX: no pattern is simultaneously recorded as absorbed and live — the invariant holds',
      `merged=${JSON.stringify(r.mergedIds)} tombstones=${JSON.stringify(r.tombs)}`);

    ok(r.tombs.includes(r.idB),
      'B2: the tombstone itself SURVIVES the merge — the record of the deletion is not lost',
      `tombs=${JSON.stringify(r.tombs)}`);
  }
}

// CONTROL: the merge must still bring in patterns the caller had never seen.
// Fixing resurrection by ignoring the caller's snapshot would silently discard
// real evidence, which is the opposite failure.
{
  const { rows } = child(`
    const A = 'Serialize the write queue before committing ops state';
    const C = 'Verify the store after a merge that never landed on disk';
    const idA = m.patternId(A), idC = m.patternId(C);
    function mk(name) {
      return { name, domains: ['code'], sessions: ['2026-08-01'], evidenceCount: 1,
        status: 'candidate', firstSeen: '2026-08-01T00:00:00.000Z',
        lastSeen: '2026-08-01T00:00:00.000Z', correspondences: [], contradictions: [],
        nameVariations: [], implicatedBy: [], sources: [] };
    }
    const mine = { version: 1, patterns: { [idA]: mk(A) }, meta: { promotions: 1, absorbedPatterns: [] } };
    const theirs = { version: 1, patterns: { [idC]: mk(C) }, meta: { promotions: 1, absorbedPatterns: [] } };
    const merged = m.mergeConcurrentIndex(mine, theirs);
    out({ ids: Object.keys(merged.patterns) });
  `);
  const [r] = rows;
  ok(r.ids.length === 2,
    'B2 CONTROL: a pattern the caller had never seen is still merged in — no real evidence is discarded',
    `got ${JSON.stringify(r.ids)}`);
}

// ═══════════════════════════════════════════════ B3 — the discarded result ══

section('B3 — promoteSession must not report a save that did not happen');

// Same class as B1: a caller told "saved" when it was not. promoteSession
// called savePatternsIndex(index) and discarded its boolean, then returned a
// success-shaped object. The return value said the promotion happened; disk
// said otherwise.
{
  const { rows, stderr } = child(`
    // Make the index directory un-saveable: a FILE where a directory must be,
    // so every write beneath it fails with ENOTDIR. The save cannot silently
    // succeed, and nothing outside the throwaway HOME is touched.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const idxPath = path.join(process.env.HOME, 'memory', 'patterns-index.json');
    fs.rmSync(path.dirname(idxPath), { recursive: true, force: true });
    fs.writeFileSync(path.dirname(idxPath), 'not a directory');

    const date = '2026-08-02';
    m.appendWorkingMemory(date, { time: date, agent: 'probe', task: 't', claims: [],
      patterns: [{ text: 'Serialize the write queue before committing ops state', domains: ['code','ops'] }],
      correspondences: [], contradictions: [] });
    let thrown = null, returned = null;
    try { returned = m.promoteSession(date, m.loadPatternsIndex()); }
    catch (e) { thrown = { name: e.name, message: String(e.message).slice(0, 200) }; }
    const exists = fs.existsSync(idxPath);
    out({ thrown, returned, exists });
  `);
  const [r] = rows;
  ok(!r.exists, 'B3 setup: the index really is unwritable (control — the scenario is not vacuous)', '');
  if (r) {
    // Either it throws, or it reports the failure in its return value. Both are
    // acceptable; "returns a success shape and says nothing" is the defect.
    const reportedFailure = !!r.thrown || (r.returned && r.returned.saved === false);
    ok(reportedFailure,
      'B3 FIX: a promotion whose write failed either throws or reports saved:false',
      `returned=${JSON.stringify(r.returned)} thrown=${JSON.stringify(r.thrown)}`);
    ok(!(r.returned && r.returned.saved === true),
      'B3 FIX: it never reports saved:true when the file was not written',
      `returned=${JSON.stringify(r.returned)}`);
  }
}

// CONTROL: the ordinary path still reports success. A fix that made every
// promotion fail loudly would pass the assertion above and be useless.
{
  const { rows, stderr } = child(`
    const date = '2026-08-03';
    m.appendWorkingMemory(date, { time: date, agent: 'probe', task: 't', claims: [],
      patterns: [{ text: 'Serialize the write queue before committing ops state', domains: ['code','ops'] }],
      correspondences: [], contradictions: [] });
    const r = m.promoteSession(date, m.loadPatternsIndex());
    const idx = m.loadPatternsIndex();
    out({ returned: r, onDisk: Object.keys(idx.patterns).length });
  `);
  const [r] = rows;
  ok(!stderr.trim() || rows.length > 0, 'B3 control scenario runs', stderr.split('\n')[0]);
  if (r) {
    ok(r.onDisk === 1,
      'B3 CONTROL: a promotion to a writable index still lands on disk',
      `patterns on disk=${r.onDisk}`);
    ok(r.returned && r.returned.saved === true,
      'B3 CONTROL: a successful promotion reports saved:true — the new field means something',
      `returned=${JSON.stringify(r.returned)}`);
  }
}

// ═══════════════════════════════════════════════ B4 — the blocked writer ════

section('B4 — a crashed writer must not stall the event loop for 30s');

// The staleness RULE is correct and stays exactly as it is: never declare a
// live pid dead, never break another host's claim on age alone. What was wrong
// is the WAITING: a dead holder's claim is only breakable after 30s, and until
// then every writer sleeps on it for the full timeout, repeatedly, on a
// synchronous sleep. Measured cost of one blocked write: ~3s of a blocked event
// loop, for up to 30 seconds after a crash.
{
  const { rows, stderr } = child(`
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const idxPath = path.join(process.env.HOME, 'memory', 'patterns-index.json');
    fs.mkdirSync(path.dirname(idxPath), { recursive: true });
    fs.writeFileSync(idxPath, JSON.stringify({ version: 1, patterns: {}, meta: { promotions: 0 } }));
    // A claim left behind by a process that is PROVABLY GONE. Pick a pid that
    // cannot be running: spawn one, wait for it, keep the number.
    const { execFileSync } = await import('node:child_process');
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim());
    // 0s old — the worst case, because the 30s staleness window has not elapsed.
    fs.writeFileSync(idxPath + '.claim', JSON.stringify({ pid: deadPid, host: os.hostname(), at: Date.now() }));
    const t0 = Date.now();
    const saved = m.savePatternsIndex(m.loadPatternsIndex());
    const elapsed = Date.now() - t0;
    out({ saved, elapsed, deadPid });
  `);
  const [r] = rows;
  ok(!stderr.trim() || rows.length > 0, 'B4 scenario runs', stderr.split('\n')[0]);
  if (r) {
    // Measured on the unfixed code: 2474ms and 2817ms across runs — the full
    // attempt budget spent sleeping on a claim whose owner is provably gone.
    // A dead holder becomes breakable only at CLAIM_STALE_MS (30s), so waiting
    // cannot change the outcome; the correct behaviour is to fail fast.
    ok(r.elapsed < 500,
      'B4 FIX: a write blocked by a provably-dead holder fails fast instead of sleeping out the attempt budget',
      `took ${r.elapsed}ms with a dead pid (${r.deadPid}) holding the claim`);

    // And the outcome must be a CLEAN, ACTIONABLE refusal — not a wrong write,
    // and not a hang. The rule still refuses to break the claim early.
    ok(r.saved === false,
      'B4: the write is refused cleanly rather than proceeding over a claim it cannot verify',
      `saved=${r.saved} elapsed=${r.elapsed}ms`);
  }
}

// CONTROL: the conservatism is intact. Two things must STILL hold after the
// waiting is fixed, and a fix that broke either would be a worse bug.
{
  const { rows, stderr } = child(`
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const idxPath = path.join(process.env.HOME, 'memory', 'patterns-index.json');
    fs.mkdirSync(path.dirname(idxPath), { recursive: true });
    fs.writeFileSync(idxPath, JSON.stringify({ version: 1, patterns: {}, meta: { promotions: 0 } }));
    const out2 = {};

    // (1) A LIVE pid's claim is never broken, however old it is. This process
    //     is provably alive, so the claim must survive the whole attempt.
    fs.writeFileSync(idxPath + '.claim', JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() - 120000 }));
    const t0 = Date.now();
    out2.liveSaved = m.savePatternsIndex(m.loadPatternsIndex());
    out2.liveElapsed = Date.now() - t0;
    out2.claimStillThere = fs.existsSync(idxPath + '.claim');
    fs.rmSync(idxPath + '.claim', { force: true });

    // (2) A claim from ANOTHER host is never broken on age, because we cannot
    //     check a pid we do not share a namespace with.
    fs.writeFileSync(idxPath + '.claim', JSON.stringify({ pid: process.pid, host: 'some-other-host.example', at: Date.now() - 120000 }));
    out2.foreignSaved = m.savePatternsIndex(m.loadPatternsIndex());
    out2.foreignClaimStillThere = fs.existsSync(idxPath + '.claim');
    fs.rmSync(idxPath + '.claim', { force: true });

    out(out2);
  `);
  const [r] = rows;
  ok(!stderr.trim() || rows.length > 0, 'B4 control scenario runs', stderr.split('\n')[0]);
  if (r) {
    ok(r.liveSaved === false,
      'B4 CONTROL: a LIVE pid\'s claim is never broken, however old the claim is',
      `saved=${r.liveSaved}`);
    ok(r.claimStillThere,
      'B4 CONTROL: the live holder\'s claim file survives the attempt untouched',
      'the claim was deleted');
    ok(r.foreignSaved === false && r.foreignClaimStillThere,
      'B4 CONTROL: a claim from another host is never broken on age alone',
      `saved=${r.foreignSaved} claimStillThere=${r.foreignClaimStillThere}`);
  }
}

// ══════════════════════════════════════════════════ B5 — the silent drop ═══

section('B5 — queryPatterns must not drop terms in silence, and must express trust');

// A silent drop is the worst kind of bug in a search function: the caller
// cannot tell "your query matched nothing" from "I ignored part of your
// query". `filter(t => t.length > 2)` discarded every 1- and 2-character term
// with no return channel at all. "ui" — a domain synonym in this very file —
// returned zero hits while the write path normalized it to "design".
{
  const { rows, stderr } = child(`
    const idx = { version: 1, patterns: {
      'ui-tokens': { name: 'Design tokens are the single source for every surface', domains: ['design'],
        sessions: ['2026-08-01','2026-08-02','2026-08-03'], evidenceCount: 3, status: 'established',
        firstSeen: '', lastSeen: '', correspondences: [], contradictions: [], nameVariations: [], implicatedBy: [], sources: [] },
      'rename-guard': { name: 'Atomic rename publishes a whole file or nothing', domains: ['code'],
        sessions: ['2026-08-01'], evidenceCount: 1, status: 'candidate',
        firstSeen: '', lastSeen: '', correspondences: [], contradictions: [], nameVariations: [], implicatedBy: [], sources: [] },
    }, meta: { promotions: 1 } };

    const two = m.queryPatterns('ui', idx);
    const trust = m.queryPatterns('rename', idx, { status: 'established' });
    const noTrust = m.queryPatterns('rename', idx);
    const withOpt = m.queryPatterns('rename', idx, { status: 'candidate' });
    const dropped = m.queryPatterns('ui', idx, { explain: true });
    out({
      twoHits: two.map(h => h.id),
      trustIds: trust.map(h => h.id),
      noTrustIds: noTrust.map(h => h.id),
      withOptIds: withOpt.map(h => h.id),
      explain: dropped && dropped.explain ? dropped.explain : null,
    });
  `);
  const [r] = rows;
  ok(!stderr.trim() || rows.length > 0, 'B5 scenario runs', stderr.split('\n')[0]);
  if (r) {
    ok(r.twoHits.includes('ui-tokens'),
      'B5 FIX: a 2-character term is searched, not silently discarded',
      `query("ui") -> ${JSON.stringify(r.twoHits)}`);

    ok(r.trustIds.length === 0 && r.withOptIds.includes('rename-guard'),
      'B5 FIX: trust is expressible — a status filter actually filters',
      `established=${JSON.stringify(r.trustIds)} candidate=${JSON.stringify(r.withOptIds)}`);

    ok(r.noTrustIds.includes('rename-guard'),
      'B5: with no options the default is unchanged — unfiltered, so existing callers see what they saw',
      `got ${JSON.stringify(r.noTrustIds)}`);

    ok(r.explain && Array.isArray(r.explain.dropped),
      'B5 FIX: a dropped term is REPORTED, not silent — the caller can always ask why',
      `explain=${JSON.stringify(r.explain)}`);
  }
}

// CONTROL: the search still has to work. A "fix" that returns everything, or
// nothing, passes the assertions above and is worse than the bug.
{
  const { rows } = child(`
    const idx = { version: 1, patterns: {
      'a': { name: 'Atomic rename publishes a whole file or nothing', domains: ['code'],
        sessions: ['2026-08-01'], evidenceCount: 1, status: 'candidate', correspondences: [], contradictions: [], nameVariations: [], implicatedBy: [], sources: [] },
      'b': { name: 'Unrelated note about gardening', domains: ['other'],
        sessions: ['2026-08-01'], evidenceCount: 1, status: 'candidate', correspondences: [], contradictions: [], nameVariations: [], implicatedBy: [], sources: [] },
    }, meta: { promotions: 1 } };
    out({ hits: m.queryPatterns('rename', idx).map(h => h.id),
          none: m.queryPatterns('zzz-nothing', idx).length,
          explainNone: (m.queryPatterns('zzz-nothing', idx, { explain: true }) || {}).explain });
  `);
  const [r] = rows;
  ok(r.hits.length === 1 && r.hits[0] === 'a',
    'B5 CONTROL: a real term still matches exactly the right pattern',
    `hits=${JSON.stringify(r.hits)}`);
  ok(r.none === 0,
    'B5 CONTROL: a query with no match still returns nothing — short terms did not make it match-all',
    `got ${r.none} hits`);
}

// ══════════════════════════════════════════════════════════════════════════

done();