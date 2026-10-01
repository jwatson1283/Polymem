# Polymathic Two-Tier Memory System — Implementation Plan

> **Goal:** Add a short-term working memory layer and a long-term structural memory layer to Omega Shell, with evidence-gated promotion between them. The system decomposes agent output into claims/patterns/correspondences, cross-checks within the session, promotes durable patterns to long-term, and surfaces cross-domain retrieval.

**Context:** This is the response to the researcher's comparison of three memory models — polymathic concept, Omega Shell's current three-file loader, and Hindsight (Vectorize.io). The decision is to build a two-tier polymathic memory system. This document is the formal plan; agent POA (Plan of Action) is requested from each agent.

**Current state (Phase 1 implemented — 2026-09-23):**
- Backend: `backend/memory/memory.mjs` (~218 lines) — parseMemoryBlock, appendWorkingMemory, checkIntraSessionContradictions, promoteSession, queryPatterns, loadPatternsIndex/savePatternsIndex, normalizeDomain with synonym map. All state file-backed, atomic tmp+rename writes, env-var seams (`OMEGA_MEMORY_INDEX`, `OMEGA_MEMORY_SESSIONS_DIR`) for testing.
- Backend: `backend/server.mjs` modified — MEMORY_INSTRUCTION appended to every dispatch prompt, writeMemoryLog decomposes via fenced ```memory block, fallbacks get enriched prompt (was: raw message), loadMemoryContext fixed to read `sessions/${today}.md` (was: wrong path) + optional Relevant Patterns section, queuedWrite serializes read-modify-write cycles, patternsIndex loaded at boot, 4 admin endpoints: GET /api/memory/patterns, GET /api/memory/query?q=, POST /api/memory/promote, GET /api/memory/working?date=.
- Backend: `backend/test-memory.mjs` (114 lines, 25 assertions, all passing). `node --check` clean on memory.mjs, server.mjs, test-memory.mjs.
- Verified end-to-end live: dispatch → model emits memory block → parsed/normalized/stored → promoted → queried. Same-day re-promote idempotent.
- Pre-existing bugs fixed along the way: nous auth (access_token vs token/api_key — was silently dead), silent catch {} in fallback loop (hid ollama failures), loader/writer path mismatch (dead "Today" context), fallback dispatches getting raw prompt instead of enriched.
- Frontend: no memory layer wired in yet (Hermes' Tier 1 POA pending).
- Decision: stays in Omega Shell repo (Option B from plan — not a standalone repo, not Hindsight). Extraction to standalone is mechanical later when API stabilizes.
- Phase 2 gaps acknowledged: demotion path, structured correspondence fields (strings instead), naming normalization, paraphrase contradiction detection, session date validation on /api/memory/working?date=, promotion endpoint auth on POST /api/memory/promote.

---

## Decision: Two-Tier Polymathic Memory

### Problem
Omega Shell's current memory is a context-window filler — slurp three files, append a session log. It does not decompose agent output, does not track patterns, does not cross-check for contradictions, does not retrieve across domains, and does not compound over time. The orb reflects agent state but not memory. The system accumulates files but not institutional knowledge.

### Options

**Option A: Build both tiers on the vault (Markdown + patterns index file)**
- Short-term: structured decomposition block written alongside session logs
- Long-term: patterns index file + consolidated Markdown notes per pattern
- Pros: Zero new infra, fully owned internals, no LLM cost for consolidation, easy to inspect/backup
- Cons: You build the graph, consolidation, and retrieval yourself; retrieval quality depends on your index design

**Option B: Hindsight as the long-term base + custom pattern layer on top**
- Short-term: same as Option A
- Long-term: Hindsight memory bank for consolidation + retrieval; separate pattern index for structural-correspondence links
- Pros: Hindsight handles consolidation, contradiction detection, multi-strategy retrieval, per-bank personality out of the box; you layer the distinctive polymathic property (structural correspondence) on top
- Cons: Infra (local daemon or cloud), LLM cost for extraction/consolidation, less visible internals, integration effort; the LLM cost tension with Omega Shell's "local-first, paid-only-when-needed" philosophy

**Option C: Hindsight for everything (no custom pattern layer)**
- Short-term + long-term both in Hindsight
- Pros: Minimum custom work, full product feature set
- Cons: No structural-correspondence thesis — Hindsight's entity graph is not a cross-domain pattern-correspondence graph; you get retrieval/consolidation but not the polymathic distinctive property

### Recommendation
**Option A for Phase 1 (prove the short-term layer and the pattern index are useful).** Then decide Option B vs Option A for Phase 2 based on whether the pattern index is pulling its weight and whether you want the Hindsight infra/LLM cost.

Rationale: The distinctive value of the polymathic memory concept is the structural-correspondence layer, which neither Hindsight alone nor the current file loader provides. Start by building the short-term decomposition + intra-session cross-check + a patterns index. That proves the core mechanism is useful with zero infra. Then decide whether to graduate to Hindsight for the consolidation/retrieval base or stay vault-native as the pattern layer matures.

---

## Architecture — Two Tiers

### Tier 1: Short-Term Working Memory (in-session)

**Scope:** One dispatch + the session it belongs to. High bandwidth, fast, lossy.

**What it holds during a dispatch:**
- Raw facts from the agent's output (decomposed, not the truncated blob)
- Patterns or principles the agent invoked
- Structural correspondences the agent made across domains
- Contradictions detected against existing short-term AND promoted long-term knowledge
- Partial syntheses: "this looks like pattern P with difference D"

**Write behavior (in `writeMemoryLog` or a companion function):**
1. Decompose the agent's output into claims, patterns, facts (structured block, not just 200-char truncation)
2. Tag structural correspondences explicitly: "instance of pattern P" or "resembles pattern P in domain X"
3. Run intra-session cross-check: does this claim conflict with what's already in this session's working memory?
4. Run lightweight long-term cross-check: does this claim conflict with any already-promoted pattern in the index?
5. Accumulate evidence counts within the session

**Session-end behavior:**
- Decide promotion: which claims/patterns are durable enough to move to long-term
- Decide discard: which were session-specific and don't generalize
- Decide flag: which contradictions or open questions need resolution before promotion
- Write promotions into long-term (not just append to session log)

### Tier 2: Long-Term Structural Memory (persistent)

**Scope:** Cross-session, cross-domain, compounding. Slower to grow, richer to retrieve.

**What it holds:**
- Pattern entities — first-class nodes with descriptions, domains spanned, and the records that instantiate them
- Consolidated observations — deduplicated, evidence-grounded beliefs built from multiple records
- Promoted principles and models — high-density items that account for many facts
- Contradiction state — flagged edges, resolution or explicit unresolved
- Cross-domain correspondence links — "pattern in domain A corresponds to pattern in domain B"

**Write behavior (on promotion from short-term):**
1. Validate: does the promoted item hold up against existing long-term knowledge?
2. Link: connect to existing patterns it instantiates, extends, or conflicts with
3. Consolidate: if similar observations exist, merge with evidence tracking — don't pile up
4. Flag: if contradiction detected, first-class state, not silent

**Read/retrieval behavior:**
- Pattern-based retrieval: "find everything instantiating pattern P across all domains"
- Cross-domain surfacing: when retrieving for domain A, surface structural correspondences in domain B
- Contradiction-aware: surface unresolved contradiction state, not just the observation
- Agent-channel routing: same underlying memory, different surface form per agent
  - Chief: synthesis + patterns + contradictions
  - Researcher: patterns + evidence + sources
  - Engineer: relevant learnings + recent technical notes

**Compounding:** Each new promotion that links to an existing pattern makes that pattern more useful — more instantiations, more cross-domain reach, more evidence.

---

## Promotion Model — Evidence-Gated with Candidate Tier

A pattern promotes from short-term to long-term when it crosses a threshold. Two tiers within long-term:

- **Candidate pattern:** Low evidence. Stored in the index, links and accumulates, but not treated as established. Can be promoted from many sessions without being "confirmed."
- **Established pattern:** Crossed evidence threshold. Treated as durable structural knowledge. Retrieval surfaces it with confidence.

Thresholds (to be tuned empirically):
- N independent sessions invoking the same pattern (e.g. 3+)
- OR M domains where the pattern appears (e.g. 2+)
- AND survives consistency check against existing long-term knowledge

This gives compounding from the start (candidates link and accumulate) without polluting the established layer.

---

## Phase 1 — Short-Term Layer + Patterns Index (Option A, minimal infra)

### Phase 1 Task 1: Decompose agent output on write

**Objective:** Replace the 200-char truncation in `writeMemoryLog` with a structured decomposition that extracts claims, patterns, and facts.

**Files:**
- Modify: `OmegaShell-v5-her/backend/server.mjs` — `writeMemoryLog()` function
- Create: New structured block format in the session log, OR a companion working file per session

**Step 1:** Define the structured block schema. A session working block looks like:
```
## Session Working Memory — 2026-09-23

