# What changed, file by file

## New files

| Path | Purpose |
|---|---|
| `webapp/render.js` | Card text -> HTML, shared by the phone app and the Mac window. Pulls math out first (so `*`/`_` inside formulas are never emphasis), escapes HTML, then handles `**bold**`, `*italic*`, `` `code` ``, bullet/numbered lists, paragraphs. Falls back to showing the LaTeX source if KaTeX is not loaded. |
| `webapp/card.css` | Card typography, shared by `index.html` and `card.html`. |
| `webapp/card.html` | The page the Mac window shows in a WKWebView. A pure typesetter; takes its card from the URL fragment (see decisions.md). |
| `webapp/vendor/katex/` | KaTeX 0.16.11: `katex.min.js`, `katex.min.css`, LICENSE, and the 20 `.woff2` fonts only (~600 KB). |
| `test-render.js` | Unit tests for `render.js` (escaping, structure, math extraction). |
| `learnmax` | Shell entry point: `home` (default), `study`, `status`, `install`. First run copies `cards.example.json` to `cards.json`. |
| `docs/claude/` | These notes. |

## Removed

- The whole paradigm-table feature: grid game, matching game, ladder, capstone
  (`webapp/index.html`), `tables.example.json`, `deliver: "table"` handling,
  tables sync (`sync.py`), table checks (`validate-deck.py`).
- Direction/sibling logic: `ar2en`/`en2ar`, `base_of`, `_preferred_dir`,
  `_penalty`, `SIBLING_MIN_GAP`, `MIN_SESSION`, `ORDER_SLACK`.
- Multiple-choice: `options`, `hint`, option rows, distractor validation.
- `screenshots/` (all showed the Arabic UI). The README no longer embeds any.

## Rewritten

- **`drill.py`** -- docstring; `load_cards()` takes no `for_drill` argument;
  `order_queue()` is now: take the most-overdue reviews up to the cap, shuffle
  them, hold `NEW_RESERVED` slots for new cards, append new cards in deck order.
  `select_queue()` modes are `due`, `all`, `hardest`, `new`, `batch`,
  `topic:NAME`. `build_payload()` sends `front`/`back`/`cat`.
  `record_review()` no longer logs `dir`. `grade()` is unchanged.
- **`drill_ui.js`** -- full window rewrite. 760x680. WKWebView card face, three
  native buttons (Show answer / Still learning / Got it), keys space/return,
  `1`/`2`, left/right arrows, Esc. Emits `{t:'answer', id, correct}` exactly as
  before, where `correct` now means "got it".
- **`webapp/srs.js`** -- port of the new `order_queue`/`select_queue`; `grade`
  and merge untouched.
- **`webapp/index.html`** -- new drill screen (scrollable card pane, Show answer,
  two grade buttons showing the next interval, keyboard support), per-topic
  buttons on home. The GitHub-sync code is the old logic, unchanged.
- **`stats.py`, `home.py`, `home_ui.js`** -- topic buttons replace the
  vocab/sentences/direction buttons; `lesson` -> `batch`; trouble list shows
  card fronts; labels say "got it" instead of "right".
- **`cards.example.json`** -- 12 original cards across `math`, `ml`, `rl`
  (KL >= 0, Jensen, Cauchy-Schwarz, variance identity, bias-variance, logistic
  gradient, softmax+CE gradient, Bellman expectation, contraction, policy
  gradient, baselines, TD vs MC).
- **`validate-deck.py`** -- checks required string fields, duplicate ids, and the
  LaTeX-in-JSON mistakes: unbalanced `$` and control characters left by a
  single backslash (`\b`, `\f`, `\t`, `\r`, `\a`).
- **`test-queue.py` / `test-queue.js`** -- new invariants: cap and no repeats,
  oldest backlog wins, new-card drip and deck order, reserved slots, reviews
  before new, `due` serves only due cards, every mode serves what it says.
- **`README.md`** -- new intro, "How a session works", card format, modes, tests,
  landmines; table/option material removed.
