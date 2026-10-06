# docs/claude

Notes on the session in which this repo was turned from a Levantine Arabic
multiple-choice drill into **learnmax**, a flip-card recall trainer for
reinforcement learning, math and ML. Written by Claude at the user's request
as a record of what was done and why.

| File | Contents |
|---|---|
| [changes.md](changes.md) | File-by-file account of what changed |
| [decisions.md](decisions.md) | Design decisions, the pitfalls hit on the way, and why |
| [verification.md](verification.md) | What was tested, how, and what was *not* tested |

## The request, in order

1. Explore the repo and explain how it works (Mac app, web app, sync).
2. Make it a recall tool: a concept or question on the front, an answer or proof
   on the back, and a way to say "understood" (= correct) or "still learning"
   instead of picking from four options.
3. Provide one easy entry point on the Mac.
4. Remove every reference to Arabic and call it `learnmax`.
5. Document all of it here.

Choices the user made when asked: update **both** the Mac and web apps, render
math with **KaTeX vendored locally**, and **replace** the Arabic deck entirely
(no dual card types).

## Starting point

A zero-dependency spaced-repetition system: Python 3 + AppKit-through-JXA on the
Mac, a vanilla-JS PWA on the phone, synced through a private GitHub repo.
`drill.py` and `webapp/srs.js` are two independent implementations of one
SM-2 scheduler, held together by a golden-vector parity test.

## Where it ended up

- A card is `{id, front, back, cat, batch?}`. Text is a small markdown with
  `$math$` / `$$display$$` typeset by KaTeX.
- Session flow: front -> reveal (space / **Show answer**) -> **Still learning**
  (`1`) or **Got it** (`2`). A card cannot be graded before it is revealed.
- The scheduler is untouched; "got it" is `correct=True`, "still learning" is
  `correct=False`. The golden test vectors did not change.
- Entry point: `./learnmax` (home screen), `./learnmax study|status|install`.
- Nothing from this session is committed.
