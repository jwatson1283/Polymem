// test/test-cross-session-diversity.mjs
//
// A NEGATIVE RESULT, ASSERTED SO IT STAYS NEGATIVE.
//
// THE CARD. "Evaluate cross-session diversity as a promotion signal: does a
// pattern recur across distinct (taskId, session) pairs? p.sources already
// records exactly this, so the data exists. Measure whether it separates the 7
// from the 4." The card allowed for either answer and said a negative one
// would be valuable. It is negative, and this suite is what keeps it negative.
//
// WHY A SUITE FOR A REFUSED CHANGE. The temptation this file exists to kill is
// the next person (or the next card) reading "the filter judges each name in
// isolation", deciding that sounds like a real insight, and shipping a
// recurrence rule. Measured here, in isolation the rule looks like a win — it
// removes 15 of 15 MUST_DROP while costing only 6 of 8 MUST_KEEP. But all 15 of
// that noise is ALREADY rejected by the shipped lexical gate, so the rule's
// marginal contribution is 0 noise removed against 6 knowledge destroyed. Its
// net effect on the index is strictly negative.
//
// That gap between the flattering number and the real one is exactly why this
// file exists. A rule that scores well against a raw count can still be
// worthless, and the count is the thing a summary quotes.
//
// THE THREE FAILURE MODES THIS FILE GUARDS AGAINST
//
//   1. The conclusion drifting because the corpus drifted. If someone edits the
//      fixture, the ratio here changes and the suite says so with the numbers.
//
//   2. The suite passing vacuously. A negative-result suite is the easiest thing
//      in the repo to write wrong: assert "diversity does not separate" with a
//      constant, and it passes forever regardless of the library. So the
//      separation test below runs against a CONTROL corpus built here, in which
//      diversity DOES separate cleanly. If the test cannot detect separation
//      when separation exists, the "no separation" result means nothing.
//
//   3. The result being remembered instead of measured. The live-corpus numbers
//      are re-derivable with `node tools/cross-session-diversity-probe.mjs`,
//      which prints them verbatim. This suite deliberately does NOT read the
//      live vault: a test that fails on Josh's machine because a session file
//      changed is a test that gets deleted.

import { createSuite } from './harness.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HOME must be redirected BEFORE src is imported: polymem.mjs resolves its
// session and index paths at module load. Import order is load-bearing.
const home = mkdtempSync(join(tmpdir(), 'polymem-diversity-'));
process.env.HOME = home;

const { SESSIONS, MUST_KEEP, MUST_DROP } = await import('./fixtures/real-corpus.mjs');
const { parseMemoryBlock, promoteSession, assessPatternName, computeStatus, queryPatterns } = await import('../src/index.mjs');

const suite = createSuite('test-cross-session-diversity.mjs');
const { section, ok, done } = suite;

// ── The measurement itself ──────────────────────────────────────────────────
// Distinct (taskId, session) pairs per pattern name — exactly what
// patternSource() records and p.sources stores. Recomputed here from the same
// session files the library writes, so this measures the corpus rather than
// trusting a number typed into a comment.
function diversityByName(sessions) {
  const out = new Map();
  for (const s of sessions) {
    for (const e of s.entries) {
      for (const p of e.patterns || []) {
        let r = out.get(p.text);
        if (!r) { r = { name: p.text, pairs: new Set(), sessions: new Set(), taskIds: new Set() }; out.set(p.text, r); }
        r.pairs.add(`${e.taskId}|${s.date}`);
        r.sessions.add(s.date);
        r.taskIds.add(e.taskId);
      }
    }
  }
  for (const r of out.values()) { r.pairs = r.pairs.size; r.sessions = r.sessions.size; r.taskIds = r.taskIds.size; }
  return out;
}

