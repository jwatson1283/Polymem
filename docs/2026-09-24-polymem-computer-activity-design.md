# Polymem for Computer Activity — Design Pass

*For @hermes, @sparks, @smith. Planning only — no code, no file edits.*

**Context:** Josh's vision (locked 2026-09-24) says Omega watches the user's screen continuously and learns from what they DO, not just from agent output. Polymem currently learns from agent-authored memory blocks. This document designs the transition.

**Reading:** `docs/product-vision.md` (Josh's 12 locked decisions), `docs/plans/2026-09-23-polymathic-memory-plan.md` (current two-tier memory architecture).

---

## A. Polymem Data Model for Computer Activity

### The core problem

Current Polymem learns from **deliberate, structured agent output** — an agent writes a ````memory` block with claims, patterns, correspondences, contradictions. The agent knows what it's saying and why.

Computer activity observation is **passive, noisy, continuous, and low-signal-per-event**. A window title change is not a claim. A 40-minute session in an app is not a pattern. A file move is not a correspondence.

The observation tier must be a **new tier above the current working memory tier**, not a replacement for it. Otherwise you conflate "I saw the user open Xcode" with "the user works in Xcode daily" — and you will build a confident wrong model.

### Three-tier model: Observe → Claim → Pattern

```
TIER 0 — RAW OBSERVATION (per-event, high volume, ephemeral)
  What: raw captures from screenshot OCR + accessibility tree + window events
  Schema:
    - observationId: uuid
    - timestamp: ISO
    - source: "screenshot-ocr" | "accessibility-tree" | "window-event" | "file-event" | "process-event"
    - rawCapture: { what was observed verbatim — window title, URL, file path, app name, etc. }
    - context: { active app, focused window, time of day, day of week, sessionId }
    - derivedHint: null | { suggestedClaim?: string, suggestedDomain?: string }  // LLM-generated, unverified
  Lifetime: 7 days rolling window, then discarded (was context, not knowledge)
  Confidence: N/A — raw events have no truth value, they're signals

TIER 1 — DERIVED CLAIM (low volume, confidence-weighted)
  What: a confidence-weighted statement about the user's behavior, preference, habit, or workflow
  Schema:
    - claimId: uuid
    - text: natural language statement (e.g. "The user opens Xcode within 10 minutes of starting work on most weekdays")
    - domain: normalized domain tag (work, code, design, finance, comms, ops, personal, health — from user's category set, Q6)
    - observationCount: number of raw observations that contributed
    - firstSeen: ISO timestamp
    - lastSeen: ISO timestamp
    - confidence: 0.0–1.0 (derived from: observation count, consistency across sessions, explicit user confirmation, absence of contradiction)
    - status: "tentative" | "observed" | "confirmed" | "contradicted"
    - explicitConfirmations: number of times the user explicitly confirmed this (0 until they do)
    - contradictions: [claimId, ...] — claims that conflict with this one
    - parentObservations: [observationId, ...] — raw events that contributed (traceable)
    - source: "observed" | "inferred" | "user-stated" | "agent-inferred"
  Lifetime: persists until contradicted, confirmed, or explicitly discarded by user
  Promotion requirement: see below — never promoted to Tier 2 from Tier 1 alone

TIER 2 — PATTERN (the existing long-term structural tier, now with observation-derived entries)
  What: a durable pattern about the user's work, behavior, preferences, or workflow — promoted from Tier 1 claims
  Schema: same as current patterns index, plus:
    - patternId, name, domains[], sessions[], evidenceCount, status (candidate/established/contradicted)
    - NEW: observationSourceCount — number of raw observation sessions that contributed (distinct from agent sessions)
    - NEW: userConfirmed: boolean — did the user ever confirm this?
    - NEW: lastChallenge: ISO — when was this last challenged by a contradiction?
  Promotion criteria: DISTINCT from agent-output promotion. See below.

TIER 3 — CORRESPONDENCE (cross-domain link between patterns)
  What: a structural-correspondence link between two patterns in different domains
  Schema:
    - correspondenceId: uuid
    - sourcePattern: patternId
    - targetPattern: patternId
    - structuralInvariant: what the two patterns share structurally (not just vocabulary)
    - domains: [sourceDomain, targetDomain]
    - confidence: 0.0–1.0
    - source: "agent-noted" | "automatically-detected" | "user-noted"
  Lifetime: persists until contradicted or removed
```

### How an observed action becomes a structured claim

**Example: user opens Xcode and works for 40 minutes**

1. **Raw observation (Tier 0):** `window-event` fires — "Xcode" becomes frontmost app at 09:12. Accessibility tree reads: active document is "InvoiceGenerator/ViewController.swift". Screenshot OCR confirms no alert dialogs, no error states. Process "Xcode" is consuming 1.2GB RAM. Duration tracking starts.

2. **Aggregation window (not immediate):** The observation is stored as Tier 0 raw. Nothing is claimed yet. The system waits for the session to end or for a pattern to emerge across multiple observations.

3. **End-of-session derivation (Tier 1 candidate):** At session end (or if a contradiction is detected mid-session), the system derives candidate claims:
   - "User worked in Xcode for 40 minutes with focus on InvoiceGenerator/ViewController.swift" — domain: code, confidence: 0.85 (high — directly observed), status: tentative
   - "User spends morning hours in Xcode on weekdays" — domain: work, confidence: 0.45 (this is a generalization from one session — low confidence, needs repetition), status: tentative
   - "User is working on an invoice feature" — domain: code, confidence: 0.30 (inferred from file name + no other context — speculative), status: tentative

4. **Cross-session accumulation:** Next time the user opens Xcode in the morning, the "morning hours in Xcode" claim gets +1 observationCount, confidence bumps to 0.55. After 5 sessions with the same pattern, confidence crosses the promotion threshold.

5. **Promotion to Tier 2 (Pattern):** Only when confidence crosses threshold AND the claim has been observed across multiple sessions AND no contradiction has been raised. The pattern "User works in Xcode on weekday mornings" becomes established.

### Promotion criteria for passive observation (distinct from agent output)

This is the critical difference. Agent-output promotion uses: N sessions OR M domains. Observational promotion must be stricter because the source is noisier and the cost of being wrong is higher (you're building a model of the user's actual behavior).

**Observational promotion gate (new — not in current plan):**

A Tier 1 claim promotes to Tier 2 Pattern when ALL of the following are true:

1. **Repetition threshold:** observed in at least 3 distinct sessions (not just 3 observations — 3 separate days or contexts)
2. **Context diversity:** observed in at least 2 distinct contexts (e.g. weekday morning + weekday afternoon, or work session + personal session)
3. **Confidence floor:** confidence ≥ 0.60 (calculated from observation count + consistency + absence of contradiction)
4. **No active contradiction:** no Tier 1 or Tier 2 claim currently contradicts this one with confidence ≥ 0.40
5. **User boundary check:** the claim's domain is within the user's active category set (Q6 — user-held boundary)

**Why this is stricter than agent promotion:** An agent stating "I used copy-on-write with atomic rename" is deliberate and verifiable. An observation claiming "the user always works in Xcode in the morning" is inferential and could be wrong for many reasons (the user was debugging a one-off issue, the user was working on something time-sensitive, etc.). The gate prevents premature confident models.

### The obvious failure: confident wrong model from a week of noise

This is the failure mode Josh implicitly flagged. The system watches for a week, observes the user opening Xcode every morning, and concludes "the user is a macOS developer who works in Xcode daily." Then it turns out the user was fixing a one-off Swift issue for a friend and doesn't actually work in Xcode.

**Prevention layers:**

1. **Confidence decays without reinforcement:** a claim not re-observed for 14 days loses 0.10 confidence per day. After 14 days of silence, an unconfirmed claim drops below the promotion threshold automatically. This prevents "one week of noise becomes a permanent false model."

2. **Default to tentative, never jump to established from observation alone:** observational claims max out at "observed" status (not "established") unless the user explicitly confirms them. The established tier is reserved for patterns the user has validated or that have survived long-term cross-session consistency + agent corroboration.

3. **Contradiction is the reset, not the punishment:** if a claim is contradicted, it doesn't get deleted — it gets demoted to "contradicted" status with a recorded contradiction reason. The system can revisit it later if new observations resolve the contradiction. This prevents the system from silently forgetting things it got wrong and then re-learning the same wrong thing.

4. **User confirmation is the real promotion trigger:** the most important layer. When Omega surfaces a claim to the user for confirmation (see D — onboarding, and the contradiction resolution flow in B), and the user says "yes, that's right," that claim jumps to "confirmed" status and gets a fast track to established. The user is the truth source. Everything else is inference.

5. **The "you're wrong" escape hatch:** the user must be able to say "no, that's not how I work" about any claim or pattern at any time. That immediately demotes it to "contradicted by user" with high confidence, and the system logs the correction as a training signal. This is the ultimate safety valve and must be frictionless.

### What is captured vs. what is derived vs. what is promoted

| Level | Captured | Derived | Promoted |
|---|---|---|---|
| Tier 0 (raw) | Window title, URL, file path, app name, duration, time of day, accessibility tree state, screenshot OCR snippets | suggestedClaim (LLM hint, unverified) | Nothing |
| Tier 1 (claim) | Aggregated observations, confidence score, status, contradiction links | The claim text itself, domain, source classification | To Tier 2 if gate passed |
| Tier 2 (pattern) | Pattern name, domains, sessions, evidence count, status | Cross-session consistency, domain normalization | To Tier 3 correspondence if structural match found |
| Tier 3 (correspondence) | Structural invariant, source/target patterns, domain pair | Confidence | To user-facing insight if confidence high |

---

## B. Contradiction at Scale

### The problem

At continuous-observation scale, contradictions will be constant. Most will be trivial: "user opened Safari at 9:00 AM on Tuesday" vs. "user opened Chrome at 9:00 AM on Tuesday" — but the accessibility tree also showed Safari was backgrounded at 9:00 AM, so the observation was stale. The system flagged a contradiction that's just observation noise.

If every contradiction surfaces to the user, Omega becomes an interruption machine. If the system silently resolves everything, it may silently build wrong models.

### Triage policy: three levels

**Level 1 — Noise (auto-resolved, no one notified)**

Criteria:
- The contradiction is between two Tier 0 observations (not claims or patterns)
- One observation is clearly stale (timestamp older than 60 seconds, or source is screenshot OCR with no accessibility tree corroboration)
- The contradiction is within tolerance (same app, different window title — normal)
- The contradicting claims are both low-confidence (< 0.40)

Resolution: the system picks the higher-confidence or fresher observation and logs the resolution reason. No UI surface. No agent involvement.

**Level 2 — Agent-resolved (agent notified, user NOT notified unless agent can't resolve)**

Criteria:
- The contradiction is between two Tier 1 claims with confidence ≥ 0.40
- OR the contradiction is between a Tier 1 claim and a Tier 2 pattern
- OR the contradiction involves a user preference or behavior claim (domain: work, personal, finance, health — the "about the user" domains)

Resolution: an agent (ops or reviewer) is notified with the contradiction pair and context. The agent has 60 seconds to resolve it silently:
- Check temporal context: did the user switch contexts? Is one claim time-bounded?
- Check observation provenance: which claim has more/diverse observations?
- Check for reconciliation: can both claims be true in different contexts? (e.g. "user prefers Safari for research" vs. "user used Chrome for this task" — both can be true if the user context-switches)

If the agent resolves it: the losing claim gets demoted or context-qualified, the winning claim gets a confidence bump. User sees nothing.

If the agent CANNOT resolve it (genuine ambiguity): escalate to Level 3.

**Level 3 — User-involved (user gets a single focused question, not a dump)**

Criteria:
- The contradiction involves a claim about the user's preference, behavior, or workflow that the system cannot resolve
- OR the contradiction has persisted for more than 24 hours at Level 2 without resolution
- OR the contradiction is between two confirmed claims (confidence ≥ 0.70 and userConfirmed: true)

Resolution: the user gets ONE focused surface — not a contradiction dump. The surface shows:
- "I noticed something that doesn't add up. Can you help me understand?"
- The two conflicting statements, phrased as observations not accusations
- Two choices: "A is right" / "B is right" / "It depends — tell me when"

The user answers in one interaction. The system updates the claims accordingly. Done.

**NOT a Level 3 trigger:** a contradiction between two low-confidence observed claims about something the user doesn't care about (e.g. two different estimates of how long they spent in an app). That's Level 1 or 2.

### Who resolves a real contradiction

**Default: the agent.** The agent has the context (both claims, both observation histories, the user's stated preferences, the current session context). Most contradictions are resolvable by an agent with access to the observation log.

**User-involved only when:** the contradiction is about the user's own preference or behavior, AND the agent cannot determine which is correct from the available evidence. This is the honest line. The system should not ask the user about contradictions it can resolve.

### What the user interaction looks like (without becoming an interruption tax)

The user interaction must be:
- **Single-question, not a panel:** one contradiction, one question, one answer. No "here are all your contradictions" dashboard.
- **Spatially surfaced, not a popup:** in the spatial interface, a contradiction reaches the user as a node on the orb or a pulse — something they notice when they look, not something that interrupts what they're doing. The command bar can surface it when they engage.
- **Non-blocking:** the user can ignore it and come back later. Contradictions don't block agent work.
- **Answerable in one sentence:** "I usually use Safari for research, not Chrome" resolves both claims at once.

### Contradiction budget

This is a product liability question. If Omega surfaces more than X contradictions per day, the user will stop trusting it and stop paying attention — and then real contradictions will be missed in the noise.

**Budget: zero per day for routine contradictions.** Level 1 and Level 2 contradictions should be resolved by the system without any user-visible surface. The user should not see contradictions as a regular occurrence.

**Budget: 1–2 per week at most for Level 3 (user-involved).** If Omega is asking the user about contradictions more than once a week, it's over-surfacing. The system should be more aggressive about resolving contradictions at Level 2 before escalating.

**The honest line:** if the system is surfacing contradictions daily, it means either (a) the observation quality is too noisy — go back to the observation schema and tighten what counts as a claim, or (b) the system is being too aggressive about promoting tentative claims to a level where they generate contradictions — raise the promotion gate.

**A contradiction is a signal about the observation system, not just about the claims.** High contradiction volume means the observation system is over-generating Tier 1 claims. The fix is usually at the observation tier: raise the bar for what gets promoted from raw observation to derived claim.

---

## C. Polymathic Connections — Concrete Mechanism

### What produces a genuine cross-domain correspondence rather than word-overlap coincidence

Word overlap is the cheap failure mode. "Database schema" and "Notion database schema" share the word "schema." That's not a correspondence — that's vocabulary.

A genuine structural correspondence requires **shared structure, not shared vocabulary.** Specifically:

**Structural identity test (the real mechanism):**

Two patterns correspond structurally when they share an invariant structure across domains — the same roles in the same configuration, even if the surface vocabulary is entirely different.

The structural identity test runs at correspondence formation time (when a new pattern is promoted, or when an existing pattern is revised) and asks:

1. **Role correspondence:** does pattern A have a set of roles (initiator, action, target, constraint, outcome) that maps onto pattern B's roles? Not the same words — the same conceptual roles.

   Example: "user opens Xcode → navigates to file → edits → builds → runs" has roles [initiator: user, action: open/navigate/edit/build/run, target: Xcode/project/file, outcome: code change]. "Researcher drafts report in Notion → edits sections → shares with team" has roles [initiator: researcher, action: draft/edit/share, target: Notion document, outcome: report shared]. The surface vocabulary is entirely different. The structure (open tool → work in context → iterate → produce output) is the same. That's a correspondence.

2. **Invariant correspondence:** what stays constant across both patterns? In the above, the invariant is "a work session in a tool, organized around a specific piece of content, ending with output." The surface (Xcode vs. Notion), the content (Swift file vs. report), the output (code change vs. shared report) are all different. The invariant structure is what's shared.

3. **Domain distance confirmation:** the two patterns are in different domains (code vs. comms/researcher work). If they were in the same domain, they'd be the same pattern, not a correspondence. The correspondence is valuable precisely because it connects different domains.

**Implementation approach:** this doesn't need to be fully automatic at first. The initial mechanism can be agent-noted correspondences (an agent observes that a workflow pattern in one domain resembles a workflow pattern in another domain and notes the structural invariant). Automatic detection comes later when the system has enough patterns to run the structural identity test across the graph.

**What it is NOT:** string similarity, embedding proximity, keyword overlap. All three produce false correspondences at scale. The structural identity test is the real filter.

### What is a "shortcut" mechanically?

Josh's phrase: "makes connections and shortcuts like no other memory system." A shortcut is a **cached, reusable action plan that the system has learned from observing the user or from agent output.** It's not a single thing — it's three things that compound:

**Shortcut type 1 — Cached action plan (the direct one):**

When the system observes the user performing a multi-step workflow repeatedly, it extracts the sequence as a reusable plan. Example: the user opens Xcode, navigates to a specific project, opens a specific file, runs a specific build configuration — every Tuesday morning. The system learns this as a shortcut: "On Tuesday mornings, the user's Xcode workflow is: open project X, file Y, build config Z." Next Tuesday, when the user starts working, Omega can surface this as a suggestion: "Your usual Tuesday morning Xcode workflow is ready — open it?"

This is mechanically a **stored sequence of observed actions with a trigger condition (time + context).** It's a learned routine, surfaced as a suggestion, not an autonomous action (Q7 guardrail — ask before acting).

**Shortcut type 2 — Learned app sequence (the contextual one):**

The system observes that the user's research workflow is: Safari (find source) → Notion (draft notes) → Xcode (implement). This sequence is specific to the user and specific to their workflow. When the user is in Safari researching something, Omega can surface: "When you're ready to draft, your Notion research note template is waiting." When they're in Notion, it can surface: "Your Xcode project for this topic is open and ready."

This is mechanically a **context-to-context transition prediction:** given the user is in context A (Safari, researching), the system has observed that they often transition to context B (Notion, drafting). The prediction is surfaced as a navigational shortcut.

**Shortcut type 3 — Routing shortcut (the agent-orchestration one):**

This is the most powerful and the least obvious. When a task comes in, Omega doesn't just route to an agent — it routes to an agent WITH a suggested approach based on how the user has worked on similar tasks before. Example: "This is a code review task. The user's previous code reviews of this project used this review checklist. The reviewer agent should use this approach."

This is mechanically a **task-to-approach mapping built from observation + agent output history.** It's a shortcut in the routing layer, not the user interface layer.

**All three are real and they compound.** The cached action plan helps the user move faster. The app sequence helps the user navigate their own workflow. The routing shortcut helps Omega dispatch better. Together, they make Omega feel like it "knows how the user works" — which is the whole point of Q12.

### What is the eval: how do we know Polymem is actually getting smarter?

This is the hardest question and the one that's most often answered wrong.

**The wrong eval:** count patterns. "We have 100 patterns now, we're smarter than when we had 10." This is a storage metric, not an intelligence metric. A system with 100 wrong patterns is worse than a system with 10 right ones.

**The right evals (three layers):**

1. **Coverage eval (are we seeing the user's actual work?):** of the user's top 10 most-used apps/workflows, how many has Polymem observed and learned something about? Target: after 2 weeks, 8/10. This is a "are we paying attention" metric.

2. **Accuracy eval (are our claims right?):** of the claims Polymem has surfaced to the user for confirmation, what fraction did the user confirm vs. reject? Target: ≥ 70% confirmed, ≤ 15% rejected, rest unresolved. If rejection rate is high, the observation system is over-generating claims.

3. **Utility eval (are the shortcuts actually useful?):** of the shortcuts Polymem has surfaced, how many did the user act on? Target: ≥ 30% action rate on surfaced shortcuts. If the user ignores them, they're noise. If they act on them, the system is genuinely helping.

**The honest eval statement:** "Polymem is getting smarter if coverage goes up, accuracy stays high, and the user acts on surfaced shortcuts more often than they ignore them." Everything else is a dashboard metric that doesn't measure the thing that matters.

---

## D. Onboarding Design

### The first 10 minutes

**Minute 0–2: The conversation starts before any permission is asked.**

Omega opens and says something like: "Hey — I'm Omega. Before I ask for anything, I'd like to understand what you do and what you'd want me to help with. Tell me about your work — what apps do you live in, what's a typical day look like?"

This is not a form. This is a conversation. The user answers in plain language. Omega listens and asks follow-up questions. The goal is to learn the user's domain vocabulary, their main apps, their workflow shape — so that when permissions come, they're framed in terms the user already understands.

**Minute 2–5: The first concrete win, before the wizard.**

Before asking for screen access, Omega does something concrete with what it already has: open the user's most-used app (detected from the conversation, or from a quick system probe that doesn't require permission), find something the user actually cares about (recent file, open tab, recent search), and surface it. "You mentioned you work in Xcode a lot. Your InvoiceGenerator project is open — the file you were in last time is ViewController.swift. Want to pick up there?"

This is the trust-building moment. Omega shows it can see the actual computer, not just chat. The user sees their real context reflected.

**Minute 5–8: The permission wizard, framed around the user's stated intent.**

Now Omega asks for permissions. Critically, each permission is framed as: "I need X so I can help you with Y" — where Y is something the user just told Omega they want. Not "give me screen access for security reasons" — "give me screen access so I can actually see what you're working on and help in real time."

The wizard walks through: screen recording (continuous), accessibility tree access, browser access (user's real Chrome/Safari), iMessage, connectors. Each one has a one-line "why I need this" tied to the user's stated goal.

**Minute 8–10: The user sees Omega watching and understanding in real time.**

The wizard completes. Omega starts watching. Within 2 minutes of watching, Omega surfaces something it observed: "I see you're in Xcode — your Tuesday morning workflow usually starts with InvoiceGenerator. Want to go there?" This is the proof point. The user gave permission, and Omega immediately demonstrated value from what it saw.

**What the user must see in the first 10 minutes:** their real context reflected back, a concrete win, and Omega demonstrating understanding from observation. These three things build the trust foundation.

**What the user must NEVER see:** a generic setup screen, a wall of permission toggles, a request for permissions before Omega has shown any value, a screen that looks like a chatbot setup.

### The screen recording permission — how to ask without triggering refusal

The continuous screen recording permission is the highest-friction request. macOS treats it seriously for good reason. The way you ask determines whether the user grants it or refuses.

**The framing that builds trust:**

"I need to see your screen to actually help you. Here's what that means concretely:

- I capture screenshots continuously so I can see what you're working on
- I read the accessibility tree so I understand what's on screen semantically (not just pixels)
- I do NOT capture your keystrokes, your audio, or your camera
- Everything stays on this computer — nothing leaves (Q10)
- I only use what I see to understand your context and help with what you've asked me to do
- You can see what I'm observing at any time — the orb reflects my current understanding
- You can stop me at any time

Do you want to allow continuous screen observation so I can actually help?"

**Why this works:** it's concrete about what's captured and what's not. It ties the permission to the user's stated intent (helping with their actual work). It gives the user a way to verify what Omega is doing (the orb reflects understanding). It gives the user an out (stop at any time). It does not ask for more than it needs.

**What kills trust:** "I need screen access for security" (no — you don't), "this helps me serve you better" (vague, no concrete reason), a checkbox wall with no explanation, asking for screen access before showing any value.

### The "user-held category boundary" UI (Q6)

Q6 says: learn everything by default, user picks the categories, can change them later. The UI for this must be usable, not a settings dump.

**The design: toggle chips in the command bar context.**

When the user engages the command bar (`/`), one of the options is "categories" — which opens a compact surface showing the user's current category set as toggle chips:

```
ON:  Work  Code  Design  Finance  Comms
OFF: Personal  Health  Social  Financeetails
```

Each chip is a category. Toggling a category on/off changes what Polymem is allowed to observe and learn about. Toggling "Personal" off means Omega stops building claims about the user's personal activity — but doesn't forget what it already knows, it just stops accumulating new observations in that category.

**This is not a settings panel.** It's a command-bar context, accessible in one keypress, live-updateable, and tied to the observation system directly. The user can toggle a category on/off mid-session and the system responds immediately.

**The honest detail:** the initial category set is suggested by Omega based on the conversation in the first 10 minutes, but the user owns it. Omega suggests "Work, Code, Design" if that's what the conversation revealed. The user can add or remove categories. The defaults are suggestions, not decisions.

**What the category boundary actually controls:** it controls which domains Polymem's observation system is allowed to generate Tier 1 claims in. If "Personal" is off, the system observes personal activity (it has to, to know what to ignore) but does not promote observations to claims in the Personal domain. The user's boundary is enforced at the claim generation gate, not at the observation tier.

---

## E. Minimum Viable Polymem

### The honest scope cut

Full Polymem — eight agents watching, continuous observation, cross-domain correspondences, learned shortcuts, contradiction resolution, user-held boundaries — is a large system. The MVP must be smaller and must be genuinely useful, not impressive in a demo.

**The MVP is not:** a system that watches everything and learns everything. That's a demo trap — it'll observe a lot, learn noise, and surface nothing useful.

**The MVP is:** one specialist (ops) watches the user work via screenshot + accessibility, learns 3–5 genuine things about how the user actually works, and surfaces one genuine shortcut in the first week. That's it. The rest builds on that foundation.

### The MVP scope — what's in, what's out

**IN (MVP):**

1. **One observer agent (ops):** ops watches the screen via screenshot + accessibility tree. Not eight agents — one. Ops is the observer. The other seven agents are available for user tasks but are not observing.

2. **Screenshot + accessibility observation tier (Tier 0):** captures window events, app focus, URL, file paths, duration, time of day. OCR on screenshots for text context. Accessibility tree for semantic state. This is the raw observation tier from section A.

3. **Derived claim generation (Tier 1):** ops generates candidate claims from observations at end-of-session and on contradiction detection. Claims are tentative by default. Confidence is calculated from observation count and consistency.

4. **User confirmation surface:** when ops has a claim with confidence ≥ 0.60 that's been observed across 2+ sessions, it surfaces to the user as a single question: "I noticed you usually [X]. Is that right?" User confirms or corrects. Confirmed claims get fast-tracked to patterns.

5. **One shortcut surface:** after the first week, ops surfaces one genuine shortcut based on observed user behavior. Example: "I noticed you open Xcode, then InvoiceGenerator, then ViewController.swift every Tuesday morning. Want me to have that ready for you next Tuesday?" This is the MVP's "wow" moment — and it must be genuine, not manufactured.

6. **Pattern index (Tier 2):** the existing patterns index from Phase 1, now accepting observation-derived patterns in addition to agent-derived patterns. The schema extension from section A (observationSourceCount, userConfirmed, lastChallenge) is added.

7. **Contradiction triage Level 1 + Level 2 only:** at MVP, the system resolves routine contradictions silently and only escalates to the user when it genuinely can't resolve. Level 3 (user-involved) is in the MVP but used sparingly.

**OUT (MVP — comes later):**

- Cross-domain correspondences (Tier 3) — requires enough patterns in different domains to make structural identity testing meaningful. MVP is single-domain observation (how the user works in their main apps). Correspondences come after the pattern base is established.
- Eight-agent observation — one observer is enough for MVP. Eight agents watching would be observation overload and contradiction explosion.
- Learned app sequences and routing shortcuts (Shortcut types 2 and 3 from section C) — these require a richer pattern base and more observation history. Cached action plans (Shortcut type 1) are the MVP shortcut.
- Continuous contradiction resolution at scale — the system can handle Level 1 and 2 at MVP volume. Scaling to high-volume contradiction resolution requires the full triage policy from section B to be battle-tested.
- Cloud backup / sync — Q10 says local first. MVP is fully local. Cloud is a later opt-in.
- Windows support — Q9 says macOS first. MVP is macOS only.

### The honest line: where overpromising starts

**Overpromising starts if you promise "Omega learns everything about you automatically."** It doesn't — not without user confirmation. The honest version is: "Omega observes your work, surfaces what it notices, and learns from your corrections. It gets smarter as you confirm more and correct less."

**Overpromising starts if you promise "Omega will surface useful shortcuts from day one."** It won't — it needs observation history. The honest version is: "Omega needs a few days of observation to learn your patterns. The first shortcut usually comes in the first week."

**Overpromising starts if you promise "Omega understands everything on your screen."** It understands what the accessibility tree and OCR can tell it. It doesn't understand intent, emotion, or unstated context. The honest version is: "Omega sees what's on screen and reads the accessibility tree — it has semantic understanding of UI state, not mind-reading."

**The honest MVP thesis:** "Omega watches your work for a few days, learns a few genuine things about how you work, confirms them with you, and surfaces one real shortcut. That's the core loop. Everything else is scale."

---

## Summary: the honest version

Polymem for computer activity is a three-tier system: raw observation (Tier 0), derived confidence-weighted claims (Tier 1), and durable patterns with cross-domain correspondences (Tier 2 + Tier 3). Observation is noisier than agent output, so the promotion gate is stricter: 3+ distinct sessions, 2+ contexts, confidence floor 0.60, no active contradiction, user boundary check.

Contradictions at scale are mostly noise. The triage policy resolves Level 1 (noise) and Level 2 (agent-resolvable) silently. Level 3 (user-involved) is rare — 1–2 per week max — and is a single focused question, not a dump. Contradiction volume is a signal about observation quality, not just claim quality.

A genuine cross-domain correspondence requires shared structural identity, not shared vocabulary. A shortcut is a cached action plan, a learned app sequence, or a routing shortcut — all three are real and compound. The eval is coverage + accuracy + action rate on surfaced shortcuts, not pattern count.

The first 10 minutes start with a conversation about the user's actual work, show a concrete win before any permissions, frame each permission around the user's stated intent, and demonstrate value from observation within 2 minutes of granting access. The screen recording permission is asked concretely — what's captured, what's not, why, how to verify, how to stop. The category boundary is toggle chips in the command bar context, not a settings panel.

The MVP is one observer agent, screenshot + accessibility observation, derived claims, user confirmation surface, one genuine shortcut in the first week, the existing pattern index with observation-derived entries, and Level 1 + 2 contradiction triage. Cross-domain correspondences, eight-agent observation, learned app sequences, routing shortcuts, and cloud sync are all later. The honest thesis: Omega watches for a few days, learns a few genuine things, confirms them, surfaces one real shortcut. That's the core loop.
