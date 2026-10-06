# Decisions and pitfalls

## Self-grading reuses the scheduler unchanged

`grade(entry, correct)` only takes a boolean, so "got it" -> `True` and "still
learning" -> `False` needed no scheduler change. That kept the golden parity
test valid and meant the Python/JS pair did not have to be re-synchronised.
The cost is a semantic one: the learner is now the judge, so the README says to
press "got it" only if you could have *produced* the answer, not merely
recognised it once shown.

## A card cannot be graded before it is revealed

In both apps the grade action is a no-op until the answer has been turned over.
Otherwise a stray `2` keypress would count as success without any attempt.

## Dropping siblings simplified the queue a lot

The old queue existed to keep two directions of one item apart. Flip cards have
one direction, so the whole sibling/penalty machinery went. What remains keeps
the properties that mattered independently: oldest backlog first, a drip of new
cards, `NEW_RESERVED` slots so a large backlog cannot starve new material, and
reviews before new. Reviews are shuffled so the order is not a cue; new cards
stay in deck order because a batch is usually written foundations-first.

## Math: KaTeX vendored, one renderer

AppKit cannot typeset math, and the phone needs it too. Both use KaTeX from
`webapp/vendor/katex`, so it works offline and there is a single copy.
`render.js` is shared so cards look identical on both devices. Only woff2 fonts
are shipped (every target browser supports them); the CSS still lists woff/ttf
fallbacks, which simply never get requested.

Math is extracted into placeholders *before* escaping and markdown, so
`x_*^*y` or `a_i b_i` inside a formula never turns into emphasis. `\$` is a
literal dollar sign.

## The Mac card face is a WKWebView -- and native code cannot call into it

First attempt: `web.evaluateJavaScriptCompletionHandler(js, null)` to set the
card. It crashed the process with
`TypeError: null is not an object` thrown from `JSOCForwardInvocation` when
WebKit invoked the (nil) completion block. JXA cannot construct that block.

Fix: no calls into the page at all. The window loads
`card.html#<urlencoded JSON {front, back, show}>` with
`loadFileURLAllowingReadAccessToURL`; the page parses `location.hash` and
repaints on `hashchange`. A fragment-only navigation is same-document, so
revealing the answer does not reload the page or flash.

Consequences: arrow-key scrolling of the card is not supported (it would need
JS); trackpad/mouse-wheel scrolling works. Documented under "Landmines".

The web view subclass (`DrillWeb`) returns `false` from `acceptsFirstResponder`,
or clicking the text would take the keyboard off the root view and
space/1/2 would stop working for the rest of the session -- the same trap the
old option rows had.

## Running the drill window for testing

A bare `osascript -l JavaScript drill_ui.js` process runs but its window stays
behind other apps (the existing "no keyboard without a LaunchServices app"
landmine in another form). Visual checks were done by launching the compiled
applet via `python3 drill.py --demo`, then `screencapture`.

## `./learnmax study` is plain `drill.py`

With nothing due, `drill.py` exits silently by design (scheduled firings must
not pop up an empty window). So `study` is "what's due, quietly"; the home
screen (`./learnmax`) is the place to practise when nothing is due.

## Rename scope

"Called learnmax" was applied to identifiers, files, labels and visible titles,
including the launchd label. The consequence for anyone who already ran
`install.sh`: the old `local.arabic-drill` job and `Levantine Arabic.app` are
orphaned and must be removed by hand; re-running `./learnmax install` creates
the new ones. Stale `RecallDrill.app` / `RecallHome.app` build products from an
intermediate name were deleted.

## Things deliberately left alone

- The git remote (still `willh003/arabic-drill`). The user renamed the local
  directory to `learnmax` themselves during the session.
- Existing user data: `state.json` and `reviews.jsonl` already existed locally
  (the user had been studying) and are gitignored; they were not touched.
