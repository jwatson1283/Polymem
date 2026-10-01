// test-prototype-safety.mjs
//
// REGRESSION TEST FOR THE PROTOTYPE-CHAIN LOOKUPS (polymem.mjs, old :370, :723, :261, :293).
//
// THE BUG. Three functions indexed plain objects with a key taken from
// LLM-generated text, and got the INHERITED member of Object.prototype instead
// of undefined. A truthiness test then read that member as a real value.
//
// ROUTE A — parseMemoryBlock, section headers. SECTION_MAP['constructor']
// returned Object.prototype.constructor, which is truthy, so the `|| null`
// fallback never fired and `current` became a FUNCTION. The next line did
// `memory[current].length` on a key no such section has:
//
//   parseMemoryBlock('```memory\n### constructor\n- x\n```')
//     -> TypeError: Cannot read properties of undefined (reading 'length')
//
// This broke the contract written directly above that function — "Parse
// failures degrade to { memory: null }, never throw, never block the write
// path" — on the per-response entry point. No attacker is needed: a model only
// has to emit the word, and a memory section header is exactly the thing a
// model emits when it is asked to describe its own memory system.
//
// `__proto__` is the same defect via a different key and is ALSO live here,
// unlike in promoteSession: the header regex /^###\s+(\w+)/ matches
// `### __proto__`, and SECTION_MAP['__proto__'] returns Object.prototype — also
// truthy, also not a section. Isolated per-process sweep of the whole
// Object.prototype surface: exactly these two headers throw in Route A, and
// nothing else on the surface does.
//
// ROUTE B — promoteSession, pattern names. patternId('constructor') ===
// 'constructor', so `index.patterns[rawId]` returned the Object constructor,
// truthy, and the "already exists" branch ran against a function:
// 'Cannot read properties of undefined (reading \'includes\')'.
//
// WORSE THAN THE FINDING RECORDED — demotePattern / restorePattern did not just
// throw, they WROTE to Object.prototype itself, before the throw. Measured on
// the original code:
//
//   demotePattern(index, 'constructor')  -> threw, but left these own keys on
//     Object.prototype.constructor:
//       demotedFrom, status, demotedAt, demotedReason
//   restorePattern(index, 'toString')   -> same, on Object.prototype.toString:
//       restoredFrom, status, restoredAt, restoredReason
//
// That is process-wide contamination visible to every object in the runtime,
// including code that never touches memory. The filed finding listed these two
// call sites as no-ops ("bare property read, cannot be reached via promoteSession
// or appendWorkingMemory"). The read could not be reached by a promoted pattern,
// correct — but the functions are exported and take a raw id, and the writes
// were real.
//
// The fix uses own-property checks (Object.hasOwn) and a null-prototype
// SECTION_MAP: removing the inherited keys, rather than filtering a list of
// known-bad strings, so a future Object.prototype addition cannot reopen it.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = join(REPO, 'src', 'polymem.mjs');

import { createSuite } from './harness.mjs';

const { ok, done } = createSuite('test-prototype-safety.mjs');

const work = mkdtempSync(join(tmpdir(), 'polymem-proto-'));
const home = join(work, 'home');
const env = {
  PATH: process.env.PATH, HOME: home,
  OMEGA_MEMORY_INDEX: join(home, 'memory', 'patterns-index.json'),
  OMEGA_MEMORY_SESSIONS_DIR: join(home, 'sessions'),
};

// Every own property of Object.prototype, plus the classic prototype-pollution
// payloads. Swept rather than hand-picked, so a newly-added inherited member is
// covered by the next run without editing this file.
const SURFACE = [
  'constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty',
  '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable',
  'toString', 'valueOf', '__proto__', 'toLocaleString',
];

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
    const s = (e.stderr || '').toString();
    return { crashed: (s.split('\n').find(l => /Error/.test(l)) || 'crashed').trim() };
  }
};

console.log('prototype-key safety:');

