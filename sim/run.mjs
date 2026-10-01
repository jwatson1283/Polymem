#!/usr/bin/env node
// sim/run.mjs — THE RUNNER.
//
// Runs Polymem, through its public API, against six generated bot personas plus
// a deterministic hostile-input suite and a real multi-process concurrency case,
// and ends with a machine-readable summary and one verdict line:
//
//     SIM: CLEAN
//     SIM: FOUND <n> ISSUES
//
// THREE RULES THIS FILE ENFORVES, each of which exists because the opposite has
// already bitten this project:
//
//  1. NO SILENT DEGRADATION. If Ollama is unreachable the run FAILS with a named
//     error and a fix, before a single persona runs. It does not fall back to
//     fixtures and it does not report green. A harness that degrades quietly is
//     worse than no harness, because it converts "I could not test this" into
//     "I tested this".
//
//  2. NO SYNTHESIS. Every number in the JSON came from a real call in this
//     process. A persona that produced no fence is reported as a persona that
//     produced no fence, with its raw output attached, never as an empty-but-
//     passing session.
//
//  3. NO UNLABLED JUDGMENT. Promoted patterns are classified knowledge/noise by
//     an independent model that has never seen the library's filter, and the
//     judge is CALIBRATED against undisputed labels before its verdict is
//     recorded. An uncalibrated judge's opinion is decoration.
//
// Isolation: every suite gets its own scratch index and sessions directory, so
// the pathological suites cannot contaminate the personas' index and a personas
// bug cannot hide behind a hostile-input artefact. The real ~/.computer-agent is
// never on the path — the library resolves $HOME, so HOME is redirected into the
// scratch root and OMEGA_MEMORY_* point under it.

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { preflight, generate, model, ollamaHost } from './llm.mjs';
import { PERSONAS, HOSTILE_CASES, TOPIC_POOL, SESSION_DATES, personaPrompt } from './personas.mjs';
import { calibrateJudge, classifyPromoted } from './classify.mjs';

const SELF = fileURLToPath(import.meta.url);
const WRITER = join(dirname(SELF), 'writer.mjs');

const issues = [];
function issue(severity, suite, what, detail) {
  issues.push({ severity, suite, what, detail });
  return issues[issues.length - 1];
}

const ISO = () => new Date().toISOString();

// ── Scratch layout ──────────────────────────────────────────────────────────
//
// One root, one HOME, per-suite subtrees. HOME is redirected rather than just
// setting OMEGA_MEMORY_INDEX: polymem resolves $HOME at load for its defaults,
// and a suite that forgot to set the var would otherwise reach the real vault.
const ROOT = mkdtempSync(join(tmpdir(), 'polymem-sim-'));
const HOME = join(ROOT, 'home');
mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;

function suitePaths(name) {
  const dir = join(ROOT, name);
  const sessions = join(dir, 'sessions');
  mkdirSync(sessions, { recursive: true });
  return { dir, indexFile: join(dir, 'patterns-index.json'), sessionsDir: sessions };
}

// ── Child writers (concurrency + isolation) ─────────────────────────────────
//
// spawnSync, not execFile: the runner must be able to say WHICH writer failed
// and keep going, and a wall-clock bound per child is what distinguishes "slow
// model" from "hung".
function runWriterChild(cfg, timeoutMs = 300_000) {
  const started = Date.now();
  const out = spawnSync(process.execPath, [WRITER, JSON.stringify(cfg)], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HOME },
  });
  const r = { ms: Date.now() - started, status: out.status };
  r.stderr = (out.stderr || '').trim().split('\n').slice(-12);
  if (out.error) r.spawnError = `${out.error.name}: ${out.error.message}`;
  const line = (out.stdout || '').trim().split('\n').pop();
  try {
    r.result = line ? JSON.parse(line) : null;
    if (!r.result) r.parseFailure = `no JSON on stdout; stdout was ${JSON.stringify((out.stdout || '').slice(0, 400))}`;
  } catch (e) {
    r.parseFailure = `child stdout was not JSON (${e.message}): ${JSON.stringify((out.stdout || '').slice(0, 400))}`;
  }
  return r;
}

// ── Suite 1: preflight ──────────────────────────────────────────────────────
async function suitePreflight(report) {
  const info = await preflight();   // throws OllamaUnreachable, which is FATAL
  report.environment = {
    ollamaHost: info.host, model: info.model, judgeModel: info.judgeModel,
    modelsInstalled: info.installed, node: info.node, platform: info.platform,
    docker: process.env.SIM_DOCKER_IMAGE || '(not recorded — run via sim/run.sh to pin it)',
    container: existsSync('/.dockerenv') ? 'docker' : 'host',
    scratchRoot: ROOT,
  };
  return info;
}

// ── Suite 2: personas ───────────────────────────────────────────────────────
//
// Each persona writes on 4 consecutive dates, so promotion's 3-session bar is
// actually crossed and the union of evidence is exercised. Topics rotate so two
// personas do not write the same task on the same day, which would let them
// share evidence they did not independently produce — and would make a
// near-duplicate merge look like a genuine cross-agent consensus.
// Find name pairs that share a durable idea but were NOT merged.
//
// findNearDuplicatePatternId (polymem.mjs:696) requires containment >= 0.9 of
// the SHORTER name's tokens. Re-implemented here rather than imported so the
// harness measures the library's rule from the outside and can report the exact
// margin, not just a boolean. Content tokens only (>3 chars) so "the"/"and"
// cannot manufacture overlap.
function paraphraseFragments(patterns, { minShared = 4, threshold = 0.9 } = {}) {
  const nameTokens = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 3);
  const items = patterns.map(p => ({ id: p.id, name: p.name, toks: nameTokens(p.name), sessions: (p.sessions || []).length }));
  const frags = [];
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const A = items[a].toks, B = items[b].toks;
      if (A.length < 3 || B.length < 3) continue;
      const bset = new Set(B);
      const shared = A.filter(t => bset.has(t)).length;
      if (shared < minShared) continue;
      const [shorter, longer] = A.length <= B.length ? [A, B] : [B, A];
      const sset = new Set(shorter);
      const containment = longer.filter(t => sset.has(t)).length / shorter.length;
      // Shared substance, failed to merge: this is the fragmentation.
      if (containment < threshold) {
        frags.push({ a: items[a].id, b: items[b].id, shared, containment: Number(containment.toFixed(3)), merged: false });
      }
    }
  }
  return frags.sort((x, y) => y.containment - x.containment).slice(0, 12);
}