- **`webapp/sw.js`** -- cache `learnmax-v1`; shell now includes `render.js`,
  `card.css`, KaTeX and all fonts so math works offline.

## Renamed / retitled

Arabic -> learnmax everywhere:

| Old | New |
|---|---|
| `arabic-drill.py` | `learnmax.py` |
| `arabic-drill.plist.template` | `learnmax.plist.template` |
| launchd label `local.arabic-drill` | `local.learnmax` |
| `ArabicDrill.app` / `ArabicHome.app` | `LearnmaxDrill.app` / `LearnmaxHome.app` |
| `Levantine Arabic.app` (Dock) | `Learnmax.app` |
| bundle ids `local.arabic-drill`, `local.arabic-home` | `local.learnmax`, `local.learnmax-home` |
| `Arabic.icns` | `LearnmaxDrill.icns` |
| example repos `arabic-drill-sync`, `arabic-drill-app` | `learnmax-sync`, `learnmax-app` |
| push topic `arabic-due`, tmpdir `arabic-pages` | `rl-due`, `rl-pages` |
| window/PWA/notification titles | "Learnmax" |

Other small edits: `.gitignore` (dropped tables and Arabic-export patterns),
`LICENSE` holder, `install.sh`, `launcher.js`, `deploy-webapp.sh`,
`push-send.js`, `notify.py`, `manifest.webmanifest`, `.github/workflows/ci.yml`
(adds `node test-render.js`). `icon_gen.js` now draws a sigma instead of the
Arabic ayn and `webapp/icon-180.png` / `icon-512.png` were regenerated from it.

## Not changed

- `grade()` in Python and JS, the merge rule, `golden-srs.json`, `gen-golden.py`,
  `test-srs.js`.
- All GitHub sync code (`sync.py` aside from tables, and the sync half of
  `index.html`), VAPID/push code, `notify.py` policy.
- The git remote still points at `willh003/arabic-drill`. (The local directory
  was renamed to `learnmax` by the user partway through this session.)

---

# Follow-up: removing a card

Added after the first pass: a **Remove this card** action (Mac: `x` key or the
link under the buttons; phone: link under the grade buttons, `x` on a desktop
browser).

- Not a grade -- the schedule is untouched; the card is simply never served
  again. Works before or after revealing the answer.
- **Storage:** `removed.json` (gitignored locally, synced through the sync repo),
  a map `{card id: {"removed": bool, "ts": UTC iso}}`. `cards.json` is never
  edited: the Mac owns it and overwrites the remote copy whenever it differs,
  so a phone-side edit would be lost, and a soft delete keeps history and is
  reversible.
- **Merge rule:** last write per card wins, tie -> removed
  (`sync.merge_removed` / `SRS.mergeRemoved`, parity-tested through new
  `removedCases` in `golden-srs.json`). A plain union of ids was rejected:
  restoring a card could never beat the earlier removal on the other device.
- `drill.py`: `load_removed*`, `change_removed` (under the state lock),
  `load_cards(include_removed=False)`, `run_window` re-filters after the sync
  pull and handles `{t:"remove"}` lines, `--removed`, `--restore ID`.
  `drill_ui.js`: `REMOVE` action, link + `x` key, "N removed" on the closing line.
  `index.html`: `removeCard()`, `pushRemoved()` (CAS retry like state), cached in
  `localStorage.removedMap`. `./learnmax removed|restore ID` wrap the CLI.
- Tests: removal/restore in `test-queue.py` and `test-queue.js`; merge parity in
  `test-srs.js`.
- Verified: Python and jsc tests pass; web flow checked in headless Chrome
  (removing the first card advanced to the next, live count 12 -> 11); Mac
  button layout checked via snapshot. **Not** verified: the Mac remove click/key
  in a live window (a session of the user's was open, so the app was not
  rebuilt or relaunched), and removal sync against a real GitHub repo.
- Note: an already-open window keeps the *old* build until it is closed
  (`build_app_from` refuses to replace a running app).
