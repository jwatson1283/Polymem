// sim/classify.mjs — deciding whether a promoted pattern is KNOWLEDGE or NOISE,
// and showing the reasoning.
//
// WHY AN LLM JUDGE AND NOT A REGEX. The question "is this a durable fact or a
// moment?" is the exact question the library's own filter is trying to answer,
// and grading the library with a copy of its own rules measures nothing — it
// would agree by construction. An independent model, asked the classification
// question with no knowledge of Polymem's REJECT table, can disagree with the
// library. When it does, that disagreement IS the finding.
//
// WHY THE REASON IS MANDATORY. A verdict without a reason is unfalsifiable: the
// next person to read this report cannot tell a real catch from a misfire, and
// the first misfire will be waved through because the number looked plausible.
// The reason is carried all the way to the JSON.
//
// CALIBRATION IS NOT OPTIONAL. Before any verdict is recorded, the judge is run
// over a labelled set whose answers are not in dispute. If it cannot get the
// easy ones right, its verdict on a real pattern carries no information and the
// run says so instead of pretending otherwise.

import { judge } from './llm.mjs';

// Undisputed by construction: the first is a mechanism, the second is an event.
const CALIBRATION = [
  { name: 'a unique temp path plus rename makes a write atomic under concurrent writers', label: 'knowledge' },
  { name: 'a session date used as a filename must be validated or it becomes a path primitive', label: 'knowledge' },
  { name: 'the run completed the 5-word greeting task', label: 'noise' },
  { name: 'this should have been 5 words', label: 'noise' },
  { name: 'the user requested a 5-word greeting', label: 'noise' },
  { name: 'connection is live', label: 'noise' },
];

const JUDGE_SYSTEM = `You classify a single short bullet, taken from an AI agent's long-term memory index, as one of exactly two labels:

"knowledge" = a durable, reusable statement about how a system or the world behaves. It names a mechanism, a rule, a constraint, or a trade-off, and it will plausibly still be true next month. It is not about a specific moment, a specific response, or a specific request.

"noise" = a record of a moment, a request, a self-evaluation, or a piece of infrastructure status. "the user asked for X", "I responded with 5 words", "tests are running", "the API key is not configured", "task completed". These are true when written and useless later.

Answer with JSON only: {"label":"knowledge"|"noise","confidence":0.0-1.0,"reason":"one sentence, max 20 words"}.

Decide on the BULLET ALONE. Do not reward a bullet for sounding technical, and do not punish one for being short. The question is only whether it will still be useful in a month. When genuinely torn, say "noise" and give confidence below 0.6.`;

async function judgeOne(name) {
  const v = await judge({
    system: JUDGE_SYSTEM,
    prompt: `Classify this bullet:\n\n${name}`,
    numPredict: 300,
  });
  const label = v?.label === 'knowledge' ? 'knowledge' : v?.label === 'noise' ? 'noise' : null;
  const confidence = Number.isFinite(Number(v?.confidence)) ? Number(v.confidence) : null;
  return {
    label,
    confidence,
    reason: typeof v?.reason === 'string' ? v.reason.trim().slice(0, 200) : '(judge gave no reason)',
  };
}

export async function calibrateJudge() {
  const results = [];
  for (const c of CALIBRATION) {
    let got;
    try {
      got = await judgeOne(c.name);
    } catch (e) {
      return { ok: false, error: e.message, results };
    }
    results.push({ name: c.name, expected: c.label, got: got.label, confidence: got.confidence, reason: got.reason });
  }
  const correct = results.filter(r => r.got === r.expected).length;
  return { ok: correct === results.length, correct, total: results.length, results };
}

// Classify every promoted pattern once. Sequentially on purpose: the judge is a
// 14B model on a shared GPU, and N parallel requests would queue behind each
// other anyway while making a rate-limit failure look like a hang.
export async function classifyPromoted(patterns) {
  const out = [];
  for (const p of patterns) {
    try {
      out.push({ id: p.id, name: p.name, ...(await judgeOne(p.name)) });
    } catch (e) {
      out.push({ id: p.id, name: p.name, label: null, confidence: null, reason: `judge failed: ${e.message}` });
    }
  }
  return out;
}
