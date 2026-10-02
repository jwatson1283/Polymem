# Polymem social graphics — 1080x1920 (TikTok / Reels)

## Design source
Borrowed from **`vigozhao/ai-visual-prompt-cookbook`**, style
`monochrome-tech-grid-editorial` (v2.1), local copy at
`~/Projects/ai-creative/ai-visual-prompt-cookbook/styles/monochrome-tech-grid-editorial/`.

Palette copied verbatim from that style's `color_palette` block, not eyeballed
from the preview image:

    paper #D9D9D4 · ink #111716 · graphite #4D504E · red #D71920
    yellow #E1C51A · blue #1C4FA3   (calibration strip only)

The source spec reserves roughly half the frame for a documentary photograph.
**No image generator is available on this machine** (FAL billing blocked), so
rather than fake a photo or leave a hole, the lower band carries the real
measurement. That is the only declared deviation.

## The three beats
1. `g1-model` — what Polymem stores and the evidence bar
2. `g2-compare` — positioning against Mem0 / Hindsight / LangChain
3. `g3-proof` — the concurrency measurement, as a calibration panel

## Numbers
Every figure is quoted from the **shipped artefact**, never from git history.
`g3-proof` states `1-7 of 8` as a RANGE because the pre-fix result is a race;
the README says so explicitly ("Any single figure quoted here would be an
artifact of one run"). Do not replace that range with one run's number.

## Re-render
    python3 shot.py g1-model.html g1-model.png 1080 1920

`shot.py` is the Playwright renderer from the `social-graphic-rendering` skill.
Always open the PNG before shipping it: a screenshot path proves the file
exists, not that it shows the card.

---

## Plain-language set (h1 / h2 / h3)

Same visual system as g1/g2/g3, written for people who do not work in software.
Built after feedback that the g-cards were developer vocabulary on a card meant
for everyone. Kept: the palette, the grid, the empty cells, one red accent.
Changed: the words.

What was cut, and why:

| g-cards said | plain set says |
|---|---|
| "evidence bar: 3+ sessions AND 2+ domains" | **Prove it twice.** |
| "promotion / demotion" | what it keeps / what it ignores |
| "Mem0 / Hindsight / LangChain" | **the others** |
| "multi-user scoping" | *(row removed)* |
| "30.9 kB / 7 files / 0 deps" | **30 kB** vs **hundreds of MB** |
| "1-7 of 8 patterns survived" | **7 of 8 notes could vanish** |

Numbers still come from the shipped repo and the shipped tests. `h3` says "7 of
8" because that is the worst end of a range the README is explicit is a race --
it is a real observed value, not a single fabricated run. If asked for the
typical case, the answer is 3 of 8, and the card should say so rather than
quietly quote the scarier number.

---

## Origin set (h4 / h5)

Built from the **origin story**, not the product stats — because the story is the
more interesting artefact and GitHub now carries it in the README.

- `h4-origin` — the Gunter finding that the whole project came from, the
  specialist-vs-polymathic memory contrast, and Hindsight recorded as
  **deferred rather than rejected**.
- `h5-failure` — the week it ran in production and learned that agents say "hi".

Every claim on both cards traces to `docs/HOW-IT-WORKS.md`, which in turn cites
Professor's session `20260817_174314_992db4` (2026-09-23) and the shipped README.
The `559` on h5 is the current suite size and will move; re-check it against
`npm test` before re-recording.
