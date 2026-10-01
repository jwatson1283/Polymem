// sim/writer.mjs — ONE bot process. Parse → gate → append → promote → query,
// through the public API exactly as README documents it.
//
// This is the unit the concurrency case spawns. It is deliberately the same
// code path the single-process runner uses, so a bug found here is a bug in the
// consumer's path and not in a special simulation-only branch.
//
// The library reads its index and sessions paths from the environment AT LOAD,
// so the paths must be set before the dynamic import below. That ordering is the
// whole reason this file imports polymem lazily instead of at the top.

import { generate } from './llm.mjs';
import { personaPrompt, FENCE_CONTRACT } from './personas.mjs';

/**
 * @param {object} cfg
 * @param {string} cfg.indexFile       OMEGA_MEMORY_INDEX
 * @param {string} cfg.sessionsDir     OMEGA_MEMORY_SESSIONS_DIR
 * @param {string} cfg.date            YYYY-MM-DD
 * @param {string} cfg.agent           persona id
 * @param {string} cfg.system          persona system prompt
 * @param {object} cfg.topic           { id, task, domain }
 * @param {string} [cfg.raw]           pre-generated block; skips the model call
 */
export async function runWriter(cfg) {
  process.env.OMEGA_MEMORY_INDEX = cfg.indexFile;
  process.env.OMEGA_MEMORY_SESSIONS_DIR = cfg.sessionsDir;

  const t0 = Date.now();

  // ── Generation, with ONE bounded retry for a missing fence ────────────────
  //
  // MEASURED, and this is a harness defect being corrected rather than a
  // library finding being absorbed. Across 15 generations the fence contract
  // was honoured 14 times; the miss was a 887-character reply, so NOT a
  // truncation — the model simply ran out of steam before the block. Left
  // alone, one such reply becomes a "no memory block" FINDING against
  // Polymem, which would be a false accusation: parseMemoryBlock returning
  // { memory: null } for prose is the documented, correct behaviour.
  //
  // So the harness retries once, and REPORTS the retry. A persona that only
  // ever produced a block on attempt 2 is a fact about the model, and the JSON
  // records generationAttempts so nobody reads its output as clean-by-nature.
  // One retry, not five: a persistent refusal to emit a fence would otherwise
  // be disguised as a slow model.
  let raw = null;
  let generationAttempts = 0;
  let rawFenceMissing = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    generationAttempts = attempt;
    const candidate = cfg.raw ?? await generate({
      system: cfg.system,
      prompt: personaPrompt(cfg, cfg.topic, cfg.date),
      numPredict: 1100,
    });
    raw = candidate;
    if (candidate.includes('```memory')) break;
    rawFenceMissing = true;
    if (attempt === 1) {
      process.stdout.write(`    (retry: ${cfg.agent}/${cfg.date} produced no \`\`\`memory fence — ${candidate.length} chars)\n`);
    }
  }

  const m = await import('../src/index.mjs');
  const timings = { generate: Date.now() - t0 };
  const t1 = Date.now();

  // ── Step 1: parse ─────────────────────────────────────────────────────────
  const parsed = m.parseMemoryBlock(raw);
  timings.parse = Date.now() - t1;
  const memory = parsed.memory;

  // The persona produced NO usable block. That is a fact about the simulation,
  // not about the library — but it must never be silently counted as a pass.
  if (!memory) {
    return {
      ok: false, agent: cfg.agent, date: cfg.date, topic: cfg.topic.id,
      rawLength: raw.length, raw, timings,
      generationAttempts, rawFenceMissing,
      failure: 'no ```memory fence in the model output after 2 attempts — parseMemoryBlock returned { memory: null }.'
        + ' This is the DOCUMENTED behaviour for prose input, so it is a persona/model result rather than a library defect;'
        + ' the raw output is attached so it can be confirmed.',
      displayLength: parsed.display.length,
    };
  }

  // ── Step 2: provenance + the claim gate, applied as a consumer applies it ──
  const stamped = m.stampProvenance(memory.claims, {
    provider: 'ollama', model: cfg.model || 'qwen2.5-coder:14b',
    task: cfg.topic.id, taskId: `sim-${cfg.date}-${cfg.agent}`, agent: cfg.agent, routeSource: 'sim',
  });
  const seen = new Set();
  const accepted = [];
  const rejects = {};
  for (const c of stamped) {
    const key = String(c.text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const a = m.assessClaim(c, seen);
    if (a.accept) { accepted.push(c); seen.add(key); }
    else rejects[a.reason] = (rejects[a.reason] || 0) + 1;
  }

  // ── Step 3: append to session working memory ──────────────────────────────
  const entry = {
    time: new Date().toISOString(),
    agent: cfg.agent,
    task: cfg.topic.id,
    claims: accepted,
    patterns: memory.patterns,
    correspondences: memory.correspondences,
    contradictions: memory.contradictions,
  };
  const flags = m.appendWorkingMemory(cfg.date, entry);

  // ── Step 4: promote ───────────────────────────────────────────────────────
  const index = m.loadPatternsIndex();
  const promoted = m.promoteSession(cfg.date, index);

  const t2 = Date.now();
  // ── Step 5: query back, the way a consumer would ──────────────────────────
  const queries = (cfg.queries || [cfg.topic.task]).map(q => ({
    query: q,
    hits: m.queryPatterns(q, index).map(h => ({ id: h.id, name: h.name, status: h.status, score: h.score })),
  }));

  return {
    ok: true,
    agent: cfg.agent,
    date: cfg.date,
    topic: cfg.topic.id,
    rawLength: raw.length,
    raw,
    generationAttempts,
    fenceMissingOnFirstTry: rawFenceMissing,
    parsedCounts: {
      claims: memory.claims.length,
      patterns: memory.patterns.length,
      correspondences: memory.correspondences.length,
      contradictions: memory.contradictions.length,
    },
    gate: { presented: stamped.length, accepted: accepted.length, rejects },
    contradictionsFlagged: flags.length,
    promoted,
    queries,
    timings: { ...timings, promoteAndQuery: Date.now() - t2 },
  };
}

export { FENCE_CONTRACT };

// ── Child entry point, for the concurrent-writers case ──────────────────────
//
// Invoked as: node sim/writer.mjs '<json>'
//
// Every writer is a SEPARATE PROCESS, not a promise. Promises on one event loop
// interleave at await points, which is the one schedule the library's write
// claim was never tested against; the real fleet is N bot processes on one
// machine. Also, an uncaught throw in one writer must not be able to take the
// other writers down with it, or a single failure would read as a fleet failure.
if (process.argv[1] && process.argv[1].endsWith('writer.mjs')) {
  const cfg = JSON.parse(process.argv[2]);
  const started = Date.now();
  try {
    const result = await runWriter(cfg);
    console.log(JSON.stringify({ ...result, ms: Date.now() - started }));
  } catch (e) {
    console.log(JSON.stringify({
      ok: false, agent: cfg.agent, date: cfg.date, topic: cfg.topic?.id,
      crash: { name: e.name, message: e.message, stack: String(e.stack || '').split('\n').slice(0, 6) },
      ms: Date.now() - started,
    }));
  }
}
