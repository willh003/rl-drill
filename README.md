# arabic-drill

A personal spaced-repetition system for Levantine Arabic with zero
dependencies: no Anki, no server, no npm install, no pip install. A Mac
shows you a card at scheduled hours; an iPhone web app drills the same
deck anywhere; the two stay in sync through a private GitHub repo; and
real lock-screen push notifications arrive when enough cards are due.

Built for one learner and published as-is. The deck format is generic —
swap the content and it drills anything with a prompt, an answer and
four options.

## What it looks like

The Mac, at a scheduled hour — one window, one card, four options,
keys 1–4. A wrong answer shows the right one and the hint, then moves
on:

<p align="center">
  <img src="screenshots/drill-graded.png" width="520"
       alt="Desktop drill window: a graded card with the wrong pick in red and the correct answer in green">
</p>

The home screen and its analytics page:

<p align="center">
  <img src="screenshots/home.png" width="390"
       alt="Desktop home window: due count, streak, and session mode buttons">
  <img src="screenshots/stats.png" width="390"
       alt="Desktop analytics window: 14-day bar chart, deck spread, upcoming load, trouble cards">
</p>

The same deck on the phone — drill, paradigm grid, and matching round,
all feeding the same schedule:

<p align="center">
  <img src="screenshots/phone-home.png" width="190"
       alt="Phone home screen with due count and session modes">
  <img src="screenshots/phone-graded.png" width="190"
       alt="Phone drill with a graded card">
  <img src="screenshots/phone-grid.png" width="190"
       alt="Paradigm grid mid-game: pronouns, endings and possessed forms placed by person">
  <img src="screenshots/phone-match.png" width="190"
       alt="Matching round: persons against pronouns, both sides shuffled">
</p>

## How it fits together

The "backend" is a private GitHub repo. That sounds like a joke and is
actually the whole trick: both devices treat the repo as a shared disk
with atomic writes — free, durable, authenticated, reachable from
anywhere, and with nothing of yours running on a server. The Mac talks
to it with the already-authenticated `gh` CLI; the phone talks to it
with `fetch` and a fine-grained token that can see this one repo and
nothing else.

```mermaid
flowchart TB
    subgraph mac["Mac"]
        direction TB
        drill["drill.py + the windows<br/>scheduler and sessions"]
        sync["sync.py<br/>pull, merge, push"]
        notify["notify.py + push-send.js<br/>encrypted Web Push"]
    end

    subgraph phone["iPhone — home-screen web app"]
        direction TB
        app["index.html + srs.js<br/>drill, grid, matching"]
        sw["sw.js<br/>offline shell, notifications"]
    end

    subgraph repo["private GitHub repo — the only shared state"]
        direction LR
        state["state.json<br/>per-card schedule"]
        cards["cards.json<br/>tables.json<br/>the deck"]
        hist["reviews.jsonl<br/>reviews-phone.jsonl<br/>answer history"]
        sub["push-<br/>subscription.json"]
    end

    sync <-->|"contents API via gh,<br/>compare-and-swap on SHA"| repo
    app <-->|"contents API via fetch,<br/>fine-grained PAT"| repo
    notify -->|"encrypted POST"| apns["Apple's push service"]
    apns -.->|"lock-screen<br/>notification"| sw
```

### Two writers, no server, no lost answers

A shared file that two devices update independently is a recipe for
one overwriting the other. The contents API prevents that for free:
every write names the file version (blob SHA) it expects to replace,
so a stale write fails cleanly instead of clobbering. The loser
re-reads, merges per card, and tries again:

```mermaid
sequenceDiagram
    participant P as Phone
    participant G as GitHub (state.json)
    participant M as Mac

    Note over P,M: both devices graded cards while apart
    P->>G: PUT state.json, expect sha abc
    G-->>P: 200 — new sha def
    M->>G: PUT state.json, expect sha abc
    G-->>M: 409 — abc is stale
    M->>G: GET state.json
    G-->>M: content at def, with the phone's answers
    Note over M: merge per card, then try again
    M->>G: PUT merged state, expect sha def
    G-->>M: 200 — new sha ghi
    Note over P,M: nobody's answers were lost
```

The merge is per card, and the rule is the same in `sync.py` and
`srs.js` (the golden test holds them together). It works because the
scheduler gives every answer a fingerprint: each one increments `reps`
or `lapses`, so `reps + lapses` is a monotonic count of how much
history an entry has seen — the entry with more history wins,
regardless of which device it came from or when it arrived:

