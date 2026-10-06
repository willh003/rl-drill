# Verification

## Environment note

`node` is not installed on this machine. The JS tests were therefore run under
macOS's built-in `jsc` (JavaScriptCore) with a ~15-line shim providing
`require`, `process`, `console` and `readFile`-backed `fs`. CI runs them under
real node; that is the authoritative run.

## Run and passing

- `python3 gen-golden.py` -> `golden-srs.json` identical to the committed copy
  (127 vectors, 10 merge cases).
- `test-srs.js` (jsc): 4014 assertions, 0 failures.
- `python3 test-queue.py` and `test-queue.js` (jsc): all invariants hold.
- `test-render.js` (jsc): all cases pass.
- `python3 validate-deck.py`: example deck, 12 cards in 3 topics, ok.
- `sh -n` on `install.sh`, `learnmax`, `deploy-webapp.sh`; `ast.parse` on the
  Python modules.
- After the rename: `./learnmax status` works; `LearnmaxDrill.app` and `LearnmaxHome.app`
  compile with the expected `CFBundleName` / `CFBundleIdentifier`.
- The JS tests were last run *before* the rename; the rename touched strings
  only, and the Python tests and golden check were re-run after it.

## Seen with eyes

- **Web app** (headless Chrome, seeded `localStorage`): home screen with topic
  buttons, and a revealed card with KaTeX display math rendering correctly.
  The screenshots were clipped on the right by headless Chrome's minimum window
  width, not by the layout.
- **Mac drill window** (compiled applet, `screencapture`): KaTeX math rendered in
  the web view, the rule + "ANSWER" label, footer "1 of 3 . 1 still learning .
  2 got it", and the two native buttons with "again in 10 min" / "next in 10
  min".
- **Mac home and analytics** (`HOME_SNAPSHOT` PNGs): topic buttons, "TODAY GOT
  IT", trouble list showing a card front.

## Not tested

- A full Mac session through `drill.py` with real key presses and the results
  file being tailed. `commit_answer` and the results protocol are unchanged,
  and the window emits the same line shape, but the end-to-end path was not
  exercised by Claude in this session.
- Any real sync: no GitHub repo, token, or Pages deploy was used. The sync code
  was not modified apart from removing the tables upload.
- Service-worker offline behaviour, the install flow, push notifications.
- Phone layout on a real iPhone; arrow-key behaviour on a desktop browser.
- The regenerated icons were not eyeballed.
- Very long cards (taller than the window) on the Mac side.

## Possible follow-ups

- Rename the GitHub repo (`gh repo rename learnmax`), then
  `git remote set-url origin git@github.com:willh003/learnmax.git`.
- Re-run `./learnmax install` and remove the old `local.arabic-drill` launch
  agent if one was installed.
- Add screenshots of the new UI to the README.
- Show card math in the Mac "trouble cards" list as typeset text (it currently
  shows LaTeX source, truncated to ~78 characters).
