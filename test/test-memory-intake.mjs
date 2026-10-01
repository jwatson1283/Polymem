// test/test-memory-intake.mjs
//
// FOUR INTAKE DEFECTS: a malformed session crashes promotion, a whole session's
// memory is silently discarded, bullet length has two disagreeing thresholds,
// and a non-calendar date is accepted as a session key.
//
// All four were reported by the persona simulation (sim-report.json, verdict
// "SIM: FOUND 7 ISSUES") and all four are reproduced here against the real
// module before being believed. The simulation could not isolate the biggest
// one — it filed it as "cause not isolated" — so the cause was found by
// measurement instead; see FINDING 1 below for what it actually is.
//
// CHILD PROCESSES ARE LOAD-BEARING. polymem.mjs resolves INDEX_FILE and
// SESSIONS_DIR at MODULE LOAD, so setting process.env after the import changes
// nothing. Every promoteSession scenario runs via execFileSync with the env
// already in place. A probe that gets this wrong measures nothing at all — and
// it is the single easiest way to fake a result in this codebase. (An earlier
// draft of this work did exactly that: the first promotion probe inherited the
// operator's real index, hit its quarantine gate, and every case "failed" for
// a reason that had nothing to do with the code under test.)
//
// THE UNIFYING RULE, and the reason these four are one suite. Every one of them
// is the same failure wearing different clothes: the caller is told memory was
// handled and it was not. A crash is the loud version. A silently empty memory
// object, a silently dropped bullet, and a silently shortened bullet are the
// quiet versions, and they are worse — a bot writes memory, the system keeps
// nothing, and nothing anywhere says so. Polymem's own patternGate exists
// precisely because "the gate rejected it, here is the reason" is the
// alternative. These tests extend that standard to every drop on the intake
// path: if the library discards something, the discard is COUNTED and
// REPORTABLE. A silent drop is a defect, not a design.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSuite } from './harness.mjs';

const { section, ok, done } = createSuite('test-memory-intake.mjs');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = join(REPO, 'src', 'polymem.mjs');

const { parseMemoryBlock, workingMemoryPath, assertDateStrProbe } = await import(MODULE);

// Run a snippet in a fresh process with a private HOME and index path. Returns
// { rows, stderr }; a child that throws comes back with stderr set, so a crash
// is an assertion failure rather than a silent skip.
function child(body) {
  const home = mkdtempSync(join(tmpdir(), 'polymem-intake-'));
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
      },
    });
  } catch (e) {
    stdout = e.stdout || '';
    stderr = e.stderr || String(e.message);
  }
  const rows = stdout.split('\n').filter((l) => l.startsWith('@@')).map((l) => JSON.parse(l.slice(2)));
  rmSync(home, { recursive: true, force: true });
  return { rows, stderr };
}

// Promote one hand-written session document and report what happened. The
// document is written straight to the sessions dir, bypassing appendWorkingMemory,
// because the defect is about what promotion does with a session file that is
// already on disk — which is exactly what a hand-edited, truncated, or
// third-party-written session file looks like in production.
function promote(date, doc) {
  const { rows, stderr } = child(`
    const fs = await import('node:fs');
    fs.writeFileSync(m.workingMemoryPath(${JSON.stringify(date)}), ${JSON.stringify(JSON.stringify(doc))});
    const idx = m.loadPatternsIndex();
    let result = null, threw = null;
    try { result = m.promoteSession(${JSON.stringify(date)}, idx); }
    catch (e) { threw = e.name + ': ' + String(e.message).slice(0, 120); }
    out({ threw, result, gate: idx.meta && idx.meta.patternGate,
          promoted: result ? result.promoted : null });
  `);
  return { ...(rows[0] || {}), stderr };
}