### Claims
- [claim text] — domain: [domain tag] — evidence: 1

### Patterns Invoked
- [pattern name or description] — domains: [list] — evidence: 1 — status: candidate

### Structural Correspondences
- [this claim] corresponds to [pattern P] in [domain X] — tentative/established

### Contradictions Detected
- [claim A] contradicts [claim B or pattern P] — resolution: unresolved/resolved

### Evidence Counts
- Pattern P: 2 sessions, 1 domain
```

**Step 2:** Add decomposition logic. This is the hard part — extracting structured claims/patterns from free-text agent output. Options:
- Prompt-based: include an instruction in the dispatch that asks the agent to output structured memory in the schema above (simplest, relies on agent competence)
- Post-hoc LLM extraction: a separate extraction step that takes the raw output and produces the structured block (more reliable, costs an LLM call)
- Hybrid: agent outputs structured memory as part of the dispatch, post-hoc extraction catches what it misses

Start with prompt-based (lowest cost/complexity). Add post-hoc extraction if decomposition quality is insufficient.

**Step 3:** Write the structured block alongside the existing session log append. Don't replace the append — keep it as the audit trail. Add the structured block as a parallel record.

**Verification:** Dispatch a task. Check that the session log contains both the original log entry and a structured working memory block with claims/patterns/correspondences.

---

### Phase 1 Task 2: Intra-session cross-check

**Objective:** Detect contradictions within the current session's working memory before they accumulate silently.

**Files:**
- Modify: `OmegaShell-v5-her/backend/server.mjs` — new function `checkIntraSessionContradictions(sessionId, newClaim, workingMemory)`
- Read: The current session's working memory block

**Step 1:** Define contradiction detection for intra-session scope. This is a narrow, cheap check — does the new claim conflict with a claim already in this session's working memory? Scope: same-session only, no vault-wide search yet.

**Step 2:** Implement the check. On each write to working memory, scan existing claims in the session for direct conflicts. A conflict is detectable when two claims make incompatible assertions about the same subject (e.g. "X is the preferred approach" vs "X is deprecated").

Start simple: keyword/subject overlap + assertion polarity check. Escalate to LLM-based contradiction detection if simple checks miss too much.

**Step 3:** Flag contradictions in the working memory block under `### Contradictions Detected`, with resolution state `unresolved`.

