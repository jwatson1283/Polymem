// Reproduces the sim run's central question: with a STABLE topic across four
// dates, can a pattern ever accumulate 3 sessions and reach `established`?
//
//     node repro-established-bar.mjs
//
// THE FINDING. The sim ran 5 personas x 4 dates on stable topics. 78 pattern
// promotions collapsed to 33 distinct entries — so dedup IS working, merging
// real near-duplicates. But every single entry ended with exactly ONE session,
// and 0 reached `established`. The merge happens WITHIN a date's session
// patterns (78 -> 33 across the whole run); it never happens ACROSS dates,
// because the model paraphrases its own idea differently each day:
//
//   date 1: "Two-tier architecture for adaptability and stability."
//   date 2: "Two-tier memory design enhances accuracy by combining immediate
//            and historical data"
//   date 3: "Two-tier design: session memory for real-time, evidence-gated
//            patterns index for verified knowledge."
//
// Those are the same durable fact. findNearDuplicatePatternId
// (polymem.mjs:696) matches on shared tokens + containment >= 0.9, so three
// divergent phrasings of one idea score below the bar and never merge.
//
// WHY THIS IS A FINDING AND NOT A HARNESS ARTEFACT. This script feeds the
// model its OWN previous pattern names, which is what a real bot with memory
// does: it reads back what it wrote. If the model then repeats its earlier
// wording, the bar is reachable and the harness's traffic was the problem. If it
// re-paraphrases even with the earlier names in its context, then no amount of
// realistic traffic promotes anything, and `established` is effectively dead
// code for any model-written memory.
//
// That distinction is the whole point, so the script runs BOTH halves and
// prints which one happened. It asserts nothing — the verdict is the data.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LLAM = fileURLToPath(new URL('./llm.mjs', import.meta.url));
const { generate } = await import(LLAM);
const { PERSONAS, TOPIC_POOL, personaPrompt } = await import(fileURLToPath(new URL('./personas.mjs', import.meta.url)));

const ROOT = mkdtempSync(join(tmpdir(), 'polymem-bar-'));
const HOME = join(ROOT, 'home');
mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.OMEGA_MEMORY_INDEX = join(ROOT, 'patterns-index.json');
process.env.OMEGA_MEMORY_SESSIONS_DIR = join(ROOT, 'sessions');
mkdirSync(process.env.OMEGA_MEMORY_SESSIONS_DIR, { recursive: true });

const m = await import(fileURLToPath(new URL('../src/index.mjs', import.meta.url)));

const persona = PERSONAS.find(p => p.id === 'knowledgeable');
const topic = TOPIC_POOL.find(t => t.domain === 'ops') || TOPIC_POOL[0];
const DATES = ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'];

const seenNames = [];   // every name this persona has ever promoted, fed back below

for (const date of DATES) {
  // Readback: hand the model what it wrote last time. This is the "bot with
  // memory" case and the honest test of whether paraphrasing is the blocker.
  const recall = seenNames.length
    ? `\n\nIn earlier sessions you wrote these. Reuse their exact wording where they still apply — do not paraphrase them:\n${seenNames.map(n => `- ${n}`).join('\n')}`
    : '';

  const prompt = personaPrompt(persona, topic, date) + recall;
  const raw = await generate({ system: persona.system, prompt, numPredict: 1100 });

  if (!raw.includes('```memory')) { console.log(`${date}  NO FENCE (${raw.length} chars)`); continue; }
  const parsed = m.parseMemoryBlock(raw);
  const mem = parsed.memory;
  if (!mem) { console.log(`${date}  UNPARSEABLE`); continue; }

  m.appendWorkingMemory(date, {
    time: new Date().toISOString(),
    agent: persona.id,
    claims: mem.claims,
    patterns: mem.patterns,
    correspondences: mem.correspondences,
    contradictions: mem.contradictions,
  });
  const idx = m.loadPatternsIndex();
  const r = m.promoteSession(date, idx);

  for (const e of mem.patterns) seenNames.push(e.text);

  const depths = Object.values(idx.patterns).map(p => (p.sessions || []).length);
  console.log(`${date}  patterns=${mem.patterns.length} promoted=${r.promoted.length}  `
    + `index=${Object.keys(idx.patterns).length}  maxSessions=${Math.max(0, ...depths)}  `
    + `established=${Object.values(idx.patterns).filter(p => p.status === 'established').length}`);
}

const final = JSON.parse(readFileSync(process.env.OMEGA_MEMORY_INDEX, 'utf8'));
const all = Object.values(final.patterns || {});
const depths = all.map(p => (p.sessions || []).length);
const maxSessions = Math.max(0, ...depths);
const est = all.filter(p => p.status === 'established');

console.log(`\n${'─'.repeat(72)}`);
console.log(`patterns in index        : ${all.length}`);
console.log(`distinct names written   : ${seenNames.length}`);
console.log(`deepest evidence on any  : ${maxSessions} session(s)  (bar needs 3)`);
console.log(`reached 'established'    : ${est.length}`);
console.log(`consolidation merges     : ${(final.meta?.absorbedPatterns || []).length}`);
console.log(`nameVariations recorded  : ${all.filter(p => (p.nameVariations || []).length).length}`);
console.log();

if (est.length > 0) {
  console.log('VERDICT: reachable. With readback the model repeats its own wording,');
  console.log('evidence accumulates, and the bar is crossed. The sim run\'s 0-established');
  console.log('result was a TRAFFIC artefact of not feeding prior names back.');
} else {
  console.log('VERDICT: NOT reachable even with readback.');
  console.log(`The model re-paraphrases (deepest evidence ${maxSessions} < 3), so dedup cannot`);
  console.log('merge it and nothing ever reaches `established`. For any model-written memory,');
  console.log('the 3-session bar is unreachable unless dedup understands paraphrase — a real');
  console.log('design finding, not a traffic artefact.');
}

// Show the closest pairs, so the claim is arguable from data rather than asserted.
const uniq = [...new Set(seenNames)];
console.log(`\nclosest name pairs by shared tokens (of ${uniq.length} distinct names):`);
const toks = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3));
const pairs = [];
for (let a = 0; a < uniq.length; a++) for (let b = a + 1; b < uniq.length; b++) {
  const A = toks(uniq[a]), B = toks(uniq[b]);
  const shared = [...A].filter(t => B.has(t)).length;
  if (shared >= 2) pairs.push({ shared, a: uniq[a], b: uniq[b] });
}
pairs.sort((x, y) => y.shared - x.shared);
for (const p of pairs.slice(0, 6)) {
  console.log(`  shared=${p.shared}`);
  console.log(`    A: ${p.a.slice(0, 88)}`);
  console.log(`    B: ${p.b.slice(0, 88)}`);
}
if (!pairs.length) console.log('  (no pair shared even 2 content tokens)');
void existsSync;
process.exit(est.length > 0 ? 0 : 1);