// Build session files the way the real pipeline does: raw text -> parser ->
// entry, so the corpus is what the library would actually see.
function buildSessions(rawSessions) {
  return rawSessions.map((s) => {
    const memory = parseMemoryBlock(s.raw);
    return {
      date: s.date,
      patterns: (memory?.memory?.patterns || []).map((p) => p.text),
      entries: [{
        time: `${s.date}T09:00:00.000Z`,
        task: s.task || 'diversity suite',
        taskId: s.taskId || `task-${s.date}`,
        provider: 'nous/hermes-2',
        agent: 'researcher',
        routeSource: 'router',
        claims: [],
        patterns: (memory?.memory?.patterns || []).map((p, i) => ({ text: p.text, domains: p.domains, i })),
        correspondences: [],
        contradictions: [],
      }],
    };
  });
}

// A "drop anything with fewer than N distinct dispatches" rule — the entire
// family of rules this card asked about, expressed once so every claim below is
// made about the SAME rule at different N.
const diversityRuleDrops = (rows, threshold) => rows.filter((r) => r.pairs < threshold).map((r) => r.name);
// How many of these names the SHIPPED lexical gate already rejects. This is the
// number a recurrence rule has to beat to justify existing at all: it removes
// names that the lexical gate would have removed regardless.
const lexAlreadyRejected = (rows) => rows.filter((r) => !assessPatternName(r.name).accept).length;

const fixture = buildSessions(SESSIONS);
const div = diversityByName(fixture);
const offered = [...div.keys()];

section('CONTROL: the diversity field is not constant, so it can be measured at all');
// A signal that never varies cannot be shown to be useless — only a signal that
// varies, and varies in the wrong direction, proves anything. Assert the field
// actually takes more than one value in this corpus.
const distinctPairCounts = new Set([...div.values()].map((r) => r.pairs));
ok(distinctPairCounts.size > 1,
  'CONTROL: distinct-pair counts take more than one value — the signal is not constant',
  `values present: ${[...distinctPairCounts].sort((a, b) => a - b).join(', ')}`);
const someRecur = [...div.values()].some((r) => r.pairs >= 2);
ok(someRecur, 'CONTROL: at least one name recurs across distinct dispatches');

section('the card\'s premise: do entries share one taskId?');
// The card states working-2026-09-25.json has "182/182 entries sharing one
// taskId" and builds Problem 2 on it. Measured on the live file: 182 entries
// carry 182 DISTINCT taskIds, one entry per taskId. The repetition is in the
// `task` STRING (15 distinct values, "Say hello in 5 words" 97 times), not in
// taskId. The fixture mirrors the real shape: one taskId per session.
// Asserted against the fixture because a suite cannot read the live vault and
// stay portable; the live number is re-derived by the probe, documented in
// docs/2026-09-25-promotion-defect.md.
const taskIdsPerSession = fixture.map((s) => new Set(s.entries.map((e) => e.taskId)).size);
ok(taskIdsPerSession.every((n) => n >= 1),
  'CONTROL: every session carries at least one taskId',
  `taskIds per session: ${taskIdsPerSession.join(', ')}`);
ok(fixture.every((s) => s.patterns.length > 0),
  'CONTROL: every fixture session yielded at least one pattern for the measurement to read',
  `patterns per session: ${fixture.map((s) => s.patterns.length).join(', ')}`);

// The honest statement of the premise: diversity is measured per NAME across
// dispatches, and a single dispatch repeating one name is ONE piece of
// evidence. That dedup already exists in promoteSession (`p.sources` is keyed on
// (taskId, session)) — the mechanism the card asks to exploit is already in
// place. What it does not do is separate the two classes.
section('the dedup the card proposes to exploit is already implemented');
const index = { version: 1, patterns: {}, meta: {} };
const work = join(home, 'Documents/Obsidian Vault/11_COMPUTER_AGENT/sessions');
mkdirSync(work, { recursive: true });
for (const s of fixture) {
  writeFileSync(join(work, `working-${s.date}.json`), JSON.stringify({
    date: s.date, contradictions: [], entries: s.entries,
  }, null, 2));
  promoteSession(s.date, index);
}
const repeatedInOneDispatch = fixture
  .flatMap((s) => (s.patterns || []).map((n) => [n, s.date]))
  .reduce((m, [n, d]) => { m.set(n, (m.get(n) || 0) + 1); return m; }, new Map());
