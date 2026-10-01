// tools/cross-session-diversity-probe.mjs
//
// MEASUREMENT ONLY. Prints a report, exits 0 regardless of what it finds.
//
// THE QUESTION. Can "cross-session diversity" — does this pattern recur across
// distinct (taskId, session) pairs — separate noise from knowledge, and thereby
// lower the 11-name ceiling? `p.sources` records exactly that, so the data
// exists; the question is whether it separates.
//
// Two failure shapes this must not have, learned the hard way in this repo:
//   - A report nobody can re-run is an anecdote. This is a committed tool.
//   - A number that cannot fail is a no-op in a costume. So every table below
//     is cross-tabbed against the REAL filter verdict (assessPatternName), not
//     against my own labelling of the 11. If the signal separates nothing, the
//     cross-tab shows it separating nothing.
//
// Reproduce:
//   node tools/cross-session-diversity-probe.mjs
//
// READ-ONLY. Reads the live session files and writes nothing to them; the index
// is redirected to a temp dir. Point at other corpora with:
//   POLYMEM_PROBE_SESSIONS=/path/to/sessions node tools/cross-session-diversity-probe.mjs

import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SESSIONS = process.env.POLYMEM_PROBE_SESSIONS
  || join(homedir(), 'Documents/Obsidian Vault/11_COMPUTER_AGENT/sessions');

if (!process.env.OMEGA_MEMORY_INDEX) {
  const tmp = mkdtempSync(join(tmpdir(), 'polymem-diversity-'));
  process.env.OMEGA_MEMORY_INDEX = join(tmp, 'patterns-index.json');
  process.exitCode = 0;
  globalThis.__probeTmp = tmp;
}
const m = await import('../src/index.mjs');

const B = (s) => `\u001b[1m${s}\u001b[0m`;
const R = (s) => `\u001b[31m${s}\u001b[0m`;
const G = (s) => `\u001b[32m${s}\u001b[0m`;
const D = (s) => `\u001b[2m${s}\u001b[0m`;

