# Polymem — TikTok voiceover script
**"Why this is different"** · ~60–75s · verified against the shipped repo

**Every number below is measured, not estimated. Source: `README.md` and
`test/test-concurrency-rmw.mjs` @ `Polymem-clean` (548 assertions / 16 suites,
CI green Node 18+20). **Don't ad-lib a stat that isn't here** — the whole
credibility of the video rests on these being true.

> **Correction worth keeping:** an earlier draft of this script said
> *"8 of 8 in 80 of 80 runs"*. That figure came from a commit message, not
> from the shipped README — it isn't a claim the repo makes anywhere. It is
> replaced with what the shipped test actually asserts. If you re-cut this
> video, re-check the numbers against the repo, not against git history.

---

## HOOK — 0:00–0:06

> "Every AI agent framework on the market sells you a **vector database**.
> Mine is a JSON file. Here's why that's not a downgrade."

**On screen:** Card 01 — the struck-through "review".

---

## THE PROBLEM — 0:06–0:20

> "Vector databases store **facts**. You ask 'what's the capital of France'
> and it retrieves the answer.
>
> But an agent doesn't just need facts. It needs to remember **which
> techniques kept working** — that read-modify-write needs a write claim,
> that last rename wins, that the deploy breaks on a dirty tree.
>
> Facts don't capture that. **Patterns do.**"

**On screen:** `fact store → technique store`. Keep it as simple text.

---

## THE DIFFERENCE — 0:20–0:38

> "So Polymem promotes **recurring techniques**, not documents.
>
> A pattern only gets promoted when it shows up across **independent
> sessions** — not repeated once and trusted.
>
> Everything it stores is **plain JSON you can read**. No embeddings. No
> Postgres. No daemon. Zero dependencies — seven files, thirty kilobytes.
>
> And here's the part nobody does: I had an agent **try to break it five
> times**. It found five real bugs. One had been quietly deleting data
> while telling everyone it saved successfully."

**On screen:** Card 02 — the `LIAR` timeline. This is your money shot.

---

## THE PROOF — 0:38–0:52

> "Not a claim — a measurement. Eight processes writing at once, released
> off a real barrier.
>
> Before the fix: **between one and seven of eight patterns survived**,
> the file was valid JSON, and **all eight reported success**.
>
> "After the fix: **zero lost writes** — and there's a test that fails against
> the old code if that ever stops being true.
>
> Every one of those five bugs has a regression test written to **fail
> against the old code**. Five hundred forty-eight assertions, sixteen
> suites, running on Node 18 and 20. That's the difference."

**On screen:** `1–7 of 8 (before) → 0 lost (after)`. Consider animating the two.

---

## THE HONEST PART — 0:52–1:05

> "Now — the part most demos cut.
>
> **This is not a vector database.** It's keyword matching, not semantic.
> Ask it a question in different words and you'll get nothing.
>
> It's **not** a knowledge graph. Not multi-tenant. Not for Windows
> network shares.
>
> The README tells you all of this before you install, because a tool that
> hides its limits isn't one you can trust with anything."

**On screen:** Card 03 — `vector DB → a JSON file`. Or plain text list.

---

## CTA — 1:05–1:12

> "If your agent needs to remember *how it did things*, not just what's
> true — `github.com/jwatson1283/Polymem`.
>
> Five hundred forty-eight tests. Zero dependencies. And it tells you where
> it will fail."

**On screen:** the GitHub pill, held for a beat.

---

# Production notes

**Pacing** — the hook is 6 seconds and it's the whole video. If someone
scrolls past 0:06 they don't come back. Say it fast.

**The honest beat is the strongest beat.** 0:52–1:05 looks like a weakness
in the script and reads as the most credible part on screen. Don't cut it
for length. If you must cut, cut the "The Difference" section — never this.

**Numbers are load-bearing.** This video's entire argument is *"measured,
not claimed."* If a number is wrong the video collapses. All of these come
from the shipped README.

**Don't fake a benchmark.** There is no latency or throughput benchmark
because none was run. The concurrency numbers are a real correctness test,
not a speed claim — say "how many survive", never "how fast".

**Caption + audio.** TikTok's caption area covers the lower third; the
cards hold 330px clear at the bottom. Text-on-screen should carry the
numbers so the video works muted — most watch with sound off.

## Optional cutdowns

| Version | Length | Beats |
|---|---|---|
| Full | ~72s | all six |
| Punchy | ~35s | Hook → Problem → Difference → Proof → CTA (**drop Honest**) |
| Proof-only | ~28s | Hook → Proof → Honest → CTA — best for dev audiences |