// ═══════════════════════════════════════════════════════════════════════════
// FINDING 1 — the whole-session silent loss. THE ROOT CAUSE.
//
// This is the one the simulation could not isolate, and it is worth stating
// precisely because the filed cause was wrong.
//
// THE FILED CAUSE was "the 300-char bullet drop". It was disproved by the
// harness's own numbers (terse lost a session whose longest bullet was 96
// chars, and all sessions had 4 headers each), and the harness correctly
// declined to guess. But it then reported "another parser path not yet
// isolated" and stopped.
//
// THE ACTUAL CAUSE is how the fence is LOCATED. parseMemoryBlock does
//
//   const fenceAt = text.indexOf('```memory');
//
// — the first occurrence of that substring ANYWHERE in the reply. A model that
// QUOTES the fence opener in its prose hits it first. Then the body regex runs
// from that prose position, captures the quoted fragment up to the next ```,
// finds no section headers in it, and returns a well-formed but EMPTY memory
// object. The real fence further down the reply is never parsed at all.
//
// This is not a contrived input. The simulation's own FENCE_CONTRACT prompt
// contains the literal string "```memory" inside its instruction text:
//
//   "End your reply with EXACTLY ONE fenced block that begins with
//    ```memory on its own line."
//
// So every persona was TOLD the opener's spelling, and any persona that
// restates or quotes that instruction — which the chatty persona is explicitly
// prompted to do ("You restate the task in your answer before answering it") —
// writes the opener into its prose. The harness manufactured its own trigger.
// The degenerate persona compounds it by nesting fences inside the block.
//
// TWO HARMS, AND THE SECOND IS WORSE. `display` is computed as the text BEFORE
// fenceAt, so the quoted-opener bug does not merely lose the memory — it
// TRUNCATES THE USER-FACING ANSWER mid-sentence, at the point where the model
// mentioned the word. A caller sees a short, confident, complete-looking reply
// and an empty memory, with no error anywhere.
//
// THE FIX anchors the opener to a line and takes the LAST such opener, because
// the documented contract is "End your reply with EXACTLY ONE fenced block" and
// "Do not put text after the closing fence" — the block is at the END. A quoted
// opener mid-prose is not at the start of a line, so it is not an opener at all.
// ═══════════════════════════════════════════════════════════════════════════

section('FINDING 1 — a quoted fence opener must not swallow the real block');

const REAL_BLOCK = '\n```memory\n### Claims\n- the date guard lives at assertDateStr\n### Patterns\n- validate the date before it becomes a filename\n```';
const ANSWER = 'I fixed the containment bug by validating the date at assertDateStr.';

{
  // The control. Without this, a parser that returned null for everything would
  // satisfy every "does not lose memory" assertion below.
  const ctl = parseMemoryBlock(ANSWER + REAL_BLOCK);
  ok(ctl.memory !== null && ctl.memory.claims.length === 1 && ctl.memory.patterns.length === 1,
    'CONTROL: a plain reply ending in one memory block parses both sections',
    JSON.stringify(ctl.memory && { c: ctl.memory.claims.length, p: ctl.memory.patterns.length }));
}

{
  // THE DEFECT. The opener quoted mid-prose, then a newline — which is what
  // happens when a model restates the contract it was just given.
  const quoted = parseMemoryBlock(
    ANSWER + ' The contract says to end with a block that begins with ```memory\non its own line.' + REAL_BLOCK);

  ok(quoted.memory !== null && quoted.memory.patterns.length === 1,
    'a fence opener quoted in prose does not cost the real block its patterns',
    `patterns=${quoted.memory && quoted.memory.patterns.length}`);
  ok(quoted.memory !== null && quoted.memory.claims.length === 1,
    'a fence opener quoted in prose does not cost the real block its claims',
    `claims=${quoted.memory && quoted.memory.claims.length}`);
  // The display is the WHOLE reply minus the block, and it must include the
  // prose that quoted the opener. Asserted as containment plus a tail check, not
  // equality: the sentence that mentions the opener IS part of the answer, and
  // the regression to catch is display stopping mid-sentence at the mention
  // (which is what it used to do — it ended at "...begins with").
  ok(quoted.display.startsWith(ANSWER),
    'display keeps the answer that came before the quoted opener',
    JSON.stringify(quoted.display));
  ok(/on its own line\.$/.test(quoted.display.trim()),
    'a quoted opener does NOT truncate display mid-sentence at the mention',
    JSON.stringify(quoted.display));
}