**Verification:** Dispatch a task where the agent makes two contradictory claims across the session. Check that the second write flags the contradiction.

---

### Phase 1 Task 3: Patterns index file

**Objective:** Create a persistent index that maps patterns to the sessions/records that invoke them, with evidence counts and domain tags.

**Files:**
- Create: `OmegaShell-v5-her/backend/memory/patterns-index.json` (or `.md` if you prefer human-readable)
- Modify: promotion logic (see Phase 1 Task 4) writes to this index

**Step 1:** Define the index schema:
```json
{
  "patterns": {
    "pattern-id": {
      "name": "pattern name or description",
      "domains": ["domain-a", "domain-b"],
      "sessions": ["2026-09-23", "2026-09-24"],
      "evidenceCount": 2,
      "status": "candidate",
      "correspondences": {
        "pattern-id-2": "tentative/established — reason"
      },
      "contradictions": {
        "pattern-id-3": "unresolved/resolved — reason"
      }
    }
  }
}
```

Start with JSON for ease of programmatic update. Convert to Markdown later if human inspection is valuable.

**Step 2:** Load the index on server startup (`loadPatternsIndex()`) and keep it in memory for the session. Persist on each update.

**Verification:** After a session with pattern invocations, check that `patterns-index.json` contains entries with the correct session references and evidence counts.