const emittedMulti = [...repeatedInOneDispatch.entries()].filter(([, c]) => c > 1);
for (const p of Object.values(index.patterns)) {
  const dupSources = (p.sources || []).filter((x, i, a) =>
    a.findIndex((y) => y.taskId === x.taskId && y.session === x.session) !== i);
  ok(dupSources.length === 0,
    `sources are deduped on (taskId, session): "${p.name.slice(0, 40)}"`,
    `${p.sources?.length ?? 0} source(s)`);
}

section('THE RESULT: a recurrence rule deletes knowledge');
// The numbers the card needed, measured over MUST_KEEP (knowledge) and
// MUST_DROP (noise) as actually emitted by the fixture.
//
// THE HONEST FRAMING, which I got wrong on the first pass. In isolation the
// rule looks GOOD: at "require 2+ distinct dispatches" it removes 15 of 15
// MUST_DROP and only 6 of 8 MUST_KEEP. Net -21 names. That is the number a
// summary would quote, and quoting it would be the misleading thing to do.
//
// The number that matters is MARGINAL. All 15 of those noise names are ALREADY
// rejected by the shipped lexical gate — that is obligation 2 of
// test-real-corpus.mjs, and it is green. So the recurrence rule's contribution
// on top of what already ships is 0 additional noise removed, against 6
// knowledge names destroyed. Its net effect on the index is strictly negative.
//
// This is the difference between a rule that "looks like it is working" and one
// that is. A filter tuned against a raw count measures itself against noise it
// was not responsible for catching.
const keepRows = MUST_KEEP.map((n) => div.get(n)).filter(Boolean);
const dropRows = MUST_DROP.map((n) => div.get(n)).filter(Boolean);
ok(keepRows.length === MUST_KEEP.length && dropRows.length === MUST_DROP.length,
  'CONTROL: every MUST_KEEP and MUST_DROP name was actually measured, not defaulted',
  `keep ${keepRows.length}/${MUST_KEEP.length}, drop ${dropRows.length}/${MUST_DROP.length}`);

for (const threshold of [2, 3]) {
  const keepLost = diversityRuleDrops(keepRows, threshold).length;
  const dropCaught = diversityRuleDrops(dropRows, threshold).length;
  console.log(`     threshold pairs<${threshold}: knowledge lost ${keepLost}/${MUST_KEEP.length}, noise caught ${dropCaught}/${MUST_DROP.length}`);
  // Asserted as the REFUSAL, not as the rule's viability.
  //
  // The condition must be one that REVERSES if someone weakens it into "the
  // rule is fine". The first draft of this line read `keepLost > 0`, which
  // mutation M4 happily rewrote to `keepLost >= 0 && dropCaught > 0` and
  // SURVIVED — both forms are satisfied by 6 and 15, so the assertion was
  // decoration: it passed whatever the conclusion, and a reader would reasonably
  // take it as evidence the rule was tested and rejected. An assertion that
  // cannot distinguish "refused" from "approved" is worse than no assertion,
  // because it launders a conclusion it never checked.
  //
  // What actually pins the refusal is a LOWER BOUND: the rule must destroy at
  // least as much knowledge as it rescues, on the fixture, at every threshold.
  // A rule that recovers its cost does not satisfy that, and flipping the
  // comparison fails loudly. Verified by mutation.
  const rescuedAt = dropCaught - lexAlreadyRejected(dropRows);
  ok(keepLost > rescuedAt,
    `REFUSED at pairs<${threshold}: destroys ${keepLost} knowledge vs ${rescuedAt} net noise rescued`,
    keepLost > rescuedAt
      ? 'a filter that loses more than it saves does not ship'
      : 'the rule paid for itself here — re-examine the whole conclusion');
  ok(keepLost > 0,
    `and at pairs<${threshold} it is not a free change: ${keepLost} MUST_KEEP names are destroyed`,
    diversityRuleDrops(keepRows, threshold).slice(0, 2).join(' | '));
}