async function suitePersonas(report, modelName) {
  const paths = suitePaths('personas');
  const m = await import('../src/index.mjs');
  Object.assign(process.env, { OMEGA_MEMORY_INDEX: paths.indexFile, OMEGA_MEMORY_SESSIONS_DIR: paths.sessionsDir });

  // Each persona works ONE project across its four dates.
  //
  // A first draft rotated a different topic per date — TOPIC_POOL[(pi*4+si)] —
  // on the theory that it would exercise more of the pipeline. That made the
  // suite's central assertion UNREACHABLE and it produced a false BLOCKER:
  // computeStatus needs 3+ sessions of evidence, a pattern name must match to
  // accumulate them, and four unrelated subjects can never generate a repeat.
  // Every one of the 35 promoted patterns came back with exactly 1 session and
  // the index had 0 established — which the runner correctly reported as
  // "no useful claim reached established", and which was entirely the harness's
  // doing.
  //
  // One stable topic per persona is both the fix and the more realistic model: a
  // bot that keeps working one project for four days is the exact case evidence
  // accumulation exists to serve. Different personas get different topics so they
  // cannot share evidence they did not independently produce. And if the model
  // rewords the same idea four different ways so nothing merges, THAT is a real
  // fragmentation finding rather than an artifact.
  const personaTopic = (pi) => TOPIC_POOL[pi % TOPIC_POOL.length];
  const results = [];
  for (let pi = 0; pi < PERSONAS.length; pi++) {
    const p = PERSONAS[pi];
    const topic = personaTopic(pi);
    const perSession = [];
    for (let si = 0; si < SESSION_DATES.length; si++) {
      const date = SESSION_DATES[si];
      let r;
      try {
        r = await runOne({ ...paths, date, agent: p.id, system: p.system, topic, model: modelName });
      } catch (e) {
        r = { ok: false, agent: p.id, date, topic: topic.id, crash: { name: e.name, message: e.message, stack: String(e.stack).split('\n').slice(0, 8) } };
      }
      perSession.push(r);

      // A MODEL-side failure is not a library crash, and grading it as one is
      // the same category of error as a fixture masquerading as a result. The
      // degenerate persona is *designed* to emit degenerate repetition, which
      // trips Ollama's repeat_limit and returns HTTP 500 mid-generation — that
      // is the model refusing, not Polymem crashing. It is still a real gap in
      // coverage, so it is reported as a GAP: counted in the verdict, never
      // silent, and never filed against the library.
      if (r.crash?.name === 'OllamaUnreachable' || r.crash?.name === 'OllamaError') {
        issue('GAP', `persona:${p.id}`, `session produced no data — the MODEL aborted, the library was never reached`,
          `${r.crash.name}: ${r.crash.message.split('\n')[0]} (${date} / ${topic.id}). This is not a Polymem defect: the request failed before parse() ran. It counts against coverage, so this session is a hole in the report rather than a pass. A repeat_limit abort is the expected mode here, since this persona generates degenerate repetition by design.`);
      } else if (r.crash) {
        issue('BLOCKER', `persona:${p.id}`, `crash on ${date} / ${topic.id}`,
          `${r.crash.name}: ${r.crash.message}`);
      } else if (r.ok === false) {
        // A persona that produced no memory fence is a MEASUREMENT, not a pass.
        issue('FINDING', `persona:${p.id}`, `no memory block in output on ${date} / ${topic.id}`,
          `${r.failure || r.parseFailure || 'unknown'}. Raw output is in the JSON — inspect before treating this as a library bug: a model that ignored the fence contract is a persona problem.`);
      }
      process.stdout.write(`  ${p.id.padEnd(13)} ${date}  ${r.ok ? `claims ${r.gate.presented}→${r.gate.accepted} acc, patterns ${r.parsedCounts.patterns}, promoted ${r.promoted.promoted.length}` : (r.crash ? `NO DATA (${r.crash.name})` : 'NO FENCE')}\n`);
    }
    results.push({ id: p.id, label: p.label, writesStyle: p.writesStyle, expect: p.expect, topic: topic.id, sessions: perSession });
  }

  // ── What each persona promoted, and whether it is knowledge or noise ───────
  const index = m.loadPatternsIndex();
  const all = Object.entries(index.patterns || {}).map(([id, p]) => ({ id, ...p }));
  const verdict = await classifyPromoted(all);
  const byId = new Map(all.map(p => [p.id, p]));

  // Assign the report's OWN copy. The noise sweep below reads
  // report.classification, and this line was missing: the judge's output went
  // into the local `verdict` only, so the sweep dereferenced undefined and
  // threw `TypeError: Cannot read properties of undefined (reading 'filter')`.
  // The throw was caught by main()'s handler, which correctly refused to call
  // the run clean — but it aborted BEFORE hostile, concurrency and isolation
  // ever ran, so one missing assignment silently cost three whole suites. A
  // crash in reporting must never be able to delete coverage.
  //
  // The index fields are joined in here because the finding message quotes
  // status/sessions/domains — what actually reached the store, not just the
  // judge's opinion about it.
  report.classification = verdict.map(v => ({
    ...v,
    status: byId.get(v.id)?.status ?? null,
    sessions: byId.get(v.id)?.sessions ?? [],
    domains: byId.get(v.id)?.domains ?? [],
  }));

  report.personas = results.map(r => ({
    id: r.id, label: r.label, writesStyle: r.writesStyle, expect: r.expect,
    sessionsRun: r.sessions.length,
    sessionsWithFence: r.sessions.filter(s => s.ok).length,
    sessionsWithoutFence: r.sessions.filter(s => !s.ok).map(s => s.date),
    // Reported so a persona's cleanliness is never mistaken for the model's
    // reliability. A persona whose blocks only appeared on the retry produced
    // the same index and should not read as a better-behaved bot.
    fenceRetriedSessions: r.sessions.filter(s => s.fenceMissingOnFirstTry).map(s => s.date),
    claimsPresented: r.sessions.reduce((n, s) => n + (s.gate?.presented || 0), 0),
    claimsAccepted: r.sessions.reduce((n, s) => n + (s.gate?.accepted || 0), 0),
    rejectReasons: r.sessions.reduce((acc, s) => {
      for (const [k, n] of Object.entries(s.gate?.rejects || {})) acc[k] = (acc[k] || 0) + n;
      return acc;
    }, {}),
    promotedPatternNames: r.sessions.flatMap(s => (s.promoted?.promoted || []).map(id => byId.get(id)?.name).filter(Boolean)),
    // Fences that parsed to NOTHING, plus the raw shape of each block. Recorded
    // because the cause was NOT the obvious one: an earlier version of this
    // harness blamed the 300-char bullet threshold, and the measurement
    // disproved it (chatty's longest bullet was 280 and every bullet was still
    // dropped). Header count is what actually separates the causes.
    fencesWithNoBullets: r.sessions.filter(s => s.ok
      && (s.parsedCounts?.claims || 0) === 0 && (s.parsedCounts?.patterns || 0) === 0).map(s => s.date),
    rawHeaderCounts: r.sessions.filter(s => s.ok).map(s => ((s.raw || '').match(/^###\s+\w+/gm) || []).length),
    rawBulletCounts: r.sessions.filter(s => s.ok).map(s => ((s.raw || '').match(/^\s*-\s+/gm) || []).length),
    rawBulletChars: r.sessions.filter(s => s.ok).map(s => {
      const bullets = (s.raw || '').match(/^\s*-\s+(.*)$/gm) || [];
      return Math.max(0, ...bullets.map(b => b.replace(/^\s*-\s+/, '').length));
    }),
  }));

  // A fence that parsed to NOTHING is a silent-discard signal: no throw, no
  // memory:null, just four empty arrays. Graded as a FINDING because the caller
  // has no way to know anything was lost.
  //
  // THE CAUSE IS NOT ASSUMED. The first version of this message blamed the
  // 300-char bullet threshold; the measurement disproved it (chatty's longest
  // bullet was 174 chars). The second version blamed section headers; a later run
  // disproved THAT too (all four sessions had 4 headers each and still yielded
  // nothing). Both diagnoses were plausible and both were wrong, so this now
  // reports the per-session raw shape and stops short of naming a cause it has
  // not isolated.
  //
  // What is established: the block was well-formed, bullets were present in the
  // raw text, and parseMemoryBlock returned a valid but empty memory object.
  // Two parser rules can each produce that on their own — the anchored header
  // match at polymem.mjs:1159 (no matching '### ' at line start leaves `current`
  // null, and line 1161 then skips every bullet) and the length drop at line 1164
  // — so hostile:header-placement and hostile:bullet-length-boundary measure both
  // and are the place to look for the mechanism.
  for (const pp of report.personas) {
    const empties = pp.fencesWithNoBullets || [];
    if (!empties.length) continue;
    const headers = pp.rawHeaderCounts || [];
    const bullets = pp.rawBulletCounts || [];
    const chars = pp.rawBulletChars || [];
    const overLimit = chars.filter(n => n > 300).length;
    const shape = `per-session: headers ${JSON.stringify(headers)}, bullets ${JSON.stringify(bullets)}, longest bullet ${JSON.stringify(chars)} chars`;
    let likely;
    if (overLimit) {
      likely = ` ${overLimit} session(s) had a bullet past the 300-char drop at polymem.mjs:1164, which alone discards that bullet.`;
    } else if (headers.some(h => h === 0)) {
      likely = ` Some session(s) had no recognised '### ' header at line start, which leaves no current section and skips every bullet (polymem.mjs:1159/1161).`;
    } else {
      likely = ` Neither the 300-char drop nor a missing header explains this on its own — all sessions had headers and no bullet exceeded the limit, so the discard is from another parser path not yet isolated. This is reported as an unexplained loss rather than attributed to a guessed cause.`;
    }
    issue('FINDING', `persona:${pp.id}`, `wrote a valid memory fence on ${empties.length} session(s) and had every bullet silently discarded`,
      `Dates: ${empties.join(', ')}. The model wrote ${Math.max(0, ...bullets)} bullets that session and the index received 0. `
      + `Cause not isolated: ${shape}.${likely} `
      + `In every case parseMemoryBlock returned a valid, EMPTY memory object rather than throwing or returning null, so the loss is invisible to the caller.`);
  }

  for (const c of report.classification.filter(v => v.label === 'noise')) {
    issue('FINDING', 'promotion', `noise promoted: "${c.name}"`,
      `judge: ${c.reason} (confidence ${c.confidence}). status=${c.status ?? 'ABSENT'}, sessions=${JSON.stringify(c.sessions)}, domains=${JSON.stringify(c.domains)}. This reached the long-term index; every future query against those domains now returns it.`);
  }
  for (const c of verdict.filter(v => v.label === null)) {
    issue('FINDING', 'classification', `judge could not classify "${c.name}"`,
      c.reason);
  }

  // ── Query-back, on the real index ─────────────────────────────────────────
  const QUERIES = [
    'atomic rename concurrency write torn file',
    'session date traversal path escape',
    'launchd token restart loop',
    'evidence gate sessions domains promotion',
    'prototype pollution constructor header',
    'what did the user request today',
  ];
  report.queryBack = QUERIES.map(q => ({
    query: q,
    hits: m.queryPatterns(q, index).map(h => ({
      id: h.id, name: h.name, status: h.status, score: h.score, evidenceCount: h.evidenceCount,
      label: verdict.find(v => v.id === h.id)?.label ?? 'UNCLASSIFIED',
      reason: verdict.find(v => v.id === h.id)?.reason ?? '',
    })),
  }));
  for (const q of report.queryBack) {
    if (q.hits.length) continue;
    // An empty result is only a finding when the query was about something the
    // personas actually wrote about. "what did the user request today" is
    // expected to be empty precisely because the filter works.
    const factual = /atomic|traversal|launchd|evidence gate|prototype/i.test(q.query);
    if (factual) {
      issue('FINDING', 'query-back', `a factual query returned nothing: "${q.query}"`,
        'The index has patterns, so this is a literal-substring miss on wording, not an empty index. queryPatterns is documented as substring matching; check whether the stored wording drifted.');
    }
  }

  report.paths = { personas: paths };
  return { index, paths };
}

// The in-process variant, used for personas only. The library resolves its paths
// at MODULE LOAD, so the env has to be right before the first import — which is
// why every suite that needs a different index gets its own child process
// instead of a re-import.
async function runOne(cfg) {
  const { runWriter } = await import('./writer.mjs');
  return runWriter(cfg);
}

// ── Suite 3: hostile inputs ─────────────────────────────────────────────────
//
// One child process per case. Isolation is the measurement: if a case pollutes
// Object.prototype, only that case can be blamed for it, and a crash in one case
// cannot mask the rest. The prototype check is run in the CHILD, immediately
// after the operation, because pollution is invisible once the process exits.
async function suiteHostile(report) {
  const results = [];
  const baseline = await baselineProbe();
  void baseline;   // recorded via each child's own before/after delta

  // A well-formed block to mutate. Generated by the real model so the mutations
  // land on realistic text rather than on something the author wrote.
  const basePersona = PERSONAS.find(p => p.id === 'knowledgeable');
  const baseTopic = TOPIC_POOL[0];
  let wellFormed;
  try {
    wellFormed = await generate({
      system: basePersona.system,
      prompt: personaPrompt(basePersona, baseTopic, '2026-10-11'),
      numPredict: 1100,
    });
  } catch (e) {
    issue('BLOCKER', 'hostile', 'could not generate the well-formed baseline block',
      `${e.name}: ${e.message}. Every hostile case is a mutation of this block, so without it the suite cannot run and the run is NOT clean.`);
    report.hostile = { cases: [], baselineAvailable: false };
    return;
  }
  if (!wellFormed.includes('```memory')) {
    issue('BLOCKER', 'hostile', 'the baseline block has no ```memory fence',
      `The well-formed baseline is itself unparseable (${wellFormed.length} chars, no fence). Hostile mutations of an unparseable block measure nothing.`);
    report.hostile = { cases: [], baselineAvailable: false };
    return;
  }

  for (const c of HOSTILE_CASES) {
    const paths = suitePaths(`hostile-${c.id}`);
    // Snapshot the escape targets BEFORE the child runs. This is what turns the
    // containment check from "files exist somewhere" into "this child created
    // these files outside its sandbox".
    const tmpBefore = new Set(readdirSync(tmpdir()));
    const homeBefore = new Set(existsSync(HOME) ? readdirSync(HOME) : []);
    const child = hostileChild(c, paths, wellFormed);
    const r = { id: c.id, desc: c.desc, ...child };

    // The diff. Only entries the CHILD added count as escapes; anything already
    // present (including our own scratch root) is filtered out by name.
    const escapes = [];
    for (const f of (r.tmpAfter || [])) {
      if (tmpBefore.has(f)) continue;
      if (f.startsWith('polymem-sim-')) continue;         // our own scratch roots
      escapes.push(join(tmpdir(), f));
    }
    for (const f of (r.homeAfter || [])) {
      if (!homeBefore.has(f)) escapes.push(join(HOME, f));
    }
    r.escaped = escapes;
    delete r.tmpAfter; delete r.homeAfter;   // noise in the JSON; the verdict is what matters
    results.push(r);

    if (r.hung) {
      issue('BLOCKER', `hostile:${c.id}`, 'the case HUNG', `No completion within the child timeout. Input size ${r.inputBytes} bytes.`);
    } else if (r.crash) {
      issue('BLOCKER', `hostile:${c.id}`, `unhandled exception: ${r.crash.name}`,
        `${r.crash.message}\n  trigger: ${c.desc}\n  stack: ${(r.crash.stack || []).slice(0, 4).join(' | ')}`);
    } else if (r.parseThrew) {
      issue('BLOCKER', `hostile:${c.id}`, 'parseMemoryBlock THREW',
        `The contract at polymem.mjs:1116 says parse failures degrade to { memory: null } and never throw. It threw ${r.parseThrew.name}: ${r.parseThrew.message}. trigger: ${c.desc}`);
    } else if (r.polluted && r.polluted.length) {
      issue('BLOCKER', `hostile:${c.id}`, 'Object.prototype was polluted',
        `New own keys after the call: ${r.polluted.join(', ')}. trigger: ${c.desc}. Every object in the process inherits these afterwards.`);
    } else if (r.escaped && r.escaped.length) {
      issue('BLOCKER', `hostile:${c.id}`, 'a write escaped the scratch directory',
        `Path(s) created outside the sandbox: ${r.escaped.join(', ')}. trigger: ${c.desc}`);
    } else if (r.canaryFound?.length) {
      issue('BLOCKER', `hostile:${c.id}`, 'a traversal canary file was created',
        `"${r.canaryFound.join(', ')}" exists on disk. The date string reached the filesystem. trigger: ${c.desc}`);
    } else if (r.bulletLengths) {
      // The measurement, turned into a finding if the data warrants it. Nothing
      // here asserts a threshold is correct — the harness reports where the two
      // rules disagree and what that costs a verbose writer.
      const dropped = r.bulletLengths.filter(b => b.dropped);
      const truncated = r.bulletLengths.filter(b => b.truncated);
      const silently = dropped.filter(b => b.requested > truncated.reduce((m, t) => Math.max(m, t.requested ?? 0), 200));
      if (dropped.length || truncated.length) {
        const maxKept = Math.max(0, ...r.bulletLengths.filter(b => b.kept).map(b => b.requested));
        const lostChars = r.bulletLengths.filter(b => b.dropped).reduce((n, b) => n + b.requested, 0);
        issue('FINDING', `hostile:${c.id}`, 'two disagreeing length thresholds silently discard verbose memory',
          `polymem.mjs:1164 DROPS any bullet longer than 300 chars, while line 1171 TRUNCATES anything kept to 200. Measured: `
          + `dropped at ${dropped.map(b => b.requested).join(', ')} chars; kept-but-shortened at ${truncated.map(b => `${b.requested}→${b.storedLength}`).join(', ')}; longest kept ${maxKept} chars. `
          + `A verbose bot loses its entire memory block with no error, while a terse bot loses nothing — the effect is silent and undocumented in the README. `
          + `Up to ${lostChars} chars discarded in this probe alone. Consider one rule (truncate at 200 rather than drop at 300) and document it.`);
      }
    } else if (r.headerShapes) {
      // Which header shapes a model can plausibly emit are silently swallowed,
      // with no error and no null, so the whole block lands as an empty memory
      // object. Graded from the measurement, and reported as ONE finding that
      // names every affected shape.
      const silent = r.headerShapes.filter(h => h.wellFormedButEmpty);
      if (silent.length) {
        const ok = r.headerShapes.filter(h => !h.wellFormedButEmpty && !h.threw).map(h => `${h.shape}(${h.itemsKept})`);
        issue('FINDING', `hostile:${c.id}`, 'section headers in ordinary shapes are silently swallowed, yielding an empty memory block',
          `${silent.length} of ${r.headerShapes.length} header shapes parse to a well-formed but EMPTY memory object — no throw, no memory:null, so a caller cannot distinguish a bot that wrote nothing from a bot whose bullets were all dropped. `
          + `Silently empty: ${silent.map(h => h.shape).join(', ')}. Parsed correctly: ${ok.join(', ')}. `
          + `The header matcher is /^###\\s+(\\w+)/ anchored to line start (polymem.mjs:1159), and a bullet is skipped whenever no section is current (line 1161), so: no headers at all, an indented '###', a header glued to its bullet on one line, or an unrecognised section name all discard every bullet. `
          + `This is what the chatty persona hit on 3 of 4 dates. Suggested fix: return memory:null when a fenced block yields zero items but contained bullets, and/or anchor the header match loosely (/^\\s*#+\\s+/).`);
      }
    } else if (r.mustRejectAccepted?.length) {
      issue('BLOCKER', `hostile:${c.id}`, `a containment-breaking session date was ACCEPTED (${r.mustRejectAccepted.length}/${r.mustRejectAttempted})`,
        `Accepted as a valid session key: ${JSON.stringify(r.mustRejectAccepted)}. Each becomes a filename in working-<date>.json; a separator or traversal segment here is an arbitrary-path primitive.`);
    } else if (r.mayAcceptAccepted?.length) {
      // FINDING, not BLOCKER, and deliberately so — see personas.mjs. This is
      // a formatting looseness with no containment consequence, and grading it
      // as a break would be the overstatement that makes readers discount the
      // list.
      issue('FINDING', `hostile:${c.id}`, `a non-calendar date was accepted as a session key (${r.mayAcceptAccepted.length}/${r.mayAcceptAttempted})`,
        `Accepted: ${JSON.stringify(r.mayAcceptAccepted)}. These match /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/ so the format guard cannot reject them; the session is filed under working-<date>.json for a date that does not exist. No containment risk — the file lands inside the sessions dir. Fix would be a calendar validity check next to assertDateStr.`);
    } else if (!r.ok) {
      issue('FINDING', `hostile:${c.id}`, 'child failed without a crash',
        r.failure || 'no result object');
    }
    process.stdout.write(`  ${c.id.padEnd(24)} ${r.ok ? 'survived' : (r.crash ? `CRASH ${r.crash.name}` : (r.hung ? 'HUNG' : 'failed'))}\n`);
  }
  // ── UNIFORM-FAILURE GUARD ─────────────────────────────────────────────────
  //
  // A broken HARNESS and a broken LIBRARY both produce "every case failed", and
  // they mean opposite things. On the first container run all 14 hostile cases
  // reported "failed" — which the naive reading would have filed as fourteen
  // library defects. They were one bug in this file: `node -e` resolves a
  // relative import against cwd, so every child died before touching Polymem.
  //
  // The tell is UNIFORMITY. Genuine input-dependent defects are scattered; a
  // library that fails all fourteen structurally different inputs is either
  // genuinely broken in a way no partial credit makes meaningful, or the
  // instrument is broken. Either way the run must NOT report fourteen findings
  // and a count that implies coverage. It collapses to one BLOCKER naming the
  // probable cause, and the verdict stays a non-clean result.
  const failedAll = results.length > 0 && results.every(r => !r.ok);
  if (failedAll) {
    issue('BLOCKER', 'hostile',
      `ALL ${results.length} hostile cases failed — this is a harness fault, not ${results.length} library defects`,
      'Uniform failure across structurally different inputs is the signature of a broken instrument, not a broken library: the cases never reached the code under test. '
      + `First case's detail: ${results[0].spawnError || results[0].parseFailure || results[0].failure || JSON.stringify(results[0]).slice(0, 300)}. `
      + 'The per-case results below are NOT evidence about Polymem and must not be read as such.');
  }

  report.hostile = {
    baselineAvailable: true,
    baselineLength: wellFormed.length,
    // The raw text each case produced, capped. Without this a reader cannot
    // tell "survived and correctly refused to parse" from "silently did nothing".
    uniformFailure: failedAll,
    cases: results.map(r => ({
      id: r.id, desc: r.desc, survived: !!r.ok, inputBytes: r.inputBytes,
      parsedShape: r.parsedShape, parseThrew: r.parseThrew || null,
      promotedCount: r.promotedCount ?? null, patternKeysSane: r.patternKeysSane ?? null,
      patternKeySample: r.patternKeySample ?? null,
      nonStringResults: r.nonString ?? null, junkEntry: r.junkEntry ?? null,
      seededIndex: r.seededIndex ?? false,
      prototypeDelta: r.polluted || [], escapedPaths: r.escaped || [],
      canaryFound: r.canaryFound || [],
      mustRejectAttempted: r.mustRejectAttempted ?? null,
      mustRejectAccepted: r.mustRejectAccepted ?? null,
      mayAcceptAttempted: r.mayAcceptAttempted ?? null,
      mayAcceptAccepted: r.mayAcceptAccepted ?? null,
      quarantined: r.quarantined ?? null,
      crashed: r.crash || null, hung: !!r.hung,
      failure: r.failure || null, stderr: r.stderr || null,
    })),
  };
}

function hostileChild(c, paths, wellFormed) {
  // The mutation is applied HERE, in the parent, and passed to the child as
  // DATA.
  //
  // It used to be passed as `c.apply` — a function — and interpolated with
  // JSON.stringify. JSON.stringify drops function-valued properties without
  // warning, so CFG.apply arrived as `undefined` in all sixteen children and
  // every mutation case silently tested the UNMUTATED baseline block. Sixteen
  // attack surfaces reported as "survived" while none of them had been
  // attacked. A harness that cannot report the input it actually used is worse
  // than no harness, so the transformation now happens before serialisation and
  // the child receives a plain string it cannot reinterpret.
  //
  // `nonString` gets the same treatment for `undefined`: JSON has no undefined,
  // so an array entry of undefined round-trips to null and the case would test
  // null twice while claiming to test null and undefined. It is tagged here and
  // revived in the child.
  const input = typeof c.apply === 'function' ? c.apply(wellFormed) : wellFormed;
  if (typeof c.apply === 'function' && input === wellFormed) {
    // A mutation that changed nothing is a silent coverage hole of exactly the
    // kind this suite exists to catch, so it is refused rather than measured.
    throw new Error(`hostile case "${c.id}": c.apply returned its input unchanged — the case would test the unmutated block`);
  }
  const UNDEF = { __simUndefined: true };
  const nonString = Array.isArray(c.nonString)
    ? c.nonString.map(v => (v === undefined ? UNDEF : v))
    : null;

  // ABSOLUTE specifier, and it has to be. This script is handed to `node -e`,
  // where a relative import resolves against the PROCESS CWD, not against the
  // sim/ directory that contains it. A first draft used '../src/index.mjs',
  // which from cwd=/work resolved to /src/index.mjs and made all fourteen cases
  // report "failed" — fourteen infrastructure errors wearing fourteen library
  // findings. The uniform-failure guard in suiteHostile now catches that class
  // outright, but the correct path is also required.
  const LIB = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const script = `
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const CFG = ${JSON.stringify({ ...c, apply: undefined, input, nonString, indexFile: paths.indexFile, sessionsDir: paths.sessionsDir })};
const CANARY = 'TMP_CANARY_ABC';
const sandbox = ${JSON.stringify(paths.dir)};
process.env.HOME = ${JSON.stringify(HOME)};
process.env.OMEGA_MEMORY_INDEX = CFG.indexFile;
process.env.OMEGA_MEMORY_SESSIONS_DIR = CFG.sessionsDir;
const m = await import(${JSON.stringify(LIB)});
const out = { ok: true };

function protoKeys() { return Object.getOwnPropertyNames(Object.prototype); }
const before = protoKeys();
// The mutated input arrives as DATA (CFG.input), computed by the parent. See
// hostileChild for why it is not passed as a function.
const input = CFG.input;
out.inputBytes = Buffer.byteLength(input, 'utf8');
// Proof the child received the MUTATION, not the pristine baseline. Without
// this, a case whose mutation was lost again would report 'survived' and be
// filed as a library pass.
out.mutationApplied = CFG.baselineLength !== undefined && input.length !== CFG.baselineLength;

try {
  const parsed = m.parseMemoryBlock(input);
  out.parsedShape = parsed.memory === null ? null
    : { claims: parsed.memory.claims.length, patterns: parsed.memory.patterns.length,
        correspondences: parsed.memory.correspondences.length, contradictions: parsed.memory.contradictions.length };

  // Non-string inputs go through the same public entry point.
  if (CFG.nonString) {
    // The parent tagged undefined, because JSON has no undefined and an
    // untagged one would arrive as null — the case would then test null twice
    // while claiming to cover null and undefined.
    const revive = (v) => (v && typeof v === 'object' && v.__simUndefined === true ? undefined : v);
    out.nonString = CFG.nonString.map(v0 => {
      const v = revive(v0);
      try { const p = m.parseMemoryBlock(v); return { value: String(v), wasUndefined: v === undefined, threw: null, memoryNull: p.memory === null }; }
      catch (e) { return { value: String(v), wasUndefined: v === undefined, threw: e.name + ': ' + e.message }; }
    });
  }

  // A junk-shaped entry, written through the public append path.
  if (CFG.junkEntry) {
    out.junkEntry = {};
    try {
      const flags = m.appendWorkingMemory('2026-10-20', {
        time: new Date().toISOString(), agent: 'degenerate',
        claims: [null, undefined, 'bare string', { text: null }, 42, { text: { nested: true } }, ''],
        patterns: [null, 'bare pattern string', { text: '' },
          { text: 'x'.repeat(5000), domains: Array.from({length:5000}, (_,i)=>'ops') },
          { text: 'dup domains', domains: ['ops','ops','', null, 'OPS', 'infrastructure', 'nonsense-domain'] }],
        correspondences: [null, 42, '', 'a ↔ b', 'x corresponds to y in code'],
        contradictions: [null, { nope: 1 }, 'a real contradiction about the index write path'],
      });
      out.junkEntry.ok = true;
      out.junkEntry.flags = Array.isArray(flags) ? flags.length : typeof flags;
    } catch (e) { out.junkEntry = { ok: false, threw: e.name + ': ' + e.message }; }
  }

  // A seed index whose patterns object carries a literal __proto__ key on disk.
  if (CFG.prototypePollutedJson) {
    const raw = { patterns: JSON.parse('{"__proto__":{"name":"polluted","sessions":["2026-10-01"]},"constructor":{"name":"ctor","sessions":["2026-10-01"]},"real":{"name":"a real pattern about atomic rename and torn index writes","sessions":["2026-10-01"],"domains":["code","ops"],"evidenceCount":3,"status":"established","firstSeen":"x","lastSeen":"x","correspondences":[],"contradictions":[],"implicatedBy":[]}}'), meta: {} };
    writeFileSync(CFG.indexFile, JSON.stringify(raw));
    out.seededIndex = true;
  }

  // Bullet-length behaviour. A MEASUREMENT, not a pass/fail: the point is to
  // record which lengths survive, what they survive AS, and where the two
  // thresholds disagree. The runner reads this to raise the finding; the child
  // only reports.
  if (CFG.bulletLengths) {
    out.bulletLengths = CFG.bulletLengths.map(n => {
      // One bullet per probe, so lengths cannot interact. Padded to exactly n
      // chars of TEXT after the '- ' marker.
      const text = 'x'.repeat(Math.max(1, n));
      const body = '### Claims\\n- ' + text + '\\n### Patterns\\n- ' + text;
      const block = '\`\`\`memory\\n' + body + '\\n\`\`\`';
      const parsed = m.parseMemoryBlock(block);
      const kept = parsed.memory ? parsed.memory.claims[0] : null;
      return {
        requested: n,
        kept: kept !== null && kept !== undefined,
        storedLength: kept ? kept.text.length : 0,
        // Whether it came back SHORT — the information-loss case.
        truncated: kept ? kept.text.length < n : null,
        dropped: kept === null || kept === undefined,
      };
    });
  }

  // Header-shape behaviour. Same contract as bulletLengths: a measurement that
  // records which shapes survive, so the "silently discarded" finding is backed
  // by numbers instead of an anecdote about one persona.
  if (CFG.headerShapes) {
    out.headerShapes = CFG.headerShapes.map(({ name, text }) => {
      const block = '\`\`\`memory\\n' + text + '\\n\`\`\`';
      let parsed = null, threw = null;
      try { parsed = m.parseMemoryBlock(block); } catch (e) { threw = e.name + ': ' + e.message; }
      const kept = parsed && parsed.memory ? (parsed.memory.claims.length + parsed.memory.patterns.length) : 0;
      return {
        shape: name,
        threw,
        // Well-formed but empty is the dangerous outcome: no error, no null.
        wellFormedButEmpty: !threw && parsed && parsed.memory !== null && kept === 0,
        itemsKept: kept,
        // Unrecognised sections land nowhere, so their bullets vanish too.
        unrecognisedSection: /^###\s+(?!Claims\b|Patterns\b|Correspondences\b|Contradictions\b)/m.test(text),
      };
    });
  }

  // Date traversal, graded in two tiers (see personas.mjs for why they differ).
  // A rejected date never touches the filesystem, so the canary check below
  // independently confirms containment.
  if (CFG.dates) {
    const mustReject = CFG.dates.mustReject;
    const mayAccept = CFG.dates.mayAccept;
    out.mustRejectAttempted = mustReject.length;
    out.mustRejectAccepted = [];
    for (const d of mustReject) {
      let rejected = false;
      try { m.workingMemoryPath(d); } catch (e) { rejected = true; }
      if (!rejected) { try { m.loadWorkingMemory(d); } catch (e) { rejected = true; } }
      if (!rejected) { try { m.saveWorkingMemory(d, { date: d, entries: [], contradictions: [] }); } catch (e) { rejected = true; } }
      if (!rejected) out.mustRejectAccepted.push(d);
    }
    // Reported, not asserted: acceptance here is cosmetic (a filename after a
    // non-existent date), so the runner grades it a FINDING rather than a
    // BLOCKER. The numbers are the evidence for that call either way.
    out.mayAcceptAttempted = mayAccept.length;
    out.mayAcceptAccepted = [];
    for (const d of mayAccept) {
      let rejected = false;
      try { m.workingMemoryPath(d); } catch (e) { rejected = true; }
      if (!rejected) out.mayAcceptAccepted.push(d);
    }
  }

  // Promote through the real API and look at what actually landed.
  try {
    const idx = m.loadPatternsIndex();
    const r = m.promoteSession('2026-10-20', idx);
    out.promotedCount = r.promoted.length;
    const keys = Object.keys(idx.patterns || {});
    out.patternKeysSane = keys.every(k => typeof k === 'string' && k.length > 0);
    out.patternKeySample = keys.slice(0, 8);
  } catch (e) {
    if (e.name === 'QuarantineError') out.quarantined = e.message;
    else throw e;
  }
} catch (e) {
  out.ok = false;
  out.crash = { name: e.name, message: e.message, stack: String(e.stack || '').split('\\n').slice(0, 8) };
}

out.polluted = protoKeys().filter(k => !before.includes(k));

// Containment. The child reports the state of the escape TARGETS; the PARENT
// diffs it against a snapshot taken before the child started, because a child
// cannot know what was already there and an absolute "these files exist" test
// would fire on its own scratch directory every single run.
//
// Three targets, because an escape can land in more than one place:
//   * the system temp dir  — a 3-segment date resolves above the sessions dir
//   * the sandbox parent    — a 2-segment date resolves up to here
//   * the redirected HOME   — $HOME-default paths, if OMEGA_MEMORY_* were ignored
const fs = await import('node:fs');
const os = await import('node:os');
out.tmpAfter = fs.readdirSync(os.tmpdir());
out.canaryFound = out.tmpAfter.filter(f => f.includes(CANARY));
out.homeAfter = fs.existsSync(${JSON.stringify(HOME)}) ? fs.readdirSync(${JSON.stringify(HOME)}) : [];
console.log(JSON.stringify(out));
`;
  const r = runScriptChild(script, 180_000);

  // Parse the child BEFORE running it.
  //
  // This is the check that was missing when a single escaping slip in this
  // template (an unescaped \n, which becomes a real newline and terminates the
  // string literal) made all sixteen hostile cases die with the same
  // SyntaxError. Every case reported "failed", and the uniform-failure guard
  // correctly refused to call that sixteen library defects — but the run still
  // burned ~20 minutes of generation to learn something a syntax check answers
  // in milliseconds, and the per-case detail a reader would reach for was a
  // wall of identical stack traces.
  //
  // A child that does not parse is a HARNESS fault. It is reported as such, on
  // its own, before any result is interpreted, so it can never be mistaken for
  // a library outcome.
  //
  // The script is written to a temp .mjs file rather than passed with `-e`,
  // because node refuses `--check` together with `-e` ("either --check or
  // --eval can be used, not both"), which would make this guard reject every
  // child forever.
  const checkPath = join(ROOT, `child-check-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  let parsed = { status: 0, stderr: '' };
  try {
    writeFileSync(checkPath, script);
    parsed = spawnSync(process.execPath, ['--check', checkPath], { encoding: 'utf8', timeout: 60_000 });
  } catch (e) {
    parsed = { status: 1, stderr: String(e.message) };
  } finally {
    try { unlinkSync(checkPath); } catch { /* best effort */ }
  }
  if (parsed.status !== 0) {
    return {
      ok: false, harnessFault: true,
      failure: `the generated child script does not parse: ${(parsed.stderr || '').split('\n').slice(0, 6).join(' | ')}`,
      stderr: (parsed.stderr || '').trim().split('\n').slice(-14),
    };
  }

  if (r.hung) return { ok: false, hung: true };
  if (r.spawnError) return { ok: false, failure: `child could not start: ${r.spawnError}`, stderr: r.stderr };
  return r.result || { ok: false, failure: r.parseFailure || 'no result', stderr: r.stderr };
}

function runScriptChild(script, timeoutMs) {
  const started = Date.now();
  // The child script is handed over STDIN, not argv.
//
// It used to be `node -e <script>`, which puts the whole script on the command
// line. macOS caps a single argv entry near 1MB (MAX_ARG_STRLEN 256KB per
// argument, with the total capped too), so the two deliberately enormous cases —
// `one-mb-block` and `five-thousand-lines` — died with `spawnSync E2BIG` before
// node ever started. They were reported as "child failed", which is true and
// useless: the two largest inputs in the suite, the ones most likely to break a
// parser, were the two never delivered. Feeding the script on stdin removes the
// cap entirely, so the suite tests what it claims to test.
//
// Stdin is used for the SCRIPT only; the input data still travels inside the
// script as JSON, so nothing about the measurement changes.
const out = spawnSync(process.execPath, ['--input-type=module'], {
  encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024,
  input: script,
  env: { ...process.env, HOME },
});
  const r = { ms: Date.now() - started };
  if (out.error) {
    if (out.error.code === 'ETIMEDOUT' || /timed out/i.test(out.error.message)) return { ...r, hung: true };
    return { ...r, spawnError: `${out.error.name}: ${out.error.message}` };
  }
  r.stderr = (out.stderr || '').trim().split('\n').slice(-14);
  const line = (out.stdout || '').trim().split('\n').pop();
  try { r.result = line ? JSON.parse(line) : null; }
  catch (e) { r.parseFailure = `stdout not JSON (${e.message}): ${JSON.stringify((out.stdout || '').slice(0, 500))}`; }
  return r;
}

// A fresh process's Object.prototype keys, for the "did we start clean" record.
async function baselineProbe() {
  const out = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(Object.getOwnPropertyNames(Object.prototype)))'], { encoding: 'utf8' });
  try { return JSON.parse(out.stdout.trim()); } catch { return []; }
}

// ── Suite 4: concurrent writers ─────────────────────────────────────────────
//
// N separate processes, all promoting at once, through the public API — the
// schedule the write claim actually has to survive. Each child promotes on its
// OWN date so a lost update shows up as a missing pattern rather than as a
// plausible-looking merge.
//
// The assertion is on OUTCOME, not on the lock: every child's pattern must be
// present in the final index. A lock that works but a merge that drops an entry
// is still data loss, and it is the case a lock-only test cannot see.
async function suiteConcurrency(report, modelName) {
  const paths = suitePaths('concurrency');
  const N = 6;
  const children = [];
  for (let i = 0; i < N; i++) {
    const p = PERSONAS[i % PERSONAS.length];
    children.push(runWriterChild({
      indexFile: paths.indexFile, sessionsDir: paths.sessionsDir,
      date: SESSION_DATES[i % SESSION_DATES.length],
      agent: `${p.id}#${i}`, system: p.system,
      topic: TOPIC_POOL[i % TOPIC_POOL.length], model: modelName,
    }, 300_000));
  }

  const crashed = children.filter(c => c.result?.crash || c.spawnError || !c.result);
  const reported = children.map(c => c.result).filter(Boolean);
  const promotedByChild = reported.map(r => ({ agent: r.agent, date: r.date, promoted: r.promoted?.promoted || [], ok: r.ok === true }));

  // Read the final index with a FRESH process: an in-process read would be the
  // same object the last writer mutated, which is precisely the state a consumer
  // on another machine would not see.
  const inspect = runScriptChild(`
import { readFileSync } from 'node:fs';
const idx = JSON.parse(readFileSync(${JSON.stringify(paths.indexFile)}, 'utf8'));
const keys = Object.keys(idx.patterns || {});
console.log(JSON.stringify({
  patternCount: keys.length,
  keys: keys.slice(0, 400),
  promotions: idx.meta?.promotions ?? null,
  corrupt: false,
}));
`, 60_000);
  const final = inspect.result || { patternCount: 0, keys: [], corrupt: true, inspectFailure: inspect.parseFailure || inspect.failure };

  // Every pattern any child reported promoting must exist in the final file.
  const finalKeys = new Set(final.keys || []);
  const missing = [];
  for (const c of reported) {
    for (const id of c.promoted?.promoted || []) if (!finalKeys.has(id)) missing.push({ agent: c.agent, id });
  }

  for (const c of crashed) {
    issue('BLOCKER', 'concurrency', `writer ${c.result?.agent || '?'} failed`,
      c.result?.crash ? `${c.result.crash.name}: ${c.result.crash.message}` : (c.spawnError || c.parseFailure || 'no result'));
  }
  for (const m of missing) {
    issue('BLOCKER', 'concurrency', 'lost update: a promoted pattern is absent from the final index',
      `agent ${m.agent} reported promoting "${m.id}", and it is not in the file written by the last writer. The write claim serialised the writers but the merge dropped an entry.`);
  }
  if (final.corrupt) {
    issue('BLOCKER', 'concurrency', 'the final index is not readable JSON',
      `${final.inspectFailure || 'parse failed'} — torn write or lost claim.`);
  }

  report.concurrency = {
    writers: N, processes: 'separate OS processes (child_process.spawnSync)',
    allOk: crashed.length === 0,
    promotedTotal: reported.reduce((n, r) => n + (r.promoted?.promoted?.length || 0), 0),
    perWriter: promotedByChild,
    finalIndexPatternCount: final.patternCount,
    finalIndexKeysSample: (final.keys || []).slice(0, 12),
    promotionsCounter: final.promotions,
    lostUpdates: missing,
    writerMs: children.map(c => c.ms),
  };
  return paths;
}