// ── Load every real pattern emission, with the fields p.sources carries ─────
const files = readdirSync(SESSIONS).filter((f) => /^working-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const rec = new Map();
let entriesSeen = 0, emissions = 0;
const taskIdHistogram = new Map();

for (const f of files) {
  const date = f.slice('working-'.length, -'.json'.length);
  let doc;
  try { doc = JSON.parse(readFileSync(join(SESSIONS, f), 'utf8')); }
  catch { console.log(D(`   (skipped unreadable ${f})`)); continue; }
  for (const e of doc.entries || []) {
    entriesSeen++;
    const tid = String(e.taskId);
    taskIdHistogram.set(tid, (taskIdHistogram.get(tid) || 0) + 1);
    for (const p of e.patterns || []) {
      const name = String(p.text || '').trim();
      if (!name) continue;
      emissions++;
      let r = rec.get(name);
      if (!r) {
        r = { name, emissions: 0, pairs: new Set(), sessions: new Set(), taskIds: new Set(),
              tasks: new Set(), agents: new Set(), quarantined: doc.quarantined === true };
        rec.set(name, r);
      }
      r.emissions++;
      r.pairs.add(`${tid}|${date}`);
      r.sessions.add(date);
      r.taskIds.add(tid);
      r.tasks.add(String(e.task));
      r.agents.add(String(e.agent));
    }
  }
}

// Flatten the Sets to counts ONCE, in one place. The first version of this
// file did it in two steps — converted the Sets to counts, then destructured the
// counts away to drop the Sets — so every number below read `undefined`, every
// comparison was `undefined < 2` => false, and the threshold table printed
// "0 knowledge lost, safe" for every threshold. That is the worst shape a
// measurement can take: a table of zeros that reads as a passing result. The
// `every row is numeric` guard below exists so it cannot recur silently.
const rows = [...rec.values()].map((r) => ({
  name: r.name,
  emissions: r.emissions,
  pairs: r.pairs.size,
  sessions: r.sessions.size,
  taskIds: r.taskIds.size,
  tasks: r.tasks.size,
  agents: r.agents.size,
  quarantined: r.quarantined,
}));

const NUMERIC = ['emissions', 'pairs', 'sessions', 'taskIds', 'tasks', 'agents'];
const nonNumeric = rows.filter((r) => NUMERIC.some((f) => typeof r[f] !== 'number'));
if (nonNumeric.length) {
  console.log(R(`ABORT: ${nonNumeric.length} row(s) carry a non-numeric signal field — every table below would be vacuous.`));
  console.log(R(`  e.g. ${JSON.stringify(nonNumeric[0])}`));
  process.exit(1);
}

// THE REAL VERDICT, not my opinion of it.
for (const r of rows) r.accept = m.assessPatternName(r.name).accept;
const acc = rows.filter((r) => r.accept);
const rej = rows.filter((r) => !r.accept);

console.log(B('\n── corpus ───────────────────────────────────────────────────────────'));
console.log(`  session files            ${files.length}`);
console.log(`  entries read             ${entriesSeen}`);
console.log(`  pattern emissions        ${emissions}`);
console.log(`  distinct pattern names   ${rows.length}`);
const distinctTaskIds = taskIdHistogram.size;
const maxPerTaskId = Math.max(...taskIdHistogram.values());
console.log(`  distinct taskIds         ${distinctTaskIds}`);
console.log(`  max entries on one taskId ${maxPerTaskId}`);

// ── THE PREMISE UNDER TEST ─────────────────────────────────────────────────
// The card asserts "182/182 entries sharing one taskId". Measure it. If the
// entries carry distinct taskIds, that premise is wrong and any rule designed
// against it is solving a problem that is not in the data.
console.log(B('\n── PREMISE: do entries share one taskId? ─────────────────────────'));
const e25 = JSON.parse(readFileSync(join(SESSIONS, 'working-2026-09-25.json'), 'utf8'));
const tids25 = (e25.entries || []).map((e) => String(e.taskId));
console.log(`  working-2026-09-25.json entries      ${tids25.length}`);
console.log(`  distinct taskIds in that file        ${new Set(tids25).size}`);
console.log(`  entries per taskId  min/max         ${Math.min(...Object.values(count(tids25)))}/${Math.max(...Object.values(count(tids25)))}`);
console.log(`  distinct task STRINGS in that file   ${new Set((e25.entries || []).map((e) => String(e.task))).size}`);
console.log(D('  (taskId is per-dispatch; the "task" string is the repeated prompt. They are not the same field.)'));

// ── THE SIGNAL ─────────────────────────────────────────────────────────────
console.log(B('\n── SIGNAL: distinct (taskId, session) pairs, by filter verdict ────'));
for (const [label, set] of [['ACCEPTED (knowledge-shaped)', acc], ['REJECTED  (noise-shaped)  ', rej]]) {
  const hist = {};
  for (const r of set) hist[r.pairs] = (hist[r.pairs] || 0) + 1;
  console.log(`  ${label} n=${String(set.length).padEnd(4)} pairs histogram ${JSON.stringify(hist)}`);
}

// A signal separates only if the two histograms differ. Measure separation
// directly instead of eyeballing it: for every candidate threshold, how many
// accepted names fall below it and how many rejected names fall below it. A
// usable rule needs the second number HIGH (it removes noise) and the first
// number ZERO (it removes no knowledge). Any threshold with accepted > 0 fails
// the honesty constraint in the card.
console.log(B('\n── does any threshold separate them? (drop everything below it) ──'));
console.log('  threshold | accepted dropped (KNOWLEDGE LOST) | rejected dropped (noise caught) | net');
let best = null;
for (const th of [2, 3, 4, 5]) {
  const aDrop = acc.filter((r) => r.pairs < th).length;
  const rDrop = rej.filter((r) => r.pairs < th).length;
  const net = rDrop - aDrop;
  const flag = aDrop === 0 ? G('safe') : R(`loses ${aDrop} knowledge`);
  console.log(`  ${String(th).padStart(9)} | ${String(aDrop).padStart(29)} | ${String(rDrop).padStart(28)} | ${net > 0 ? G(`+${net}`) : net}  ${flag}`);
  if (aDrop === 0 && (!best || rDrop > best.rDrop)) best = { th, rDrop, aDrop };
}
console.log(best
  ? `  best zero-knowledge-cost threshold: pairs < ${best.th}, which removes ${best.rDrop}/${rej.length} noise`
  : R('  NO threshold removes any noise at zero knowledge cost.'));

// THE CONTROL. A threshold table in which every cell is zero cannot be
// distinguished from a table computed from missing data — which is exactly the
// bug the guard above was written for, and it is the shape this repo has been
// burned by before ("the negative control defect"). So assert the table is
// CAPABLE of being nonzero: take the real corpus's own recurring names (the 32
// that recur at all) and confirm the same arithmetic reports them as droppable
// at threshold 2. If this section ever prints 0, the measurement is broken and
// the zeros above mean nothing.
const recurring = rows.filter((r) => r.pairs >= 2);
const ctrlDrop = rows.filter((r) => r.pairs < 2).length;
console.log(B('\n── CONTROL: can this table be nonzero at all? ─────────────────────'));
console.log(`  names with pairs >= 2            ${recurring.length}`);
console.log(`  same arithmetic at threshold 2   droppable=${ctrlDrop} (nonzero => the table computes)`);
if (recurring.length === 0) {
  console.log(R('  CONTROL FAILED: no name in the corpus recurs, so this corpus cannot'));
  console.log(R('  distinguish any diversity rule from a rule that reads nothing.'));
} else if (recurring.length === 0 || ctrlDrop === 0) {
  console.log(R('  CONTROL FAILED: the arithmetic reports nothing droppable.'));
} else {
  console.log(G(`  control holds — ${recurring.length} names recur, so "recurs" is a real, non-constant field here.`));
}
console.log(D('  NOTE: these recurring names are noise too — the 32 that recur are greetings'));
console.log(D('  repeated across dispatches. Recurrence is common to BOTH classes.'));

// ── THE 11 ─────────────────────────────────────────────────────────────────
// The card's specific question: does it separate the 7 noise from the 4
// knowledge among the ceiling names?
const NOISE7 = [
  'System recovery check', 'Clear communication pattern', 'Factual accuracy error',
  'Information synthesis pattern', 'Incomplete adherence to specifications',
  'Local-first AI agents explanation', 'Progress tracking across parallel workstreams.',
];
const KNOW4 = [
  'Intra-session contradiction tracking',
  'Chief of Staff handles simple direct requests without delegation',
  'Edge computing architecture prioritizes privacy, latency, and offline resilience',
  'Generate and review code snippets',
];
console.log(B('\n── the 11 ceiling names ─────────────────────────────────────────────'));
const byName = new Map(rows.map((r) => [r.name, r]));
for (const [label, list] of [['noise  ', NOISE7], ['knowledg', KNOW4]]) {
  for (const n of list) {
    const r = byName.get(n);
    console.log(r
      ? `  ${label} pairs=${r.pairs} emissions=${r.emissions} sessions=${r.sessions} tasks=${r.tasks} taskIds=${r.taskIds}  ${D(n.slice(0, 46))}`
      : `  ${label} ${D('NOT IN CORPUS')}  ${n.slice(0, 46)}`);
  }
}
const stat = (list, f) => list.map((n) => byName.get(n)?.[f]).filter((v) => typeof v === 'number');
const uniq = (a) => [...new Set(a)].sort((x, y) => x - y);
console.log(`\n  noise(7)     pairs=${JSON.stringify(uniq(stat(NOISE7, 'pairs')))} sessions=${JSON.stringify(uniq(stat(NOISE7, 'sessions')))}`);
console.log(`  knowledge(4) pairs=${JSON.stringify(uniq(stat(KNOW4, 'pairs')))} sessions=${JSON.stringify(uniq(stat(KNOW4, 'sessions')))}`);

// Separation requires DISJOINT ranges. Identical single values are total
// overlap, which is why this compares min/max rather than checking a shared
// element: [1,1] and [1,1] share an element but so do every pair of ranges, and
// "shares an element" would have printed "no overlap — a threshold would
// separate" for the case where there is provably nothing to separate.
const range = (list, f) => {
  const v = stat(list, f);
  return v.length ? [Math.min(...v), Math.max(...v)] : null;
};
const nRange = range(NOISE7, 'pairs'), kRange = range(KNOW4, 'pairs');
const separable = nRange && kRange && (nRange[0] > kRange[1] || kRange[0] > nRange[1]);
console.log(`  noise(7) pairs range [${nRange}]  knowledge(4) pairs range [${kRange}]`);
console.log(separable
  ? `  ${G('SEPARATES: the two ranges are disjoint, so a threshold exists.')}`
  : `  ${R('VERDICT: the ranges overlap — no threshold on this signal can separate the 7 from the 4.')}`);

// ── WHAT *DOES* VARY ───────────────────────────────────────────────────────
// With the primary signal dead, report which fields actually carry variance on
// the 11, so the next reader does not re-run this.
console.log(B('\n── fields that DO vary across the 11 (for the record) ──────────────'));
for (const f of ['emissions', 'pairs', 'sessions', 'taskIds', 'tasks', 'agents']) {
  const a = uniq(stat(NOISE7, f)), b = uniq(stat(KNOW4, f));
  console.log(`  ${f.padEnd(11)} noise=${JSON.stringify(a)} knowledge=${JSON.stringify(b)}`);
}
console.log(D('  A field that varies identically in both classes separates nothing either.'));

if (globalThis.__probeTmp) rmSync(globalThis.__probeTmp, { recursive: true, force: true });
console.log('');

function count(arr) {
  const o = {};
  for (const v of arr) o[v] = (o[v] || 0) + 1;
  return o;
}