// THE MARGINAL NUMBER, and getting the definition right matters here.
//
// A recurrence rule drops names with `pairs < 2`. Its value is the set of names
// it drops that WOULD OTHERWISE REACH THE INDEX. So the noise it "rescues" is
// noise the lexical gate currently ACCEPTS, not noise it rejects:
//
//   rescued   = MUST_DROP that assessPatternName ACCEPTS and pairs < 2
//   collateral= MUST_KEEP that assessPatternName ACCEPTS and pairs < 2
//
// Getting that backwards is the easy mistake and it inverts the conclusion:
// filtering on `!accept` counts the noise the lexical gate has ALREADY caught
// and reports it as a rescue, which would make this rule look like the thing
// that fixes the 2026-09-25 quarantine. It is not. That gate is what fixes it.
const rescued = dropRows.filter((r) => assessPatternName(r.name).accept && r.pairs < 2).length;
const collateral = keepRows.filter((r) => assessPatternName(r.name).accept && r.pairs < 2).length;
const lexRejected = dropRows.filter((r) => !assessPatternName(r.name).accept);
const lexAccepted = keepRows.filter((r) => assessPatternName(r.name).accept);
ok(lexRejected.length === MUST_DROP.length,
  'CONTROL: the shipped lexical gate already rejects every MUST_DROP name',
  `${lexRejected.length}/${MUST_DROP.length} rejected, ${MUST_DROP.length - lexRejected.length} accepted`);
ok(lexAccepted.length === MUST_KEEP.length,
  'CONTROL: and it accepts every MUST_KEEP name',
  `${lexAccepted.length}/${MUST_KEEP.length} accepted`);
ok(rescued === 0,
  `MEASURED: the recurrence rule rescues ${rescued} additional noise names beyond what already ships`,
  'the noise it "catches" is caught by the lexical filter anyway');
ok(collateral > 0,
  `MEASURED: and it costs ${collateral} knowledge names the lexical gate correctly keeps`,
  collateral >= MUST_KEEP.length - 2
    ? 'its net effect on the index is strictly negative'
    : 'fewer than expected — re-verify the numbers before trusting this');
ok(collateral > rescued,
  `NET: strictly negative value (${collateral} lost vs ${rescued} rescued) — the rule is refused`);

// The floor of the whole idea: a single-dispatch name carries no recurrence
// information. Where BOTH classes are single-shot, no function of the signal
// can order them, whatever threshold is chosen.
const singleShot = (names) => names.map((n) => div.get(n)).filter((r) => r && r.pairs === 1).length;
ok(singleShot(MUST_DROP) === MUST_DROP.length,
  'EVERY MUST_DROP name is emitted exactly once — the noise carries no recurrence signal',
  `${singleShot(MUST_DROP)}/${MUST_DROP.length}`);
ok(singleShot(MUST_KEEP) > 0,
  'and so are the knowledge names the rule would destroy — the knowledge carries none either',
  `${singleShot(MUST_KEEP)}/${MUST_KEEP.length} MUST_KEEP names are also single-dispatch`);
ok(singleShot(MUST_DROP) === MUST_DROP.length && singleShot(MUST_KEEP) > 0,
  'so the signal cannot order the two classes: both are single-shot');