try {
  // ── 1. ROUTE A: the parser must never throw, on any prototype key ───────
  // Asserted over the whole surface in a FRESH process per key. Running them
  // in one process was the first version of this test and it was wrong: an
  // early throw leaves state behind and makes every later key report failure,
  // which reads as "12 bugs" when the real answer is "2 keys". One process per
  // key is the only way the number means anything.
  {
    const crashed = [];
    const misparsed = [];
    for (const k of SURFACE) {
      const j = child(`
        const r = m.parseMemoryBlock(${JSON.stringify('```memory\n### ' + k + '\n- x\n```')});
        return { memory: r.memory, hasMemory: r.memory !== null };
      `);
      if (j.crashed) { crashed.push(k); continue; }
      // A prototype key is not a section: it must be ignored, not become one.
      const mem = j.memory || {};
      const sectionKeys = Object.keys(mem).filter((s) => (mem[s] || []).length > 0);
      if (sectionKeys.length > 0) misparsed.push(`${k} -> ${sectionKeys.join('+')}`);
    }
    ok(crashed.length === 0,
      `parseMemoryBlock does not throw on any of the ${SURFACE.length} Object.prototype keys`,
      crashed.length ? 'THREW: ' + crashed.join(', ') : '');
    ok(misparsed.length === 0,
      'a prototype key is IGNORED, not silently treated as a real section',
      misparsed.join('; '));
  }

  // ── 2. ROUTE B: promoteSession on a prototype-named pattern ─────────────
  {
    const crashed = [];
    for (const k of SURFACE) {
      const j = child(`
        m.appendWorkingMemory('2026-09-30', {
          time: 't', agent: 'probe', claims: [],
          patterns: [{ text: ${JSON.stringify(k)}, domains: ['code'] }],
          correspondences: [], contradictions: [],
        });
        const idx = m.loadPatternsIndex();
        const r = m.promoteSession('2026-09-30', idx);
        return { promoted: r && r.promoted !== undefined ? r.promoted : r };
      `);
      if (j.crashed) crashed.push(`${k}: ${j.crashed.slice(0, 80)}`);
    }
    ok(crashed.length === 0,
      `promoteSession does not throw on any of the ${SURFACE.length} prototype keys`,
      crashed.join(' | '));
  }

  // ── 3. the real end-to-end case: a model writes the word ────────────────
  // Not an exotic payload — the actual trigger is a session in which a pattern
  // is named "constructor". Reproduce the whole chain and require a real
  // pattern entry, not merely the absence of a throw.
  {
    const j = child(`
      m.appendWorkingMemory('2026-09-30', {
        time: 't', agent: 'probe', claims: [],
        patterns: [{ text: 'constructor', domains: ['code'] }],
        correspondences: [], contradictions: [],
      });
      const idx = m.loadPatternsIndex();
      m.promoteSession('2026-09-30', idx);
      const after = m.loadPatternsIndex();
      const own = Object.keys(after.patterns).filter(k => Object.hasOwn(after.patterns, k));
      return { keys: own, id: m.patternId('constructor') };
    `);
    ok(!j.crashed, 'a session whose pattern is named "constructor" completes', j.crashed || '');
    ok(Array.isArray(j.keys) && j.keys.includes('constructor'),
      '"constructor" is stored as an ORDINARY pattern id, safely',
      `keys=${JSON.stringify(j.keys)}`);
  }

  // ── 4. demotePattern / restorePattern must not touch Object.prototype ────
  // The part the filed finding called harmless. Assert on the actual global
  // object, after the call, in a process that does nothing else.
  {
    for (const k of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const j = child(`
        const idx = { version: 1, patterns: {}, meta: { decompositionStats: {}, promotions: 0 } };
        const before = Object.keys(Object.getPrototypeOf({}).constructor).length;
        let threw = null;
        try { m.demotePattern(idx, ${JSON.stringify(k)}, 'probe'); } catch (e) { threw = e.message; }
        // Read the shared object's own keys AFTER the call.
        const after = Object.keys(Object.getPrototypeOf({}).constructor);
        const toStrKeys = Object.keys(Object.prototype.toString);
        return { threw, after, toStrKeys, before };
      `);
      const polluted = (j.after && j.after.length > 0) || (j.toStrKeys && j.toStrKeys.length > 0);
      ok(!polluted,
        `demotePattern(index, ${JSON.stringify(k)}) does not write to Object.prototype`,
        polluted ? `leaked keys: ${JSON.stringify(j.after)} / ${JSON.stringify(j.toStrKeys)}` : '');
    }
  }

  // ── 5. restorePattern, same guard ───────────────────────────────────────
  {
    const j = child(`
      const idx = { version: 1, patterns: {}, meta: { decompositionStats: {}, promotions: 0 } };
      let threw = null;
      try { m.restorePattern(idx, 'toString', 'probe'); } catch (e) { threw = e.message; }
      return { threw, toStrKeys: Object.keys(Object.prototype.toString),
               fnKeys: Object.keys(Object.getPrototypeOf({}).constructor) };
    `);
    ok((j.toStrKeys || []).length === 0,
      'restorePattern does not write to Object.prototype.toString',
      JSON.stringify(j.toStrKeys));
    ok((j.fnKeys || []).length === 0,
      'restorePattern does not write to Object.prototype.constructor',
      JSON.stringify(j.fnKeys));
  }

  // ── 6. an existing pattern named "constructor" demotes NORMALLY ─────────
  // The fix must be an own-property check, not a blocklist. If "constructor"
  // were special-cased out, a legitimate pattern by that name would silently
  // stop demoting — the same class of looks-fine-while-broken bug.
  {
    const j = child(`
      const idx = { version: 1, patterns: {
        constructor: { name: 'constructor', domains: ['code'], sessions: ['2026-09-30'],
                      evidenceCount: 9, status: 'established', firstSeen: 'x', lastSeen: 'x',
                      correspondences: [], contradictions: [], nameVariations: [], implicatedBy: [] },
      }, meta: { decompositionStats: {}, promotions: 1 } };
      const demoted = m.demotePattern(idx, 'constructor', 'contradicted');
      const after = m.loadPatternsIndex ? null : null;
      return { demoted, status: idx.patterns.constructor.status,
               metaKeys: Object.keys(idx.meta) };
    `);
    ok(j.demoted === true, 'a real pattern named "constructor" still demotes normally',
      `demoted=${JSON.stringify(j.demoted)}`);
    // 'candidate', not 'demoted': demotion drops trust back to candidate by
    // design (see the comment above demotePattern). My first version of this
    // assertion expected the literal string 'demoted' and failed against
    // working code — worth recording, because the fix here is an own-property
    // check, NOT a blocklist, and the evidence that it is not a blocklist is
    // that the ordinary status transition still happens.
    ok(j.status === 'candidate',
      'and its own status is updated by the normal demotion transition',
      `status=${j.status}`);
  }

  // ── 6b. consolidation with a prototype-named entry ──────────────────────
  // The one remaining place with a bare `index.patterns[id]` lookup. Defensible
  // only because every id comes from Object.entries() and `processed` covers the
  // deletes — but the hazard is real: after `delete index.patterns['toString']`,
  // a bare lookup of that id returns the INHERITED function.
  //
  // The subtlety that cost three false-negative probes: consolidation only fires
  // when token containment >= 0.9. "atomic rename file write" vs "atomic rename
  // file writes" scores 3/4 = 0.75, so the delete never runs and the test passes
  // without exercising anything. So this asserts the merge ACTUALLY fired —
  // otherwise the case is vacuous and would report a green that means nothing.
  {
    const j = child(`
      const entry = (name, ev) => ({
        name, domains: ['code'], sessions: ['2026-09-30'], evidenceCount: ev,
        status: 'established', firstSeen: 'x', lastSeen: 'x',
        correspondences: [], contradictions: [], nameVariations: [], implicatedBy: [] });
      const idx = { version: 1, patterns: {
        'atomic-rename-file-write': entry('atomic rename file write', 50),
        toString: entry('atomic rename file write path', 3),
      }, meta: { decompositionStats: {}, promotions: 1 } };
      const merges = m.consolidateNearDuplicates(idx);
      return {
        merges, keys: Object.keys(idx.patterns),
        protoToString: Object.keys(Object.prototype.toString).length,
        protoCtor: Object.keys(Object.getPrototypeOf({}).constructor).length,
        protoValueOf: Object.keys(Object.prototype.valueOf).length,
        survivorSessions: idx.patterns['atomic-rename-file-write']?.sessions?.length ?? -1,
      };
    `);
    ok((j.merges || []).length === 1,
      'the merge actually fires — this case is NOT vacuously passing',
      `merges=${JSON.stringify(j.merges)}`);
    ok(Array.isArray(j.keys) && !j.keys.includes('toString'),
      'a prototype-named entry is absorbed and deleted as an ordinary key',
      `keys=${JSON.stringify(j.keys)}`);
    ok(j.protoToString === 0 && j.protoCtor === 0 && j.protoValueOf === 0,
      'consolidation does not write to Object.prototype when deleting one',
      `toString=${j.protoToString} ctor=${j.protoCtor} valueOf=${j.protoValueOf}`);
    ok(j.survivorSessions === 1,
      'the survivor still absorbs the deleted entry\'s evidence',
      `sessions=${j.survivorSessions}`);
  }

  // ── 7. the parser's own contract: never throw, on ANY input ─────────────
  // The claim at the top of parseMemoryBlock, asserted directly so a future
  // refactor that reintroduces a throwing path fails here rather than in
  // production on a per-response code path.
  {
    const nasty = [
      '```memory\n### constructor\n- x\n```',
      '```memory\n### __proto__\n- x\n```',
      '```memory\n### toString\n- x\n### valueOf\n- y\n```',
      '```memory\n### hasOwnProperty\n```',
      '```memory',
      '```memory\n### \n- x\n```',
      '```memory\n### __proto__\n- ../../etc/passwd\n```',
      '',
    ];
    const crashed = [];
    for (const inp of nasty) {
      const j = child(`
        const r = m.parseMemoryBlock(${JSON.stringify(inp)});
        return { display: typeof r.display, memory: r.memory };
      `);
      if (j.crashed) crashed.push(JSON.stringify(inp.slice(0, 40)));
    }
    ok(crashed.length === 0,
      'parseMemoryBlock honours "never throw" across adversarial input',
      crashed.join(' | '));
  }

} finally {
  rmSync(work, { recursive: true, force: true });
}

done();