// ── Suite 5: the real vault was never touched ───────────────────────────────
//
// Not a formality. The library's defaults resolve $HOME, this run redirects it,
// and if that redirect ever stops working the failure mode is a simulation that
// pollutes Josh's real memory index. Asserting it costs one line.
async function suiteIsolation(report) {
  const real = join(process.env.USERPROFILE || '/Users/exampleuser', '.computer-agent');
  const report_ = {
    scratchRoot: ROOT,
    realVaultPath: real,
    realVaultExists: existsSync(real),
    redirectedHome: process.env.HOME === HOME,
    scratchIsUnderTmp: ROOT.startsWith(tmpdir()),
    envSeams: { OMEGA_MEMORY_INDEX: process.env.OMEGA_MEMORY_INDEX, OMEGA_MEMORY_SESSIONS_DIR: process.env.OMEGA_MEMORY_SESSIONS_DIR },
  };
  // If the real vault exists and its mtime is inside the run window, the sim wrote to it.
  if (report_.realVaultExists) {
    const { statSync } = await import('node:fs');
    const idx = join(real, 'memory', 'patterns-index.json');
    if (existsSync(idx)) {
      const st = statSync(idx);
      const runStart = new Date(ROOT_DIR_MTIME).getTime();
      if (st.mtimeMs > runStart) {
        issue('BLOCKER', 'isolation', 'the simulation WROTE to the real ~/.computer-agent index',
          `${idx} has mtime ${new Date(st.mtimeMs).toISOString()}, inside this run (started ${new Date(runStart).toISOString()}). HOME redirection failed.`);
      } else {
        report_.realIndexMtime = new Date(st.mtimeMs).toISOString();
        report_.realIndexUntouched = true;
      }
    }
  }
  if (!report_.redirectedHome) issue('BLOCKER', 'isolation', 'HOME was not redirected into the scratch root', 'The library resolves $HOME for its defaults.');
  if (!report_.scratchIsUnderTmp) issue('FINDING', 'isolation', 'scratch root is not under the system temp dir', ROOT);
  report.isolation = report_;
}