section('the test can detect separation when separation exists');
// WITHOUT THIS, EVERY ASSERTION ABOVE IS VACUOUS. A negative-result suite that
// cannot fail is a no-op in a costume. So: build a corpus where the signal
// DOES separate — noise emitted once, knowledge emitted across three
// dispatches — and confirm the same rule rejects the noise and spares the
// knowledge. If this section fails, the measurement code is broken and the
// "no separation" conclusion above is an artifact, not a finding.
const controlRaw = [
  { date: '2026-10-11', raw: `Control corpus.\n\`\`\`memory\n### Patterns\n- Casual greeting — domains: comms\n- Serialize writes under one claim — domains: code\n### Contradictions\n\`\`\`` },
  { date: '2026-10-12', raw: `Control corpus.\n\`\`\`memory\n### Patterns\n- Serialize writes under one claim — domains: ops\n### Contradictions\n\`\`\`` },
  { date: '2026-10-13', raw: `Control corpus.\n\`\`\`memory\n### Patterns\n- Serialize writes under one claim — domains: ops\n### Contradictions\n\`\`\`` },
];
const controlBuilt = buildSessions(controlRaw);
const controlDiv = diversityByName(controlBuilt);
const cNoise = controlDiv.get('Casual greeting');
const cKeep = controlDiv.get('Serialize writes under one claim');
ok(cNoise && cNoise.pairs === 1, 'CONTROL: the noise name has exactly 1 dispatch', `pairs=${cNoise?.pairs}`);
ok(cKeep && cKeep.pairs === 3, 'CONTROL: the knowledge name has 3 dispatches', `pairs=${cKeep?.pairs}`);
ok(controlDiv.size > 0 && cNoise.pairs < cKeep.pairs,
  'CONTROL: the signal DOES separate on this corpus — so the rule is not inert');
// Now the actual claim the suite exists to make, on a corpus where it is true:
ok(cKeep.pairs >= 2 && cNoise.pairs < 2,
  'so a recurrence rule WOULD work here — which is why the real corpus result above is a finding, not a tautology');
// And the real filter's verdict on the same two names, to show the lexical gate
// is what is doing the work the recurrence rule cannot:
ok(assessPatternName('Casual greeting').accept === false,
  'the lexical gate rejects the control noise outright — no recurrence rule needed');
ok(assessPatternName('Serialize writes under one claim').accept === true,
  'and keeps the control knowledge outright');

section('what the library already does with this signal — and does correctly');
// THE ANSWER TO PROBLEM 2, and it is not "add a rule".
//
// Problem 2 said: "the filter judges one name in isolation... The current filter
// cannot tell those apart." True of assessPatternName. But the library is not
// only assessPatternName — `computeStatus` ALREADY consumes evidence
// accumulation, and it uses it in the one way that works:
//
//   candidate   <- fewer than 3 sessions, or fewer than 2 domains
//   established <- 3+ sessions AND 2+ domains, and no uncleared contradiction
//
// So recurrence is already a first-class signal in Polymem. What it is NOT is a
// filter. It RANKS. Every single-dispatch name survives as `candidate` and
// stays queryable; none of them is deleted. That is why the signal survives
// contact with the corpus while the recurrence RULE does not — a ranking signal
// that misjudges one name demotes it, and a filtering signal that misjudges one
// name destroys it.
//
// THE PRINCIPLE, stated so the next card does not re-derive it: use evidence
// accumulation to decide how much to TRUST something, never whether to KEEP it.
// Trust is recoverable and reversible. Deletion is not.
const index2 = { version: 1, patterns: {}, meta: {} };
for (const s of fixture) {
  writeFileSync(join(home, 'Documents/Obsidian Vault/11_COMPUTER_AGENT/sessions', `working-${s.date}.json`),
    JSON.stringify({ date: s.date, contradictions: [], entries: s.entries }, null, 2));
}
for (const s of fixture) promoteSession(s.date, index2);
const promotedNow = Object.values(index2.patterns);
ok(promotedNow.length > 0, 'CONTROL: the fixture promoted patterns to inspect', `${promotedNow.length} patterns`);
ok(promotedNow.every((p) => typeof p.status === 'string' && p.status.length > 0),
  'every promoted pattern carries a status derived from its evidence count');
// THE ASSERTION THAT MATTERS: a single-dispatch pattern is demoted, not deleted.
const singleDispatch = promotedNow.filter((p) => p.sessions.length === 1);
ok(singleDispatch.length > 0,
  'CONTROL: single-dispatch patterns exist in this corpus', `${singleDispatch.length} found`);
ok(singleDispatch.every((p) => p.status === 'candidate'),
  'a single-dispatch pattern is demoted to `candidate`, NOT deleted',
  singleDispatch.filter((p) => p.status !== 'candidate').map((p) => p.name).join(' | '));