---

### Phase 1 Task 4: Promotion function

**Objective:** At session end, decide what from short-term working memory becomes a candidate pattern in the index.

**Files:**
- Create: `OmegaShell-v5-her/backend/memory/promoteToLongTerm(sessionId, workingMemory, patternsIndex)` 
- Modify: session-end hook (or add a manual/admin trigger for Phase 1)

**Step 1:** Define promotion rules (evidence-gated):
- A pattern invokes in 2+ sessions OR spans 2+ domains → candidate in index
- A pattern invokes in 3+ sessions AND spans 2+ domains → candidate (stronger signal)
- A claim that is session-specific with no pattern generalization → discard
- A contradiction that is unresolved → flag, do not promote until resolved

**Step 2:** Implement promotion. On session end (or manual trigger in Phase 1):
1. Scan the session's working memory for patterns invoked
2. For each pattern, check the index: does it already exist? If yes, increment evidence count and add the session. If no, create a new candidate entry.
3. For each correspondence noted in the session, update the pattern's correspondences in the index (mark tentative unless it's been established across sessions)
4. For each contradiction, update the pattern's contradiction state
5. Write the updated index to disk

**Step 3:** In Phase 1, trigger promotion manually (admin endpoint or CLI) rather than fully automating session-end. This lets you inspect what's being promoted before it's automatic.

**Verification:** End a session with known pattern invocations. Run promotion. Check that the patterns index has updated entries with correct evidence counts.

---

### Phase 1 Task 5: Pattern-based retrieval (minimal)

**Objective:** Make the patterns index queryable so agents can retrieve by pattern, not just by file/date.

**Files:**
- Create: `OmegaShell-v5-her/backend/memory/queryPatterns(query, patternsIndex)` — returns matching patterns + their linked sessions/records
- Modify: `loadMemoryContext()` to optionally include pattern-based retrieval results

**Step 1:** Implement a basic query: given a pattern name or domain, return all patterns that match, with their evidence counts, domains, and linked sessions.

**Step 2:** Add a retrieval mode to `loadMemoryContext()` that can be toggled per agent. When toggled, the loader returns pattern-based results in addition to (or instead of) the three-file slurp.

**Step 3:** In Phase 1, expose this via a manual query endpoint so you can test it before wiring it into the agent prompt.

**Verification:** Query the patterns index for a known pattern. Check that it returns the correct patterns with their sessions and evidence.

---

### Phase 1 Acceptance Criteria

- [ ] `writeMemoryLog` produces a structured working memory block alongside the session log append
- [ ] Intra-session contradictions are flagged in the working memory block
- [ ] `patterns-index.json` exists and is loaded on startup
- [ ] Promotion (manual trigger in Phase 1) moves session patterns to the index with correct evidence counts
- [ ] Pattern-based query returns matching patterns with linked sessions
- [ ] The system runs with zero new infra — no daemon, no new service, no LLM cost beyond what's already spent on dispatches

---

## Phase 2 — Long-Term Layer Maturity

**Decision (2026-09-23, finalized): Stay in-Omega-Shell-repo, file-based.** NOT Hindsight, NOT standalone. Phase 1 implementation is complete and verified (25/25 tests, syntax clean). Zero new infra, zero new deps, zero LLM cost beyond dispatches.

Phase 2 starts after Phase 1 proves the pattern index is useful in practice. The plan's original Option B (Hindsight as long-term base) is **deferred**, gated on two measurable triggers:

1. Pattern count >~200 AND keyword queries (`queryPatterns`) miss or return poor results
2. Manual dedup of near-duplicate patterns in the index becomes a recurring chore