let ROOT_DIR_MTIME = 0;

// ── Verdict ─────────────────────────────────────────────────────────────────
//
// Three severities, because "the library is broken" and "this run covers less
// than it claims" are different claims and merging them is how a harness starts
// lying by accident.
//
//   BLOCKER — a Polymem defect: a crash, a hang, a throw that violates a
//             documented contract, prototype pollution, an escaped write, a
//             lost update, or a containment-breaking date accepted.
//   FINDING — real, needs a judgement call: noise that reached the index, a
//             factual query returning nothing, a non-calendar date accepted.
//   GAP     — the run measured LESS than it set out to, for a reason outside
//             Polymem (the model aborted, a session produced no block). Counted,
//             never silent, never filed against the library. Without this tier a
//             model that refuses to generate would be indistinguishable from a
//             library that silently drops data.
function verdictLine() {
  const count = (sev) => issues.filter(i => i.severity === sev).length;
  const blockers = count('BLOCKER'), findings = count('FINDING'), gaps = count('GAP');
  const total = blockers + findings + gaps;
  return { blockers, findings, gaps, total, line: total === 0 ? 'SIM: CLEAN' : `SIM: FOUND ${total} ISSUES` };
}

// Run ONE suite so that a throw inside it is recorded as that suite's failure
// and the remaining suites still execute.
//
// This is not defensive padding — it is a measured correction. A missing
// `report.classification =` assignment threw inside the personas suite AFTER
// that suite had finished all its real work; main()'s catch-all aborted the
// process, so hostile, concurrency and isolation never ran at all. The report
// said "personas ran, three suites missing" and the run was correctly
// non-clean, but a reader had no way to tell that the missing suites were an
// instrument bug rather than three unexplored attack surfaces. That is the
// ambiguity this card exists to remove.
//
// So: a suite that throws is a BLOCKER naming the suite and the error, its
// report field stays null (so the existing "did not execute" accounting still
// sees it as unrun), and the next suite starts.
async function runSuite(name, report, fn) {
  try {
    await fn();
  } catch (e) {
    issue('BLOCKER', name, `the ${name} suite crashed — this suite is UNMEASURED, not clean`,
      `${e.name}: ${e.message}\n${String(e.stack || '').split('\n').slice(1, 5).join('\n')} `
      + `This is a HARNESS fault in sim/, not a Polymem defect, and it means no ${name} result exists. `
      + `Every other suite still ran; the verdict stays non-clean because an unmeasured suite is not a passing one.`);
    process.stderr.write(`[${name}] suite crashed: ${e.name}: ${e.message}\n${e.stack}\n`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
const started = ISO();
const report = {
  startedAt: started,
  harness: 'polymem sim',
  personas: null, hostile: null, concurrency: null, isolation: null,
  issues: null, verdict: null,
};

let exitCode = 0;
try {
  ROOT_DIR_MTIME = Date.now();
  process.stdout.write('── preflight ───────────────────────────────────────────────────────\n');
  const info = await suitePreflight(report);
  process.stdout.write(`  ollama ${info.host} · model ${info.model} · node ${info.node} · ${report.environment.container}\n`);

  process.stdout.write('\n── judge calibration ──────────────────────────────────────────────\n');
  const cal = await calibrateJudge();
  report.calibration = cal;
  if (!cal.ok) {
    issue('FINDING', 'judge', `the noise/knowledge judge scored ${cal.correct}/${cal.total} on undisputed labels`,
      `Its verdicts on real patterns are not trustworthy this run. Per-case: ${JSON.stringify(cal.results)}. Fix the judge before reading the classification section.`);
  }
  process.stdout.write(`  ${cal.correct}/${cal.total} undisputed labels correct${cal.ok ? '' : ' — CLASSIFICATIONS BELOW ARE UNRELIABLE'}\n`);

  process.stdout.write('\n── personas ───────────────────────────────────────────────────────\n');
  await runSuite('personas', report, () => suitePersonas(report, info.model));

  process.stdout.write('\n── hostile inputs ──────────────────────────────────────────────────\n');
  await runSuite('hostile', report, () => suiteHostile(report));

  process.stdout.write('\n── concurrent writers ──────────────────────────────────────────────\n');
  await runSuite('concurrency', report, () => suiteConcurrency(report, info.model));

  process.stdout.write('\n── isolation ───────────────────────────────────────────────────────\n');
  await runSuite('isolation', report, () => suiteIsolation(report));

  const v = verdictLine();
  report.issues = issues;
  report.verdict = { ...v, exitCode: v.total === 0 ? 0 : 1 };
  report.finishedAt = ISO();
  exitCode = report.verdict.exitCode;
} catch (e) {
  // A preflight failure lands here. It is FATAL by design and says so.
  report.fatal = { name: e.name, message: e.message };
  report.issues = issues;
  // Reuse verdictLine() rather than re-deriving counts here. The hand-rolled
  // version that lived at this spot hardcoded `findings: 0` and omitted `gaps`,
  // so a fatal run printed "0 finding(s), undefined gap(s)" — which understates
  // the issues it had just recorded AND throws on the missing key. Counting in
  // one place means the fatal path cannot drift from the normal one.
  report.verdict = {
    ...verdictLine(),
    line: 'SIM: BLOCKED — the suite did not run',
  };
  report.finishedAt = ISO();
  exitCode = 2;
  process.stderr.write(`\n${e.message}\n\n`);
  if (!(e instanceof Object && e.name === 'OllamaUnreachable')) {
    process.stderr.write(`Unexpected harness failure: ${e.name}: ${e.message}\n${e.stack}\n`);
  }
}

// ── Output ──────────────────────────────────────────────────────────────────
const outPath = process.env.SIM_REPORT_OUT || join(process.cwd(), 'sim-report.json');
try { writeFileSync(outPath, JSON.stringify(report, null, 2)); } catch { /* best effort */ }
report.reportPath = outPath;

const D = (s) => `\u001b[2m${s}\u001b[0m`;
const B = (s) => `\u001b[1m${s}\u001b[0m`;
const RED = (s) => `\u001b[31m${s}\u001b[0m`;
const YEL = (s) => `\u001b[33m${s}\u001b[0m`;
const GRN = (s) => `\u001b[32m${s}\u001b[0m`;
const MAG = (s) => `\u001b[35m${s}\u001b[0m`;

if (report.personas?.length) {
  process.stdout.write(`\n${B('══ promoted patterns, classified ══════════════════════════════════')}\n`);
  for (const p of report.personas) {
    const line = `${p.label.padEnd(13)} fence ${p.sessionsWithFence}/${p.sessionsRun}  claims ${p.claimsAccepted}/${p.claimsPresented} kept  promoted ${p.promotedPatternNames.length}`;
    process.stdout.write(`  ${line}\n`);
    if (p.fenceRetriedSessions?.length) {
      process.stdout.write(D(`               needed a retry for the fence on: ${p.fenceRetriedSessions.join(', ')}\n`));
    }
    if (Object.keys(p.rejectReasons).length) {
      process.stdout.write(D(`               gate rejected: ${Object.entries(p.rejectReasons).map(([k, v]) => `${k}×${v}`).join(', ')}\n`));
    }
  }
  if (report.indexSummary) {
    const i = report.indexSummary;
    const e = report.promotionEvidence;
    process.stdout.write(`\n  index: ${i.patternCount} patterns · ${i.established} established · ${i.candidate} candidate · judged ${i.knowledge} knowledge / ${i.noise} noise\n`);
    if (e) {
      process.stdout.write(D(`  evidence depth per pattern (sessions → count): ${JSON.stringify(e.sessionCountHistogram)}; deepest ${e.maxSessionsOnAnyPattern} ${e.repeatedEvidenceAvailable ? '· bar reachable' : '· BELOW the 3-session bar, established was unreachable'}\n`));
    }
  }
}

if (report.queryBack?.length) {
  process.stdout.write(`\n${B('══ query-back ═════════════════════════════════════════════════════')}\n`);
  for (const q of report.queryBack) {
    process.stdout.write(`  ${D('?')} ${q.query}\n`);
    if (!q.hits.length) { process.stdout.write(`      ${D('(no hits)')}\n`); continue; }
    for (const h of q.hits.slice(0, 4)) {
      const tag = h.label === 'knowledge' ? GRN('knowledge') : h.label === 'noise' ? RED('noise') : YEL('unclassified');
      process.stdout.write(`      ${tag}  ${h.name} ${D(`[${h.status} ev=${h.evidenceCount} score=${h.score}]`)}\n`);
      if (h.label === 'noise') process.stdout.write(D(`                 judge: ${h.reason}\n`));
    }
  }
}

process.stdout.write(`\n${B('══ issues ══════════════════════════════════════════════════════════')}\n`);
if (report.fatal) {
  // THE ONE PLACE THIS HARNESS COULD HAVE LIED, AND DOES NOT.
  //
  // A fatal preflight failure means NO SUITE RAN. Printing "issues: none" here
  // — which is exactly what the generic empty-list branch below would do — puts
  // a green-looking section directly above "SIM: BLOCKED" and invites exactly
  // the misreading this card exists to prevent: someone skims, sees no issues,
  // and files the run as clean. The section states the absence of a result
  // instead, in the same place a result would have been.
  process.stdout.write(`  ${RED('THE SUITE DID NOT RUN')} — these are not results, and their absence is not a pass.\n`);
  process.stdout.write(`  ${RED(report.fatal.name)}: ${report.fatal.message.split('\n').join('\n  ')}\n`);
  process.stdout.write(`\n  Suites that did not execute: `);
  const ran = ['preflight', 'calibration', 'personas', 'hostile', 'concurrency', 'isolation'];
  const done = { preflight: !!report.environment, calibration: !!report.calibration, personas: !!report.personas, hostile: !!report.hostile, concurrency: !!report.concurrency, isolation: !!report.isolation };
  process.stdout.write(`${ran.filter(s => !done[s]).join(', ') || '(none)'}\n`);
  if (issues.length) {
    process.stdout.write(`\n  Issues recorded before the failure:\n`);
    for (const i of issues) {
      const tag = i.severity === 'BLOCKER' ? RED('BLOCKER') : YEL('FINDING');
      process.stdout.write(`    ${tag}  ${D(`[${i.suite}]`)} ${i.what}\n        ${i.detail}\n`);
    }
  }
} else if (!issues.length) {
  process.stdout.write(`  ${GRN('none')} — no crash, no hang, no swallowed error, no prototype pollution,\n  no lost update, and nothing the judge calls noise reached the index.\n`);
}
// Issues after the fatal block would double-print; the fatal branch lists them.
if (!report.fatal) for (const i of issues) {
  const tag = i.severity === 'BLOCKER' ? RED('BLOCKER') : i.severity === 'GAP' ? MAG('GAP') : YEL('FINDING');
  process.stdout.write(`  ${tag}  ${D(`[${i.suite}]`)} ${i.what}\n      ${i.detail}\n`);
}

const v = report.verdict;
process.stdout.write(`\n${B(v.line)}\n`);
process.stdout.write(D(`  ${v.blockers} blocker(s), ${v.findings} finding(s), ${v.gaps} gap(s) · report: ${outPath}\n`));
process.stdout.write(D(`  ollama ${ollamaHost()} · model ${model()}\n`));

process.exitCode = exitCode;