{
  // The same trap in its nastier form: prose containing an entire EXAMPLE block
  // (with its own headers and bullets), then the model's real memory after it.
  // The example must not win — it is not the agent's memory.
  const example = parseMemoryBlock([
    'Example of the format:',
    '```memory',
    '### Claims',
    '- THIS IS AN EXAMPLE NOT REAL MEMORY',
    '```',
    'My actual memory:',
    '```memory',
    '### Claims',
    '- the date guard lives at assertDateStr',
    '```',
  ].join('\n'));

  const texts = example.memory ? example.memory.claims.map((c) => c.text) : [];
  ok(!texts.some((t) => /EXAMPLE NOT REAL/.test(t)),
    'an example block shown in prose is not mistaken for the agent\'s memory',
    JSON.stringify(texts));
  ok(texts.includes('the date guard lives at assertDateStr'),
    'the real block after an example block is still parsed',
    JSON.stringify(texts));
}

{
  // Two real blocks. Contract says exactly one, at the end; last-wins is the
  // reading that matches the contract. Pinned so the choice is deliberate.
  const two = parseMemoryBlock(
    '```memory\n### Claims\n- an earlier stray block\n```\n\n```memory\n### Claims\n- the real final block\n```');
  const texts = two.memory ? two.memory.claims.map((c) => c.text) : [];
  ok(texts.includes('the real final block'),
    'when two blocks are present the LAST one wins (the contract puts it last)',
    JSON.stringify(texts));
}

{
  // The never-throw contract still holds, and prose with no block at all is
  // still memory:null — this fix must not turn ordinary prose into a fence.
  const prose = parseMemoryBlock('Just a normal answer with no memory block.');
  ok(prose.memory === null, 'prose with no fenced block still degrades to memory:null');
  ok(prose.display === 'Just a normal answer with no memory block.',
    'prose with no fenced block is still returned whole as display');

  const nasty = [
    '```memory', '```memory\n', '```memory\n### \n- x\n', '```memory\n```',
    '```memory\n### Claims\n- x', ANSWER + ' ```memory', '```memory\n\n\n\n',
  ];
  const crashed = [];
  for (const n of nasty) {
    try { parseMemoryBlock(n); } catch (e) { crashed.push(`${e.name}: ${e.message.slice(0, 60)}`); }
  }
  ok(crashed.length === 0, 'parseMemoryBlock still honours "never throw"', crashed.join(' | '));
}

// ═══════════════════════════════════════════════════════════════════════════
// FINDING 2 — two disagreeing length thresholds for one field.
//
// MEASURED BEFORE THE FIX (sim-report.json, hostile:bullet-length-boundary):
//
//   dropped entirely:            301, 400, 1200 chars
//   kept but silently shortened: 201->200, 299->200, 300->200
//
// Two thresholds for one field is almost certainly unintended: :1481 dropped
// anything over 300 and :1488 truncated everything kept to 200. The gap
// between 201 and 300 is pure silent shortening, and anything past 300 is pure
// silent loss — up to 1901 characters discarded in the probe alone, with no
// counter anywhere.
//
// THE RECONCILIATION IS ONE RULE, AND IT REMOVES A DROP. Truncate at 300;
// never discard for length. This is deliberately the PERMISSIVE direction: the
// brief is explicit that these findings are cases where real model output was
// discarded, and that rejecting more would make the product worse. A verbose
// bot keeps a truncated version of its bullet instead of losing it outright,
// and the shortening is counted rather than silent.
//
// A 300-char bound is still a real bound — the degenerate persona writes
// single-line bullets over 2000 chars with no spaces, and those are capped
// rather than allowed to grow without limit. The gate downstream still judges
// whether the text is a usable pattern name; this only decides whether the text
// ARRIVES.
// ═══════════════════════════════════════════════════════════════════════════

section('FINDING 2 — one length rule, and length never causes a silent drop');

function oneBullet(n) {
  return '```memory\n### Claims\n- ' + 'x'.repeat(n) + '\n```';
}