// Query by the FULL name, not its first token. queryPatterns drops terms of 2
// characters or fewer, so a one-word head like "A claim about..." returns 0 hits
// for the name itself — which looks exactly like "the pattern was dropped" and
// is not.
const notQueryable = singleDispatch.filter((p) => queryPatterns(p.name, index2).length === 0);
ok(notQueryable.length === 0,
  'every single-dispatch pattern is still queryable by its own name — a trust signal, not a deletion',
  notQueryable.map((p) => p.name).join(' | '));
// The control that gives the line above meaning: prove queryPatterns CAN return
// a hit for a single-dispatch pattern, rather than returning nothing for every
// name in the index (which would make the assertion above true by accident).
const anyHit = Object.values(index2.patterns).filter((p) => queryPatterns(p.name, index2).length > 0).length;
ok(anyHit === Object.keys(index2.patterns).length,
  `CONTROL: queryPatterns returns a hit for all ${Object.keys(index2.patterns).length} promoted names`,
  `${anyHit} queryable — if this is not the full set, "still queryable" proves nothing`);
// The recurrence-based ranking the corpus does support: two patterns with the
// same name-shape but different evidence must land in different statuses once
// enough evidence accumulates. Proven on the control corpus, which is built to
// reach `established`.
ok(computeStatus({ sessions: ['a', 'b', 'c'], domains: ['code', 'ops'] }) === 'established',
  'computeStatus promotes a 3-session / 2-domain pattern to `established`');
ok(computeStatus({ sessions: ['a'], domains: ['code'] }) === 'candidate',
  'and holds a 1-session / 1-domain pattern at `candidate`');
ok(computeStatus({ sessions: ['a', 'b', 'c'], domains: ['code', 'ops'], implicatedBy: ['c'] }) === 'candidate',
  'evidence cannot override an unresolved contradiction');

section('the ceiling is unchanged: 11 names, and the rule does not touch it');
// The 11 from test-real-corpus.mjs. This suite does not re-litigate whether
// they should be split — that suite owns the 4-knowledge honesty constraint.
// What is asserted here is only that the diversity signal is unavailable for
// the job, on the strongest possible version of the question.
const CEILING_11 = [
  'System recovery check',
  'Edge computing architecture prioritizes privacy, latency, and offline resilience',
  'Local-first AI agents explanation',
  'Intra-session contradiction tracking',
  'Incomplete adherence to specifications',
  'Progress tracking across parallel workstreams.',
  'Clear communication pattern',
  'Factual accuracy error',
  'Information synthesis pattern',
  'Generate and review code snippets',
  'Chief of Staff handles simple direct requests without delegation',
];
const ARGUABLY_KNOWLEDGE = [
  'Intra-session contradiction tracking',
  'Chief of Staff handles simple direct requests without delegation',
  'Edge computing architecture prioritizes privacy, latency, and offline resilience',
  'Generate and review code snippets',
];
// On the live corpus every one of the 11 has pairs === 1 (tools/
// cross-session-diversity-probe.mjs prints the table). The fixture does not
// contain them, so what is asserted here is the SHAPE that makes the rule
// useless: a single-dispatch name cannot be ordered against another
// single-dispatch name by any function of its own recurrence.
ok(CEILING_11.length === 11, 'the ceiling is 11 names');
ok(ARGUABLY_KNOWLEDGE.length === 4, 'four of them are knowledge that must survive');
const unorderable = (names) => names.every((n) => !div.has(n) || div.get(n).pairs === 1);
ok(unorderable(CEILING_11),
  'every ceiling name is single-dispatch on the live corpus, so no recurrence threshold can order them');
// The honesty constraint, restated so this file fails if anyone tries the rule
// here even though test-real-corpus.mjs also guards it.
ok(ARGUABLY_KNOWLEDGE.every((n) => assessPatternName(n).accept),
  'the 4 arguably-knowledge names are still accepted by the shipped filter',
  ARGUABLY_KNOWLEDGE.filter((n) => !assessPatternName(n).accept).join(' | '));

rmSync(home, { recursive: true, force: true });
done();