Both are measurable. When either trigger fires, reconsider Hindsight (local daemon via Docker Compose + Ollama, per warden's infra assessment: ~1-2 engineering sessions). Until then, the in-repo file-based layer is the long-term layer.

### Option A continuation (in-repo file-based, the active path)

- **Fine-grained pattern entities:** Convert the JSON index to a richer structure with descriptions, cross-domain correspondence links, and contradiction edges
- **Consolidation:** Deduplicate overlapping patterns in the index; merge with evidence tracking
- **Contradiction resolution workflow:** Unresolved contradictions surface as first-class items; agents or humans resolve them; resolution updates the index
- **Cross-domain retrieval:** Query by pattern returns linked patterns in other domains via the correspondence links
- **Agent-channel routing:** `loadMemoryContext()` returns different slices per agent role (Chief gets synthesis + contradictions, Researcher gets patterns + evidence, Engineer gets technical learnings)
- **Frontend wiring:** Orb reflects active patterns, neurogenesis on new pattern connections, disruption on contradiction detection; task history panel (`T`) groups by pattern, not just date

### Option B (Hindsight as long-term base + pattern layer on top)

- **Evaluate Hindsight local daemon vs cloud:** Local = your LLM costs for extraction/consolidation; cloud = usage-based. Check current `hindsight.vectorize.io` docs and pricing.
- **Wire `retain()` on dispatch:** After the dispatch completes, retain the structured output + promoted patterns into a Hindsight memory bank
- **Wire `recall()` into the prompt:** Before dispatch, recall relevant memories from the bank and include them in the context
- **Pattern layer on top:** Store pattern entities in your own index (as in Phase 1). Link Hindsight memory records to patterns. Retrieval by pattern = query your index, then recall linked memories from Hindsight
- **Use Hindsight's per-bank mission/directives/disposition for bank-level personality** — in addition to your own agent-channel routing
- **Use Hindsight's observation consolidation** for the deduplicated, evidence-grounded belief layer; your pattern index handles the cross-domain structural-correspondence layer
- **Reconsider the LLM cost tension:** If you use Hindsight, consolidation burns tokens. Decide whether memory consolidation counts as "needed" under Omega Shell's routing philosophy

---

## Phase 3 — Frontend Integration (after memory layer is functional)

**Objective:** Make the orb and UI reflect the memory system, not just agent state.

**Files:**
- Modify: `OmegaShell-v5-her/frontend/src/App.tsx` — orb state reacts to memory events
- Modify: Task history panel (`T`) — groups by pattern, shows memory connections

**State-reactive memory events:**
- New pattern connection formed → neurogenesis event on the orb
- Contradiction surfaced → visible disruption (not just text)
- Active pattern currently in use → orb's neural activity reflects the pattern, not just agent state
- Memory depth/compounding → ambient indicator (how connected is the system right now?)

**Task history by pattern:**
- Current: chronological session log
- Target: group by pattern, show which sessions invoked which patterns, show evidence growth over time

This phase is the visible payoff — the orb becomes the surface of a memory system, not just a reactive sculpture.

---

## Risks

- **Decomposition quality is the make-or-break detail.** Garbage patterns in, garbage structural layer out. If prompt-based decomposition is insufficient, you need post-hoc extraction, which costs LLM calls. This needs empirical validation in Phase 1.
- **False structural correspondences.** The system will over-detect correspondences. Need a tentative vs established distinction, and a way to demote false correspondences.
- **Threshold tuning.** Evidence-gated promotion needs N and M tuned. Too low = noisy structural layer. Too high = it never grows. This is empirical, not design.
- **Promotion is a commitment.** Once promoted, harder to un-promote. Conservative promotion or a demotion path is needed.
- **Hindsight infra/cost if Phase 2 triggers Option B.** Local daemon + LLM provider for consolidation is real infra and real cost. Cloud = usage-based. Not free either way. DEFERRED — not active until gated triggers fire.
- **Phase 3 is a big frontend change.** Wiring memory into the orb and UI is a separate engineering surface from the backend memory layer. Don't let it block Phase 1/2.

---

## What We Need From Each Agent

### @hermes
- Frontend: how should the orb and UI reflect memory events in Phase 3?
- Frontend: what's the current state of `App.tsx` memory integration (if any)?
- Frontend: can the agent windows surface pattern-based memory in their responses?
- POA: frontend work for Phase 3, prioritized after Phase 1/2 backend is functional

### @chief
- Review: is the two-tier design right? What's missing from the concept?
- Review: are the promotion thresholds and candidate/established distinction sound?
- Review: does Option A → Option B sequencing make sense, or would you start with Hindsight?
- POA: review the plan, flag gaps, recommend changes

### @sentry
- Code review: once Phase 1 implementation exists, review `writeMemoryLog` decomposition, intra-session cross-check, patterns index, promotion function, query function
- Review: decomposition logic soundness, contradiction detection edge cases, index schema correctness
- POA: code review timeline and focus areas

### @sparks
- Implementation: Phase 1 tasks (decomposition in `writeMemoryLog`, intra-session cross-check, patterns index, promotion function, query function)
- Implementation: Phase 2 decision (Option A vs Option B) and execution
- POA: estimate Phase 1 effort, identify implementation order, flag technical blockers

### @warden
- **Infra: Phase 1 confirmed clean — zero infra, zero deps, zero LLM cost.** `backend/memory/memory.mjs` on disk, `patterns-index.json` in `backend/memory/`, no new service/daemon/port. Verified: 25/25 tests pass, atomic writes via tmp+rename. No Hindsight infra work now.
- **Infra: Phase 2 Option B (Hindsight local daemon) DEFERRED**, gated on two measurable triggers: (1) pattern count >~200 AND keyword queries miss, OR (2) manual dedup of near-duplicate patterns becomes a chore. When triggered, reference warden's Docker Compose + Ollama assessment (~1-2 sessions). No action until then.
- **GAP: memory.mjs implemented + verified but NOT wired into server.mjs dispatch path.** server.mjs still calls old `writeMemoryLog` (200-char truncation). @sentry review target before commit — confirm the wiring plan.

---

## Open Questions

1. **Decomposition approach:** Prompt-based (agent outputs structured memory) vs post-hoc LLM extraction vs hybrid? Phase 1 starts with prompt-based; when do we add extraction?
2. **Contradiction detection scope:** Phase 1 is intra-session only. When do we add cross-session and cross-domain contradiction checking?
3. **Evidence thresholds (Phase 1 tested — 2026-09-23):** Candidate = 2+ sessions OR 2+ domains; Established = 3+ sessions AND 2+ domains; Contradiction-implicated patterns freeze at candidate (no promotion to established while a contradiction is open). These are the tested values from Phase 1 implementation. Threshold tuning is still empirical — run sessions, examine recurrence rates and false-positive rates, adjust. Evidence decay (sliding window or half-life) is a Phase 2 addition — Phase 1 evidence counts only go up.
4. **Hindsight decision timing:** DECIDED — stay in-repo, file-based for now. Hindsight (Option B) deferred to Phase 2, gated on: pattern count >~200 AND keyword queries miss, OR manual dedup of near-duplicate patterns becomes a chore. Both measurable. When triggered, reconsider Hindsight local daemon (Docker Compose + Ollama, per warden's assessment).
5. **Hindsight cost framing:** If Option B, does memory consolidation count as "needed" under Omega Shell's routing philosophy, or is it overhead?
6. **Pattern correspondence granularity:** How specific are patterns? "Functional programming" is too broad. "Decomposition-with-contracts" is better. What's the right level?
7. **Frontend timing:** Phase 3 is after memory is functional. Does the orb reflect memory in Phase 2 already (backend events only), or wait for full Phase 3?

---

## Existing Relevant Files

- `OmegaShell-v5-her/backend/server.mjs` — `loadMemoryContext()`, `writeMemoryLog()`, `taskQueue`, `doDispatch()`
- `OmegaShell-v5-her/frontend/src/App.tsx` — orb + agent windows + UI overlay
- `OmegaShell-v5-her/frontend/DESIGN.md` — design system spec
- `~/Documents/Obsidian Vault/11_COMPUTER_AGENT/` — `learnings.md`, `today.md`, `system lobe.md`, `sessions/`
- `OmegaShell-v1/backend/package.json` — historical: `@vectorize-io/hindsight-client ^0.10.1` (set aside in v5-her)
- `OmegaShell-v1/backend/server.mjs` — historical: may show how Hindsight was wired in v1 (if used)
- `~/Documents/Obsidian Vault/10_BRAIN/researcher-lobe.md` — polymathic memory research block

---

*Plan version 1.0 — for agent review and POA. Update as agents respond.*