{
  const ctl = parseMemoryBlock(oneBullet(50));
  ok(ctl.memory && ctl.memory.claims.length === 1 && ctl.memory.claims[0].text.length === 50,
    'CONTROL: a short bullet is kept at full length, untruncated',
    ctl.memory ? String(ctl.memory.claims[0] && ctl.memory.claims[0].text.length) : 'null');
}

{
  // The gap that was silently shortened, and the lengths that were silently
  // dropped. None of these may vanish.
  const KEPT_AT_LEAST = [201, 250, 299, 300, 301, 400, 1200];
  const lost = [];
  const overCap = [];
  for (const n of KEPT_AT_LEAST) {
    const r = parseMemoryBlock(oneBullet(n));
    const got = r.memory && r.memory.claims.length ? r.memory.claims[0].text.length : 0;
    if (got === 0) lost.push(n);
    else if (n > 300 && got !== 300) overCap.push(`${n}->${got}`);
  }
  ok(lost.length === 0,
    'no bullet length causes the bullet to be DISCARDED (was: dropped at >300)',
    `lost at ${JSON.stringify(lost)}`);
  ok(overCap.length === 0,
    'an over-long bullet is truncated to exactly the cap, not to a second smaller cap',
    overCap.join(' '));
}

{
  // The 201-300 band: previously kept but silently cut to 200. Now kept whole,
  // because there is one threshold and it is 300.
  const r = parseMemoryBlock(oneBullet(299));
  const len = r.memory && r.memory.claims.length ? r.memory.claims[0].text.length : 0;
  ok(len === 299, 'a 299-char bullet is no longer silently shortened to 200', `got ${len}`);
}

{
  // Truncation must be REPORTED, not silent — same standard as the gate.
  const r = parseMemoryBlock(oneBullet(1200));
  const diag = r.diagnostics || {};
  ok(typeof diag.truncated === 'number' && diag.truncated === 1,
    'a truncated bullet is COUNTED in diagnostics (a silent shortening is a defect)',
    JSON.stringify(diag));
  const ctl = parseMemoryBlock(oneBullet(50));
  ok((ctl.diagnostics && ctl.diagnostics.truncated) === 0,
    'an untruncated bullet counts zero truncations',
    JSON.stringify(ctl.diagnostics));
}

// ═══════════════════════════════════════════════════════════════════════════
// FINDING 3 — header shapes that yield a SILENTLY EMPTY memory block.
//
// MEASURED (hostile:header-placement): 4 of 8 shapes parsed to a well-formed
// but EMPTY memory object — no throw, no memory:null, so "a caller cannot
// distinguish a bot that wrote nothing from a bot whose bullets were all
// dropped." That sentence is the finding. The bug is not that they are dropped;
// it is that the drop is INVISIBLE.
//
// So the two halves of the fix are deliberately different, and which is which is
// a decision, not an accident:
//
//   PARSE these — the memory is unambiguous and we were throwing it away:
//     indented-header       `  ### Claims` — Markdown indentation is not a
//                           different section. A model that indents its header
//                           meant Claims.
//     header-and-bullet-on-one-line — `### Claims - the text` carries a real
//                           bullet glued to the header. Keeping the header and
//                           dropping the bullet is the worst of both.
//
//   DO NOT parse these — the section is genuinely unknowable, and guessing
//   would file a claim under a domain nobody asserted:
//     no-headers            bullets with no section at all
//     unknown-section       `### Observations` is not one of the four
//
//   ...but make BOTH visible. Every bullet dropped for want of a section is
//   counted, and a caller can now tell "wrote nothing" from "wrote 14 bullets
//   I could not attribute" — which is precisely the distinction the filed
//   finding said was missing.
// ═══════════════════════════════════════════════════════════════════════════

section('FINDING 3 — ordinary header shapes parse; unattributable ones are VISIBLE');

{
  const indented = parseMemoryBlock('```memory\n  ### Claims\n  - an indented header is still a header\n```');
  ok(indented.memory && indented.memory.claims.length === 1,
    'an indented section header parses (indentation is not a different section)',
    `claims=${indented.memory && indented.memory.claims.length}`);

  const tabbed = parseMemoryBlock('```memory\n\t### Patterns\n\t- a tab-indented header\n```');
  ok(tabbed.memory && tabbed.memory.patterns.length === 1,
    'a tab-indented section header parses',
    `patterns=${tabbed.memory && tabbed.memory.patterns.length}`);
}