```mermaid
flowchart TD
    start(["for each card id in either copy"]) --> both{"an entry on<br/>both sides?"}
    both -->|no| only["keep the one that exists"]
    both -->|yes| count{"reps + lapses<br/>equal?"}
    count -->|no| more["keep the larger total —<br/>every answer increments one of them,<br/>so a larger total has seen more history"]
    count -->|yes| due["same amount of history:<br/>keep the later due date"]
```

### How a Mac sends an iPhone a lock-screen notification

The same repo carries the push plumbing. The phone's push subscription
(an endpoint at Apple's push service plus its public keys) syncs to
the Mac as just another file; the Mac encrypts a payload against it
(RFC 8291), signs the request with its VAPID key (RFC 8292), and hands
it to Apple. No third-party push provider, no server — one Node script
with zero dependencies, validated against the RFC's own test vectors:

```mermaid
sequenceDiagram
    participant A as App (installed on the Home Screen)
    participant R as private repo
    participant M as Mac (hourly firing)
    participant W as Apple's push service

    A->>A: Enable notifications
    A->>R: PUT push-subscription.json
    M->>R: sync pull
    R-->>M: subscription — endpoint + keys
    Note over M: off-hour? too few due? studied<br/>in the last 90 min? then stay quiet
    M->>W: POST, payload encrypted (RFC 8291),<br/>VAPID-signed (RFC 8292)
    W-->>A: native lock-screen notification
    A->>A: tap opens the app on the queue
```

### The scheduler

The scheduler is SM-2 with same-day learning steps:

* learning steps 10 min → 30 min → 2 h, then graduation to 1 day,
  then `interval *= ease`
* ease starts at 2.5, floor 1.3, −0.2 per lapse
* a wrong answer resets to the first step
* intervals cap at 180 days

An unbroken correct streak walks exactly:
`10m, 30m, 2h, 1d, 2.5d, 6.25d, 15.6d, 39.1d, 97.7d`.
`drill.py` is the reference implementation; `webapp/srs.js` is a
line-for-line port, and CI proves they grade identically on every
answer sequence up to length 6 plus the full ladder (`node
test-srs.js`). If you change one side, change the other, run
`python3 gen-golden.py`, and let the tests tell you the truth.

## What runs where

The **Mac side** needs macOS: the windows are AppKit via JXA (see
"Landmines" for why), scheduling is launchd, and the push sender runs
under node (any recent version; it uses only built-in `crypto`). The
system `/usr/bin/python3` is enough — nothing is installed.

The **phone side** is a plain static web app and works on its own. If
you only want the phone experience, you need nothing but the two GitHub
repos and any way to upload `cards.json` to the sync repo — no Mac at
all. (Without a Mac you lose scheduled desktop sessions and push
notifications, since the Mac is what sends those.)

## Setup

### 1. The deck

```
cp config.example.json config.json          # fill in as you go below
cp cards.example.json cards.json
cp tables.example.json tables.json
```

Edit `cards.json`. Each card:

```json
{
  "id": "vocab:bayt:ar2en",       // cat:item:direction — the two directions
  "dir": "ar2en",                 //   of one item share the cat:item prefix
  "prompt": "bayt",
  "answer": "house",
  "hint": "",                     // shown after a wrong answer
  "options": ["house", "water", "bread", "sun"],   // exactly 4, incl. answer
  "cat": "vocab",                 // "vocab" or "sentences"
  "lesson": "lesson-001-basics",  // batches; "Latest batch" studies the last
  "deliver": "table"              // optional: teach via the paradigm grid,
}                                 //   never as a flashcard
```

Pick distractors from the same semantic group so nothing is guessable by
elimination. Cards tagged `deliver: "table"` belong to a paradigm the
phone teaches as a grid and a matching round instead of as isolated
multiple-choice — `tables.example.json` shows the shape, and its
`cardId` cells must point at cards in your deck. Keep the paradigm keys
`pron`, `ending`, `book`; the app refers to them by name. Then:

```
python3 validate-deck.py cards.json tables.json
```

### 2. The Mac drill (works with no GitHub at all)

```
/usr/bin/python3 drill.py --status     # what's due, no window
/usr/bin/python3 drill.py              # study what's due
/usr/bin/python3 home.py               # home screen: stats + session modes
sh install.sh                          # hourly launchd job + Dock launcher
```

Other modes: `--preview MODE` prints the session a mode would serve;
`--minutes N` cranks nonstop rounds; `--mode vocab|sentences|ar2en|
en2ar|hardest|new|lesson|all` studies a slice; `--demo` opens the
window without touching your schedule. Most scheduled firings find
nothing due and exit silently — that is by design.

### 3. The private sync repo

```
gh auth login                                    # if you haven't
gh repo create YOURUSER/arabic-drill-sync --private
```

Put `syncRepo` in `config.json`. The Mac now pulls/pushes around every
session and uploads your `cards.json` and `tables.json` whenever they
change. Nothing else to seed.

### 4. The phone app

```
gh repo create YOURUSER/arabic-drill-app --public
gh api -X POST repos/YOURUSER/arabic-drill-app/pages \
       -f build_type=legacy -f "source[branch]=main" -f "source[path]=/"
```

Fill `pagesRepo` and `appUrl` in `config.json`, then:

```
sh deploy-webapp.sh
```

This generates `webapp/config.json` (sync repo name + push key) and
pushes `webapp/` to the Pages repo as one commit. The Pages repo is a
build artifact — never edit it by hand, always redeploy.

On the phone, the app needs its own credential — mint a **fine-grained
personal access token** at github.com → Settings → Developer settings:

* Repository access: **Only select repositories** → your sync repo
* Permissions: **Contents: Read and write** — and nothing else

Open the app's URL in Safari, paste the token, then **Share → Add to
Home Screen** and open it from there. (If the token is wrong, the app
tells you exactly which screw to turn — GitHub returns 404 rather than
403 for a token that cannot see a private repo, and the app probes the
repo to disambiguate.)

### 5. Notifications (optional)

```
node gen-vapid.js        # one-time keypair; writes .vapid.json (0600)
sh deploy-webapp.sh      # redeploy so the app carries the public key
```

Set `contact` in `config.json` (a `mailto:` you can be reached at — the
push service requires it). In the installed app, tap **Enable
notifications**; the subscription syncs back to the Mac through the
repo. The Mac then notifies at 9, 13, 17 and 21 o'clock, only when at
least 15 cards are due and you haven't studied in the last 90 minutes
(`NOTIFY_HOURS`, `MIN_DUE`, `QUIET_MIN` in `notify.py`).

iOS only exposes Web Push to home-screen web apps — in a plain Safari
tab the button explains this instead of working. `.vapid.json` holds
the private key: never commit it, never share it. If it leaks, delete
it, re-key, redeploy, and re-enable on the phone.

## Tests

```
python3 gen-golden.py     # regenerate vectors from the reference
node test-srs.js          # scheduler parity, field-exact
python3 test-queue.py     # session invariants, reference side
node test-queue.js        # session invariants, ported side
node push-send.js --test  # RFC 8291 known-answer vector
python3 validate-deck.py  # deck shape
```

CI (GitHub Actions) runs all of the above and regenerates the golden
file, so a scheduler edit that forgets one side cannot land green.

## Landmines

Things in this codebase that look wrong and are not. Each cost real
debugging; do not "fix" them.

* **No Tkinter.** The system Tk 8.5 aborts with SIGABRT on modern
  macOS under the CLT python3. Hence AppKit through the JXA bridge.
* **`NSBox`, never `CALayer`.** Assigning a `CGColorRef` through the
  JXA bridge crashes with `EXC_ARM_PAC_FAIL`. Fills and borders are
  NSBox.
* **The window must be a compiled applet** (`osacompile`). A bare
  osascript process launched by launchd never receives the keyboard.
  And never rebuild the `.app` while it is running — the kernel kills
  it; `build_app_from` guards this.
* **JXA quirks:** `NSButton.tag` comes back as a *string* (`parseInt`
  it — a missing parseInt once made every answer grade as correct);
  `NSTextAlignment` is UIKit-ordered (centre = 1);
  `$.NSDefaultRunLoopMode` is undefined.
* **Session tokens** in the payload/results files stop a dying
  window's parting line being read as the next session's result.
* **`fcntl.flock` in `commit_answer`:** two frontends can grade
  concurrently; every commit re-reads state under an exclusive lock,
  changes one key, writes back.
* **`body { overflow: hidden }`** in the PWA is deliberate; each
  scrollable screen has its own scroller. The class `.tile` belongs to
  the home stat tiles; the table game uses `.gtile` for exactly that
  reason.
* **The scheduler is done.** SM-2 here is tested, characterised and
  deliberately boring. Improvements welcome elsewhere.

## License

MIT — see [LICENSE](LICENSE). The example deck and tables are original
to this repository and covered by the same license. If you build a deck
from a textbook or someone else's Anki export, that content is theirs:
study from it privately, don't redistribute it.
