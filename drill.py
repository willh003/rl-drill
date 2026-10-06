#!/usr/bin/env python3
"""
Learnmax
============

One window. One card. Read the front, say the answer to yourself, press space
to turn it over, then say whether you had it: 2 for "got it", 1 for "still
learning". A card is a question or a concept on the front and an answer or a
proof sketch on the back, written with $LaTeX$ where it helps.

Owns its own spaced repetition -- no Anki, no add-ons, no browser. Card data
lives in cards.json next to this file; scheduling state in state.json.

Scheduling is SM-2 with same-day learning steps, which is the shape the
research supports: short reinforcement on the day you first meet a card, then
intervals that expand. "Got it" counts as a correct answer and advances the
card; "still learning" drops it back to the first step and shaves the ease
factor, so troublesome cards come round more often. The scheduler does not
know the difference between self-graded and multiple-choice -- grade() takes
a boolean either way.

The window itself lives in drill_ui.js and is drawn by osascript, not by
Tkinter. This is not a preference. The system Tk that /usr/bin/python3 links
against is 8.5, and on macOS 26 its Aqua init refuses to start unless the host
binary was built for 26.x; the Command Line Tools python3 is built against the
14.4 SDK, so `tkinter.Tk()` aborts with SIGABRT before a window can exist.
With pip and venv ruled out there is no Python-side fix, so the UI is built
with AppKit through osascript's ObjC bridge -- also part of the base system,
also no installs. The card text itself is shown in a WKWebView, because
that is the only thing on the base system that can typeset math (KaTeX,
vendored under webapp/vendor).

There is deliberately no osascript-dialog fallback. When one was here, a
failure part-way through a session left a stack of modal `choose from list`
dialogs on screen that could not be dismissed and swallowed clicks meant for
everything else. A scheduled job that cannot show its window should go quiet
and say so in drill.log, not litter the screen.

Run with no arguments to study whatever is due.
  --status        print the queue and exit, no window
  --preview MODE  print the cards a session would serve, in order
  --minutes N     crank: nonstop rounds until N minutes have passed
  --mode MODE     study a chosen slice instead of what's due
                  (due, all, hardest, new, batch, or topic:NAME)
  --demo          open the window on sample cards without touching state.json
  --removed       list the cards you have removed
  --restore ID    bring a removed card back
"""

import fcntl
import json
import os
import shutil
import random
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CARDS = os.path.join(HERE, "cards.json")
STATE = os.path.join(HERE, "state.json")
UI = os.path.join(HERE, "drill_ui.js")
APP = os.path.join(HERE, "LearnmaxDrill.app")
PAYLOAD_FILE = os.path.join(HERE, ".drill-payload.json")
RESULTS_FILE = os.path.join(HERE, ".drill-results.jsonl")
LOG = os.path.join(HERE, "drill.log")

# Ids of cards you have removed ("this one isn't useful"). A separate file
# rather than an edit to cards.json: removal is reversible, history is kept,
# and the phone can remove a card without fighting the Mac over cards.json
# (the Mac is the source of truth for the deck and overwrites it on change).
REMOVED = os.path.join(HERE, "removed.json")

# Append-only history of every answer ever given. state.json only holds where
# each card currently sits, which cannot answer "how many did I do today" or
# "am I getting better", so the analytics read this instead.
REVIEWS = os.path.join(HERE, "reviews.jsonl")

# How long to keep following a session before giving up on it. Generous: the
# window is allowed to sit there while you think.
SESSION_TIMEOUT = 60 * 60

# Same-day reinforcement, then graduation to expanding intervals.
LEARNING_STEPS_MIN = [10, 30, 120]
GRADUATED_MIN = 24 * 60
EASE_START = 2.5
EASE_FLOOR = 1.3
EASE_PENALTY = 0.2
MAX_INTERVAL_MIN = 180 * 24 * 60

# Cards shown in a single sitting before it stops on its own.
SESSION_CAP = 20

# How many never-seen cards one sitting may introduce. The rest of the session
# is review. Without this a session can be a dozen brand-new proofs at once,
# which is where the backlog comes from -- meeting them is not learning them.
NEW_PER_SESSION = 12

# ...but never introduce *nothing*. Reviews are taken first, so once the
# backlog passes SESSION_CAP the leftovers run out and new material stops
# entirely -- a whole day can go by meeting no new material while you grind
# through cards you already know. These slots are held back for new cards and
# the oldest reviews wait a session instead. Set to 0 to go strictly
# backlog-first.
NEW_RESERVED = 6