{
  const glued = parseMemoryBlock('```memory\n### Claims - the date guard lives at assertDateStr\n```');
  ok(glued.memory && glued.memory.claims.length === 1,
    'a bullet glued to its header on one line is kept, not dropped',
    `claims=${glued.memory && glued.memory.claims.length}`);
  ok(glued.memory && glued.memory.claims[0] && /assertDateStr/.test(glued.memory.claims[0].text),
    'the glued bullet keeps its own text, not the header name',
    JSON.stringify(glued.memory && glued.memory.claims[0]));
}

{
  // The two that must NOT be guessed at — and must not be silent.
  const noHeaders = parseMemoryBlock('```memory\n- an orphan bullet\n- a second orphan\n```');
  const d1 = noHeaders.diagnostics || {};
  ok(d1.droppedNoSection === 2,
    'bullets with no section at all are COUNTED as unattributable, not silently lost',
    JSON.stringify(d1));

  const unknown = parseMemoryBlock('```memory\n### Observations\n- a bullet under an unknown section\n```');
  const d2 = unknown.diagnostics || {};
  ok(d2.unknownSections && d2.unknownSections.includes('Observations'),
    'an unrecognised section name is REPORTED by name',
    JSON.stringify(d2));

  // And the guess we are refusing to make, asserted directly: an unknown
  // section must NOT land its bullets in Claims.
  const leaked = unknown.memory ? unknown.memory.claims.concat(unknown.memory.patterns) : [];
  ok(leaked.length === 0,
    'an unknown section does NOT get its bullets filed under a guessed section',
    JSON.stringify(leaked.map((x) => x.text)));
}