def log(msg):
    line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  {msg}"
    print(line, flush=True)
    try:
        with open(LOG, "a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def utc_stamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def load_removed_map():
    """{card id: {"removed": bool, "ts": UTC iso}}.

    Last write per card wins (sync.merge_removed), so *restoring* a card is a
    real write that beats the earlier removal. A plain set of ids merged by
    union could never un-remove anything: the other device would put it back.
    """
    try:
        with open(REMOVED) as fh:
            m = json.load(fh)
        return m if isinstance(m, dict) else {}
    except (OSError, ValueError):
        return {}


def load_removed():
    return {cid for cid, v in load_removed_map().items() if v.get("removed")}


def save_removed_map(m):
    tmp = REMOVED + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(m, fh, indent=1, sort_keys=True)
    os.replace(tmp, REMOVED)


def change_removed(add=(), drop=()):
    """Remove / restore cards under the state lock, so a window and a sync
    cannot lose each other's change. Returns the set of removed ids."""
    with open(LOCKFILE, "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        try:
            m = load_removed_map()
            ts = utc_stamp()
            for cid in add:
                m[cid] = {"removed": True, "ts": ts}
            for cid in drop:
                m[cid] = {"removed": False, "ts": ts}
            save_removed_map(m)
        finally:
            fcntl.flock(lk, fcntl.LOCK_UN)
    return load_removed()


def load_cards(include_removed=False):
    """The deck: a JSON array of {id, front, back, cat, batch?}.

    `cat` is the topic ("rl", "math", "ml"...) and `batch` tags a group added
    together, so "the newest stuff" is answerable without guessing. Cards you
    removed are left out unless include_removed is set.
    """
    with open(CARDS) as fh:
        cards = json.load(fh)
    if include_removed:
        return cards
    gone = load_removed()
    return [c for c in cards if c["id"] not in gone]


LOCKFILE = os.path.join(HERE, ".state.lock")


def load_state():
    try:
        with open(STATE) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(state):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh, indent=1)
    os.replace(tmp, STATE)  # atomic, so a crash mid-write can't corrupt it


def record_review(card, correct, now=None):
    """Append one answer to the history. Never fatal: a failed write costs a
    line of analytics, and must not cost the answer itself."""
    now = now or datetime.now()
    try:
        with open(REVIEWS, "a") as fh:
            fh.write(json.dumps({
                "ts": now.isoformat(timespec="seconds"),
                "id": card["id"],
                "correct": bool(correct),
                "cat": card.get("cat", ""),
            }) + "\n")
    except OSError:
        pass


def load_reviews():
    out = []
    try:
        with open(REVIEWS) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        pass
    return out


def commit_answer(cid, entry, correct, card, now=None):
    """Grade one answer and merge it into state.json under a file lock.

    The web server and a desktop session can both be grading at once, and
    each holds its own in-memory queue. Rewriting the whole state dict from
    either side would silently undo the other's answers, so every commit
    re-reads the file, changes one key, and writes it back while holding an
    exclusive lock. Returns the graded entry.
    """
    graded = grade(entry, correct, now)
    with open(LOCKFILE, "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        try:
            fresh = load_state()
            fresh[cid] = graded
            save_state(fresh)
        finally:
            fcntl.flock(lk, fcntl.LOCK_UN)
    record_review(card, correct, now)
    return graded


def entry_for(state, card_id):
    return state.get(card_id) or {
        "due": "1970-01-01T00:00:00",
        "step": 0,
        "interval_min": 0,
        "ease": EASE_START,
        "reps": 0,
        "lapses": 0,
    }


def due_cards(cards, state, now=None):
    now = now or datetime.now()
    out = []
    for card in cards:
        e = entry_for(state, card["id"])
        if datetime.fromisoformat(e["due"]) <= now:
            out.append((card, e))
    # Cards seen before come first -- clearing a backlog beats meeting new
    # material you have no hope of retaining yet.
    out.sort(key=lambda pair: (pair[1]["reps"] == 0, pair[1]["due"]))
    return out


def order_queue(pairs, cap=SESSION_CAP, new_cap=None):
    """Arrange a session: reviews first, then new material.

    `pairs` arrives most-overdue first (due_cards sorts that way), so taking
    the head of it clears the oldest backlog first. The reviews that make the
    cut are then shuffled, so a session does not replay the deck in the order
    you last saw it -- that order is a cue, and recall should come from the
    question. New cards stay in deck order: a batch is usually written
    foundations-first, and meeting a proof before its definitions is not
    learning.
    """
    if not pairs:
        return []

    seen = [p for p in pairs if p[1]["reps"] > 0]
    fresh = [p for p in pairs if p[1]["reps"] == 0]

    limit_new = NEW_PER_SESSION if new_cap is None else new_cap
    picked_seen = seen[:cap]
    room_for_new = min(cap - len(picked_seen), limit_new)

    # Hold slots back for new material when reviews would otherwise fill the
    # session. The displaced reviews stay due and lead the next one.
    if fresh and room_for_new < min(NEW_RESERVED, limit_new):
        picked_seen = seen[:max(0, cap - NEW_RESERVED)]
        room_for_new = min(cap - len(picked_seen), limit_new)

    picked_new = fresh[:room_for_new] if room_for_new > 0 else []
    random.shuffle(picked_seen)
    return picked_seen + picked_new


def select_queue(cards, state, mode="due", now=None, new_cap=None):
    """Pick what a session should contain.

    "due" is the scheduler talking and is what the scheduled firings use.
    Everything else is you overriding it from the home screen -- practice on
    demand, which deliberately ignores the due dates but still grades and
    reschedules normally.

    Modes: due, all, hardest, new, batch (the most recently added group), and
    "topic:NAME" for one `cat`.
    """
    now = now or datetime.now()

    if mode == "due":
        return order_queue(due_cards(cards, state, now), new_cap=new_cap)

    if mode.startswith("topic:"):
        topic = mode.split(":", 1)[1]
        pool = [c for c in cards if c.get("cat") == topic]
    elif mode == "hardest":
        pool = sorted(
            cards,
            key=lambda c: (-entry_for(state, c["id"])["lapses"],
                           entry_for(state, c["id"])["ease"]),
        )
        pool = [c for c in pool if entry_for(state, c["id"])["lapses"] > 0]
    elif mode == "new":
        pool = [c for c in cards if entry_for(state, c["id"])["reps"] == 0]
    elif mode == "batch":
        tags = sorted({c.get("batch", "") for c in cards if c.get("batch")})
        pool = [c for c in cards if c.get("batch") == tags[-1]] if tags else []
    else:
        pool = list(cards)

    if mode != "hardest":
        # Due ones first so a practice run still clears real work, then the
        # rest in a shuffled order rather than always the same opening cards.
        due_ids = {c["id"] for c, _ in due_cards(cards, state, now)}
        head = [c for c in pool if c["id"] in due_ids]
        tail = [c for c in pool if c["id"] not in due_ids]
        random.shuffle(tail)
        pool = head + tail

    # Pressing "New cards" is a deliberate choice, so the per-session drip
    # that protects the scheduled firings does not apply to it.
    if new_cap is None and mode == "new":
        new_cap = SESSION_CAP
    return order_queue([(c, entry_for(state, c["id"])) for c in pool],
                       new_cap=new_cap)


def next_due_at(cards, state, now=None):
    now = now or datetime.now()
    upcoming = []
    for card in cards:
        e = entry_for(state, card["id"])
        d = datetime.fromisoformat(e["due"])
        if d > now:
            upcoming.append(d)
    return min(upcoming) if upcoming else None


def grade(entry, correct, now=None):
    """Advance one card's schedule. Returns the updated entry."""
    now = now or datetime.now()
    e = dict(entry)

    if correct:
        e["reps"] += 1
        if e["step"] < len(LEARNING_STEPS_MIN):
            wait = LEARNING_STEPS_MIN[e["step"]]
            e["step"] += 1
        elif e["interval_min"] < GRADUATED_MIN:
            wait = GRADUATED_MIN
        else:
            wait = int(e["interval_min"] * e["ease"])
        e["interval_min"] = min(wait, MAX_INTERVAL_MIN)
    else:
        e["lapses"] += 1
        e["step"] = 0
        e["ease"] = max(EASE_FLOOR, e["ease"] - EASE_PENALTY)
        wait = LEARNING_STEPS_MIN[0]
        e["step"] = 1
        e["interval_min"] = wait

    e["due"] = (now + timedelta(minutes=wait)).isoformat(timespec="seconds")
    return e


def human_delta(when, now=None):
    now = now or datetime.now()
    secs = (when - now).total_seconds()
    if secs < 90:
        return "in a moment"
    mins = secs / 60
    if mins < 60:
        return f"in {round(mins)} min"
    hours = mins / 60
    if hours < 24:
        return f"in {round(hours)}h"
    return f"in {round(hours / 24)}d"


# --------------------------------------------------------------------------
# UI
# --------------------------------------------------------------------------

def epoch(when):
    return round(when.timestamp())


def build_payload(cards, state, queue, now):
    """Everything drill_ui.js needs, so it never has to ask a second time.

    The two `dueIf*` values let the closing screen name the next due time
    without a round trip: grade() is pure, so both outcomes are known here.
    "Right" is "got it"; "wrong" is "still learning".
    """
    items = []
    for card, entry in queue:
        items.append({
            "id": card["id"],
            "cat": card.get("cat", ""),
            "front": card["front"],
            "back": card["back"],
            "dueIfRight": epoch(
                datetime.fromisoformat(grade(entry, True, now)["due"])),
            "dueIfWrong": epoch(
                datetime.fromisoformat(grade(entry, False, now)["due"])),
        })

    nxt = next_due_at(cards, state, now)
    return {
        "cards": items,
        "baselineNextDue": epoch(nxt) if nxt else None,
        "remaining": max(0, len(due_cards(cards, state, now)) - len(queue)),
    }


def set_icon(app, icns):
    """Give an osacompile applet our icon.

    The applet's Info.plist names an icon asset (CFBundleIconName) backed by
    Assets.car, which holds the generic script icon and wins over applet.icns.
    Drop both, then re-sign ad hoc since the bundle contents changed.
    """
    res = os.path.join(app, "Contents", "Resources")
    shutil.copy(icns, os.path.join(res, "applet.icns"))
    if os.path.exists(os.path.join(res, "Assets.car")):
        os.remove(os.path.join(res, "Assets.car"))
    subprocess.run(["/usr/bin/plutil", "-remove", "CFBundleIconName",
                    os.path.join(app, "Contents", "Info.plist")],
                   check=False, capture_output=True)
    subprocess.run(["/usr/bin/codesign", "-f", "-s", "-", app],
                   check=False, capture_output=True)


def build_app_from(source, dest, display="Learnmax",
                   bundle_id="local.learnmax"):
    """Compile a JXA source file into an .app, if it is missing or stale.

    The window has to be a LaunchServices app or macOS will not give it the
    keyboard when launchd is the parent -- see the header of drill_ui.js.
    osacompile ships with macOS, so this stays within the no-installs rule.
    """
    fresh = (os.path.isdir(dest) and
             os.path.getmtime(dest) >= os.path.getmtime(source))
    if fresh:
        return dest

    # Never swap the bundle out from under a running copy. Replacing the
    # executable of a live app gets that app killed by the kernel, which looks
    # exactly like the drill crashing when you click something.
    if os.path.isdir(dest) and app_running(dest):
        log(f"{os.path.basename(source)} changed but {os.path.basename(dest)}"
            " is open -- keeping the old build")
        return dest

    # osacompile only produces a bundle when the output name ends in .app,
    # so stage it inside a scratch directory rather than renaming it later.
    staging = os.path.join(HERE, ".drill-build")
    tmp = os.path.join(staging, os.path.basename(dest))
    subprocess.run(["/bin/rm", "-rf", staging], check=False)
    os.makedirs(staging, exist_ok=True)
    subprocess.run(
        ["/usr/bin/osacompile", "-s", "-l", "JavaScript", "-o", tmp, source],
        check=True, capture_output=True,
    )

    # Give it a name and an identity, so it reads properly in the Dock and in
    # cmd-tab rather than as a stray script applet.
    info = os.path.join(tmp, "Contents", "Info.plist")
    for key, value in (("CFBundleName", display),
                       ("CFBundleDisplayName", display),
                       ("CFBundleIdentifier", bundle_id)):
        subprocess.run(
            ["/usr/bin/plutil", "-replace", key, "-string", value, info],
            check=False, capture_output=True,
        )

    icon = os.path.join(HERE, "Learnmax.icns")
    if os.path.isfile(icon):
        set_icon(tmp, icon)

    subprocess.run(["/bin/rm", "-rf", dest], check=False)
    os.replace(tmp, dest)
    subprocess.run(["/bin/rm", "-rf", staging], check=False)
    # LaunchServices caches bundle metadata by path; re-registering avoids it
    # launching a stale copy after a rebuild.
    subprocess.run(
        ["/System/Library/Frameworks/CoreServices.framework/Frameworks/"
         "LaunchServices.framework/Support/lsregister", "-f", dest],
        check=False, capture_output=True,
    )
    log(f"rebuilt {os.path.basename(dest)}")
    return dest


def build_app():
    return build_app_from(UI, APP)


def run_window(cards, state, persist=True, mode="due", new_cap=None,
               extra_payload=None):
    """Open the drill window and grade answers as they arrive.

    Each answer is applied and written to disk the moment the window reports
    it, so force-quitting mid-session costs at most the card on screen.
    `persist` is off only for --demo, which must not touch the real schedule.
    """
    try:
        import sync
        if sync.pull():
            state.clear()
            state.update(load_state())   # phone progress arrived; use it
    except Exception:
        pass

    # A sync just now may have brought removals from the phone.
    gone = load_removed()
    cards = [c for c in cards if c["id"] not in gone]

    now = datetime.now()
    queue = select_queue(cards, state, mode, now, new_cap=new_cap)
    if not queue:
        return None  # nothing to do; caller stays quiet

    # A session left open must not collect a second window on the next
    # firing. Two stacked drills is worse than a missed hour.
    if app_running(APP):
        log("a session is already open -- leaving it alone")
        return None

    entries = {card["id"]: entry for card, entry in queue}
    by_id = {card["id"]: card for card, _ in queue}

    # Wait for a previous window to finish dying. Without this its closing
    # line lands in the file we are about to read and reads as an instant
    # empty session.
    for _ in range(40):
        if not app_running(APP):
            break
        time.sleep(0.1)

    session = f"{time.time():.3f}"
    payload = build_payload(cards, state, queue, now)
    payload["session"] = session
    payload.update(extra_payload or {})
    with open(PAYLOAD_FILE, "w") as fh:
        json.dump(payload, fh)
    with open(RESULTS_FILE, "w"):
        pass  # truncate; the window appends to it

    app = build_app()
    subprocess.run(["/usr/bin/open", "-n", "-a", app], check=True,
                   capture_output=True)

    # `open` returns immediately, so follow the results file rather than a
    # pipe. Polling also copes with the window being closed or escaped.
    right = wrong = removed = 0
    seen = 0
    done = False
    end_reason = None
    started = time.time()
    ever_running = False
    relaunched = False

    while time.time() - started < SESSION_TIMEOUT:
        time.sleep(0.15)
        try:
            with open(RESULTS_FILE) as fh:
                lines = fh.read().splitlines()
        except OSError:
            lines = []

        for line in lines[seen:]:
            seen += 1
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("s") != session:
                continue        # left over from an earlier window
            kind = msg.get("t")
            if kind == "answer" and msg.get("id") in entries:
                cid = msg["id"]
                if persist:
                    state[cid] = commit_answer(cid, entries[cid],
                                               bool(msg["correct"]), by_id[cid])
                else:
                    state[cid] = grade(entries[cid], bool(msg["correct"]))
                if msg["correct"]:
                    right += 1
                else:
                    wrong += 1
            elif kind == "remove" and msg.get("id") in by_id:
                # Not graded: the card is simply never shown again.
                if persist:
                    change_removed(add=[msg["id"]])
                removed += 1
            elif kind == "done":
                done = True
                end_reason = msg.get("reason")
            elif kind == "error":
                raise RuntimeError(msg.get("msg", "window reported an error"))

        if done:
            break

        running = app_running(app)
        ever_running = ever_running or running
        # Allow a few seconds for the app to show up in the process table
        # before treating its absence as a failure to launch.
        if not running and time.time() - started > 8:
            if seen == 0 and not ever_running and not relaunched:
                # It never came up at all. A rebuild re-registers the bundle
                # with LaunchServices, and an `open` racing that can quietly
                # do nothing -- so try once more before giving up.
                relaunched = True
                log("window did not come up -- retrying once")
                subprocess.run(["/usr/bin/open", "-n", "-a", app],
                               check=False, capture_output=True)
                started = time.time()
                continue
            if seen == 0:
                raise RuntimeError("window exited without showing a card")
            break

    try:
        import sync
        sync.push()
    except Exception:
        pass
    return right, wrong, end_reason


def timed_run(cards, state, minutes=30):
    """Nonstop rounds until the clock runs out.

    Each round is a normal capped session; when one finishes, the next opens
    immediately. Cards answered early in the crank come back due inside it --
    the 10-minute learning step cycles naturally within half an hour. When
    nothing is due, it keeps going in practice mode rather than stalling.
    Escaping the window ends the whole crank, not just the round.
    """
    deadline = time.time() + minutes * 60
    total_right = total_wrong = rounds = 0
    # A crank should not gorge on new cards: two sessions' worth, then the
    # rest of the half hour is review.
    new_allowance = NEW_PER_SESSION * 2

    while time.time() < deadline - 20:
        now = datetime.now()
        mode = "due" if due_cards(cards, state, now) else "all"
        queue = select_queue(cards, state, mode, now, new_cap=new_allowance)
        if not queue:
            break
        new_allowance = max(0, new_allowance -
                            sum(1 for _, e in queue if e["reps"] == 0))
        result = run_window(cards, state, mode=mode, new_cap=new_allowance,
                            extra_payload={"crankEndsAt": round(deadline)})
        if not result:
            break
        r, w, reason = result
        total_right += r
        total_wrong += w
        rounds += 1
        log(f"crank round {rounds}: {r} right, {w} wrong ({mode})")
        if reason in ("escape", "window-closed"):
            break

    return total_right, total_wrong, rounds


def app_running(app):
    res = subprocess.run(["/usr/bin/pgrep", "-f", os.path.basename(app)],
                         capture_output=True, text=True)
    return res.returncode == 0


def main():
    cards = load_cards()
    state = load_state()

    if "--removed" in sys.argv:
        gone = load_removed()
        by_id = {c["id"]: c for c in load_cards(include_removed=True)}
        for cid in sorted(gone):
            front = " ".join(by_id[cid]["front"].split())[:70] \
                if cid in by_id else "(not in cards.json)"
            print(f"{cid}  {front}")
        print(f"{len(gone)} removed")
        return 0

    if "--restore" in sys.argv:
        i = sys.argv.index("--restore")
        if len(sys.argv) <= i + 1:
            print("usage: drill.py --restore ID")
            return 1
        change_removed(drop=[sys.argv[i + 1]])
        print(f"restored {sys.argv[i + 1]}")
        try:
            import sync
            sync.push()
        except Exception:
            pass
        return 0

    if "--status" in sys.argv:
        q = due_cards(cards, state)
        nxt = next_due_at(cards, state)
        print(f"{len(q)} due now of {len(cards)}")
        if nxt:
            print(f"next: {nxt.isoformat(timespec='minutes')} ({human_delta(nxt)})")
        return 0

    if "--preview" in sys.argv:
        i = sys.argv.index("--preview")
        mode = sys.argv[i + 1] if len(sys.argv) > i + 1 else "due"
        queue = select_queue(cards, state, mode)
        print(f"{mode}: {len(queue)} card(s)")
        for n, (card, entry) in enumerate(queue, 1):
            tag = "new" if entry["reps"] == 0 else f"rep{entry['reps']}"
            front = " ".join(card["front"].split())
            print(f"  {n:2d}. {card.get('cat', ''):8s} {tag:5s} {front[:60]}")
        return 0

    if "--demo" in sys.argv:
        # Open the window on the first few cards against a throwaway state,
        # so the real schedule is untouched. For checking the UI works.
        run_window(cards[:3], {}, persist=False)
        return 0

    # Most firings land here: nothing due, no window, nothing said. Eight
    # times a day, a "nothing to do" popup would just train reflex dismissal.
    if not due_cards(cards, state):
        log("nothing due -- staying quiet")
        return 0

    if "--minutes" in sys.argv:
        i = sys.argv.index("--minutes")
        mins = float(sys.argv[i + 1]) if len(sys.argv) > i + 1 else 30
        r, w, rounds = timed_run(load_cards(), state, mins)
        log(f"crank done: {rounds} round(s), {r} right, {w} wrong")
        return 0

    mode = "due"
    if "--mode" in sys.argv:
        i = sys.argv.index("--mode")
        if len(sys.argv) > i + 1:
            mode = sys.argv[i + 1]

    try:
        result = run_window(cards, state, mode=mode)
    except Exception as exc:
        # Quiet failure on purpose: see the module docstring.
        log(f"could not open the window ({exc}) -- staying quiet")
        return 0

    if result:
        right, wrong, _ = result
        log(f"session done: {right} right, {wrong} wrong")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