{
  // The distinction the filed finding said was impossible. This is the whole
  // point of the section, so it is asserted as its own case.
  const nothing = parseMemoryBlock('```memory\n### Claims\n### Patterns\n```');
  const wroteNothing = nothing.diagnostics || {};
  const droppedAll = parseMemoryBlock('```memory\n### Observations\n- a\n- b\n- c\n```');
  const lostAll = droppedAll.diagnostics || {};
  const lostTotal = (lostAll.droppedNoSection || 0) + (lostAll.droppedUnknownSection || 0);
  ok(wroteNothing.droppedNoSection === 0 && lostTotal === 3,
    'a caller can DISTINGUISH "the bot wrote nothing" from "every bullet was dropped"',
    `wroteNothing=${JSON.stringify(wroteNothing)} lostAll=${lostTotal}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// FINDING 4 (BLOCKER) — promoteSession throws on a malformed session file.
//
// The filed reproduction was one throw: `patterns: [null]` -> TypeError at the
// `assessPatternName(p.text)` call. That is real, and it violates the
// never-throw contract parseMemoryBlock documents three hundred lines above.
// MEASURED HERE: it is FOUR throws, not one, all on the same loop head, and
// three of them are on shapes a half-written or hand-edited session file
// produces long before anyone gets around to a null pattern element:
//
//   entries: [null]                  TypeError: Cannot read properties of null (reading 'patterns')
//   entries: "notarray"              TypeError: working.entries.reduce is not a function
//   entries missing                  TypeError: working.entries is not iterable
//   patterns: [null]                 TypeError: Cannot read properties of null (reading 'text')
//
// The array guard `e.patterns || []` protects the array and nothing else, which
// is the shape of bug this codebase has been bitten by repeatedly.
//
// THE FIX guards the whole loop head, and — the part that matters — COUNTS
// every skip in meta.patternGate beside the rejections that were already being
// counted. A skipped element must be as visible as a rejected one; if the
// library drops it, an operator has to be able to ask why and get an answer.
// ═══════════════════════════════════════════════════════════════════════════

section('FINDING 4 (BLOCKER) — a malformed session must never crash promotion');

{
  // CONTROL FIRST. If promotion cannot succeed at all, every "does not throw"
  // assertion below is satisfied by a function that does nothing.
  const good = promote('2026-04-01', {
    date: '2026-04-01',
    entries: [{ time: 't', agent: 'probe', task: 't',
      patterns: [{ text: 'validate the date before it becomes a filename', domains: ['code'] }],
      claims: [], correspondences: [], contradictions: [] }],
    contradictions: [],
  });
  ok(!good.threw && good.promoted && good.promoted.length === 1,
    'CONTROL: a well-formed session promotes its pattern',
    `threw=${good.threw} promoted=${JSON.stringify(good.promoted)}`);
  ok(good.gate && good.gate.accepted === 1,
    'CONTROL: the gate counts the acceptance, so the mechanism under test works',
    JSON.stringify(good.gate));
}

{
  const cases = [
    ['patterns: [null]',            '2026-04-02', { patterns: [null] }],
    ['patterns: [undefined]',       '2026-04-03', { patterns: [undefined] }],
    ['entries: [null]',             '2026-04-04', null],
    ['entries: not an array',       '2026-04-05', 'notarray'],
    ['entries missing',             '2026-04-06', 'missing'],
    ['contradictions missing',      '2026-04-07', { contradictions: 'notarray' }],
  ];
  const threw = [];
  for (const [name, date, shape] of cases) {
    let doc;
    if (shape === 'notarray') doc = { date, entries: 'notarray', contradictions: [] };
    else if (shape === 'missing') doc = { date, contradictions: [] };
    else if (shape === null) doc = { date, entries: [null], contradictions: [] };
    else if (name === 'contradictions missing') doc = { date, entries: [], contradictions: 'notarray' };
    else doc = { date, entries: [{ patterns: shape.patterns }], contradictions: [] };

    const r = promote(date, doc);
    if (r.threw) threw.push(`${name} -> ${r.threw}`);
  }
  ok(threw.length === 0,
    'promoteSession does not throw on any malformed session shape',
    threw.join(' | '));
}

{
  // The collateral-damage case, and the one that matters most in production:
  // ONE malformed element must not cost the session its GOOD ones.
  const r = promote('2026-04-08', {
    date: '2026-04-08',
    entries: [{ patterns: [
      null,
      { text: 'validate the date before it becomes a filename', domains: ['code'] },
      undefined,
      { text: 'atomic tmp+rename publishes a whole file or nothing', domains: ['code'] },
    ] }],
    contradictions: [],
  });
  ok(!r.threw, 'a null element alongside good ones does not crash promotion', String(r.threw));
  ok(r.promoted && r.promoted.length === 2,
    'good patterns in a session with null siblings are STILL promoted',
    `promoted=${JSON.stringify(r.promoted)}`);
}

{
  // VISIBILITY. The brief is explicit: "A silent drop is not an acceptable fix
  // here." Every skipped element is counted in meta.patternGate.
  const r = promote('2026-04-09', {
    date: '2026-04-09',
    entries: [{ patterns: [null, undefined, { text: 'validate the date before it becomes a filename' }] }],
    contradictions: [],
  });
  const g = r.gate || {};
  const skipped = g.skipped || 0;
  ok(skipped === 2,
    'skipped malformed pattern elements are COUNTED in meta.patternGate.skipped',
    JSON.stringify(g));
  ok(g.byReason && typeof g.byReason['malformed-pattern'] === 'number',
    'the skip is attributed to a named reason (malformed-pattern)',
    JSON.stringify(g.byReason));
  ok(g.accepted === 1 && g.rejected === 0,
    'a good sibling is counted ACCEPTED, not swept up in the skip',
    JSON.stringify(g));

  // The entry-level skip is counted too, under its own reason.
  const r2 = promote('2026-04-10', { date: '2026-04-10', entries: [null], contradictions: [] });
  const g2 = r2.gate || {};
  ok((g2.byReason && g2.byReason['malformed-entry'] === 1) || (g2.skipped || 0) >= 1,
    'a null ENTRY is counted separately from a null pattern element',
    JSON.stringify(g2));
}

{
  // The stats bag must survive the concurrent merge: these are the numbers an
  // operator reads, and mergeStatBags takes max() on numeric leaves.
  const { rows } = child(`
    const merged = m.mergeConcurrentIndex(
      { version: 1, patterns: {}, meta: { patternGate: { accepted: 3, rejected: 1, skipped: 2, byReason: { 'malformed-pattern': 2 } } } },
      { version: 1, patterns: {}, meta: { patternGate: { accepted: 5, rejected: 1, skipped: 4, byReason: { 'malformed-pattern': 4 } } } });
    out({ gate: merged.meta.patternGate });
  `);
  const g = rows[0] && rows[0].gate;
  ok(g && g.skipped >= 2, 'the skip counter survives the concurrent merge', JSON.stringify(g));
}

// ═══════════════════════════════════════════════════════════════════════════
// FINDING 5 (LOW) — non-calendar dates accepted as session keys.
//
// MEASURED (hostile:date-traversal): 2026-13-45, 2026-02-30, 9999-99-99 and
// 0000-00-00 all pass /^\d{4}-\d{2}-\d{2}$/. There is no containment risk —
// the file lands inside the sessions dir — so this is LOW, and the brief calls
// it cheap to tighten. It is worth tightening because the date becomes a
// FILENAME: a session filed under 2026-02-30 can never be found by a caller
// asking for a real day, and "which sessions ran on the 30th" silently omits
// it. A date that cannot exist is a caller bug, and assertDateStr already
// throws for that class rather than coercing — this extends the same rule.
//
// The existing traversal guard must not regress: those strings contain path
// separators and are refused by the format check before this one runs.
// ═══════════════════════════════════════════════════════════════════════════

section('FINDING 5 — a session date must be a real calendar day');

{
  const BAD = ['2026-13-45', '2026-02-30', '9999-99-99', '0000-00-00',
               '2026-04-31', '2026-00-10', '2026-01-00', '2025-02-29'];
  const accepted = [];
  for (const d of BAD) {
    const r = child(`try { m.workingMemoryPath(${JSON.stringify(d)}); out({ ok: true }); }
                     catch (e) { out({ ok: false, msg: String(e.message) }); }`);
    if (r.rows[0] && r.rows[0].ok) accepted.push(d);
  }
  ok(accepted.length === 0,
    'a non-calendar date is REFUSED as a session key (format guard alone let all of these through)',
    `accepted ${JSON.stringify(accepted)}`);
}

{
  // The control, and the guard against over-tightening: real days, leap years
  // included, must still work — and 2024 IS a leap year while 2026 is not.
  const GOOD = ['2026-04-01', '2026-12-31', '2024-02-29', '2000-02-29', '1999-12-31'];
  const refused = [];
  for (const d of GOOD) {
    const r = child(`try { out({ p: m.workingMemoryPath(${JSON.stringify(d)}) }); }
                     catch (e) { out({ msg: String(e.message) }); }`);
    if (!r.rows[0] || !r.rows[0].p) refused.push(d);
  }
  ok(refused.length === 0,
    'CONTROL: every real calendar day, leap days included, is still accepted',
    `refused ${JSON.stringify(refused)}`);

  const nonLeap = child(`try { m.workingMemoryPath('2026-02-29'); out({ ok: true }); }
                         catch (e) { out({ ok: false }); }`);
  ok(nonLeap.rows[0] && nonLeap.rows[0].ok === false,
    'CONTROL: 2026-02-29 is refused and 2024-02-29 is not — the check is a real calendar, not a range');
}

{
  // The traversal guard must survive untouched, and the error must still name
  // the expected format (an existing suite asserts that message).
  const evil = '../../../../TARGET';
  const r = child(`let threw = null; try { m.workingMemoryPath(${JSON.stringify(evil)}); } catch (e) { threw = e.message; } out({ threw });`);
  const msg = r.rows[0] && r.rows[0].threw;
  ok(typeof msg === 'string' && /YYYY-MM-DD/.test(msg),
    'a traversal date is still refused, with an error naming the expected format', String(msg));

  const notAString = child(`let threw = null; try { m.workingMemoryPath(12345); } catch (e) { threw = e.message; } out({ threw });`);
  ok(notAString.rows[0] && typeof notAString.rows[0].threw === 'string',
    'a non-string date is still refused rather than coerced');
}

done();
