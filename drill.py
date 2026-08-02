#!/usr/bin/env python3
"""
Levantine Arabic drill
======================

One window. One card. Four options. Click one, or press 1-4.

Owns its own spaced repetition -- no Anki, no add-ons, no browser. Card data
lives in cards.json next to this file; scheduling state in state.json.

Scheduling is SM-2 with same-day learning steps, which is the shape the
research supports: short reinforcement on the day you first meet a card, then
intervals that expand. Getting one wrong drops it back to the first step and
shaves the ease factor, so troublesome cards come round more often.

The window itself lives in drill_ui.js and is drawn by osascript, not by
Tkinter. This is not a preference. The system Tk that /usr/bin/python3 links
against is 8.5, and on macOS 26 its Aqua init refuses to start unless the host
binary was built for 26.x; the Command Line Tools python3 is built against the
14.4 SDK, so `tkinter.Tk()` aborts with SIGABRT before a window can exist.
With pip and venv ruled out there is no Python-side fix, so the UI is built
with AppKit through osascript's ObjC bridge -- also part of the base system,
also no installs.

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
                  (due, all, vocab, sentences, ar2en, en2ar, hardest, new,
                   lesson)
  --demo          open the window on sample cards without touching state.json
"""

import fcntl
import json
import os
import random
import subprocess
import sys
import time
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
CARDS = os.path.join(HERE, "cards.json")
STATE = os.path.join(HERE, "state.json")
UI = os.path.join(HERE, "drill_ui.js")
APP = os.path.join(HERE, "ArabicDrill.app")
PAYLOAD_FILE = os.path.join(HERE, ".drill-payload.json")
RESULTS_FILE = os.path.join(HERE, ".drill-results.jsonl")
LOG = os.path.join(HERE, "drill.log")

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

# Fewest cards between the two directions of the same item, when a session is
# short enough that both have to appear at all.
SIBLING_MIN_GAP = 6

# How many never-seen cards one sitting may introduce. The rest of the session
# is review. Without this a session can be eleven brand-new items at once,
# which is where the backlog came from -- meeting them is not learning them.
NEW_PER_SESSION = 12

# ...but never introduce *nothing*. Reviews are taken first, so once the
# backlog passes SESSION_CAP the leftovers run out and new material stops
# entirely -- a whole day can go by meeting no new words while you grind
# through cards you already know. These slots are held back for new cards and
# the oldest reviews wait a session instead. Set to 0 to go strictly
# backlog-first.
NEW_RESERVED = 6

# Below this, a session is too thin to be worth opening a window for, and only
# then is it worth showing both directions of the same item. Padding a healthy
# session with buried siblings just to reach the cap reintroduces the leak.
MIN_SESSION = 5

# Cards scoring within this of the best are treated as equally good, and one
# is taken at random. Strict best-first produces a perfect ar2en/en2ar/ar2en
# alternation, which is as predictable as the deck order it replaced. Kept
# below the same-item penalty, so siblings still never come round together.
ORDER_SLACK = 5


def log(msg):
    line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  {msg}"
    print(line, flush=True)
    try:
        with open(LOG, "a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def load_cards(for_drill=True):
    """The deck.

    Cards tagged deliver="table" belong to a paradigm (the pronouns and the
    possessive endings) that the phone teaches as a grid and a matching round
    instead of as isolated multiple-choice. They keep their schedule, their
    history and their ids -- they are simply not handed out as flashcards, so
    a paradigm is met as a system rather than sixteen unrelated facts.
    Pass for_drill=False when you need the whole deck (stats, sync, tables).
    """
    with open(CARDS) as fh:
        cards = json.load(fh)
    if for_drill:
        return [c for c in cards if c.get("deliver") != "table"]
    return cards


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
                "dir": card.get("dir", ""),
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


LOCKFILE = os.path.join(HERE, ".state.lock")


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


def base_of(card_id):
    """The item a card belongs to, without its direction.

    "vocab:ahlan:ar2en" and "vocab:ahlan:en2ar" are two tests of one item.
    """
    return card_id.rsplit(":", 1)[0]


def _preferred_dir(base):
    """Which way round to introduce an item, fixed per item.

    Deterministic rather than random so an item is always introduced the same
    way, but varying across items so the deck does not read as ar2en-first
    the whole way down.
    """
    return "en2ar" if sum(ord(ch) for ch in base) % 2 else "ar2en"


def _penalty(cand, out, gap):
    """How badly a card fits as the next one. Lower is better."""
    card = cand[0]
    p = 0

    # Never test the same item twice close together: the first showing hands
    # you the answer to the second.
    b = base_of(card["id"])
    recent = out[-gap:]
    for i, prev in enumerate(reversed(recent)):
        if base_of(prev[0]["id"]) == b:
            p += 100 * (gap - i)

    if out:
        last = out[-1][0]
        if last.get("dir") == card.get("dir"):
            p += 4
        if last.get("cat") == card.get("cat"):
            p += 1
        if last.get("lesson") == card.get("lesson"):
            p += 1
    if len(out) >= 2 and out[-1][0].get("dir") == card.get("dir") \
            and out[-2][0].get("dir") == card.get("dir"):
        p += 8                      # three of the same direction in a row

    return p


def order_queue(pairs, cap=SESSION_CAP, gap=SIBLING_MIN_GAP, new_cap=None):
    """Arrange a session so it doesn't feel like reading down a list.

    Two problems with serving the queue in deck order. The pair of cards for
    one item sit next to each other, so the second is free -- you have just
    read its answer. And whole runs share a direction, which turns the drill
    into "translate from Arabic" for ten cards and then "translate to Arabic"
    for ten more.

    So: keep only one direction per item where there is room to (the reverse
    is earned in a later session), then lay the rest out greedily, preferring
    a card that differs from what just went by. The backlog-before-new rule
    is applied within tiers, so it still holds.
    """
    if not pairs:
        return []

    def arrange(tier):
        """One card per item, choosing directions so the mix stays even.

        Both siblings are due, so which one to show now is a presentation
        choice, not a scheduling one -- the other stays due and leads the next
        session. Picking the under-represented direction each time is what
        stops a session being ten translations one way then ten the other.
        """
        order, by_base = [], {}
        for card, entry in tier:
            b = base_of(card["id"])
            if b not in by_base:
                by_base[b] = []
                order.append(b)
            by_base[b].append((card, entry))

        primary, held = [], []
        used = {"ar2en": 0, "en2ar": 0}
        for b in order:
            options = by_base[b]
            if len(options) == 1:
                pick = options[0]
            else:
                pick = min(options, key=lambda ce: (
                    used.get(ce[0].get("dir"), 0),
                    0 if ce[0].get("dir") == _preferred_dir(b) else 1))
            primary.append(pick)
            used[pick[0].get("dir")] = used.get(pick[0].get("dir"), 0) + 1
            held.extend(ce for ce in options if ce is not pick)
        return primary, held

    seen_primary, seen_held = arrange([p for p in pairs if p[1]["reps"] > 0])
    new_primary, new_held = arrange([p for p in pairs if p[1]["reps"] == 0])

    # The tiers are arranged separately, so an item with one direction already
    # reviewed and the other never seen comes out of both. Let the review side
    # keep it; the unseen direction waits for a later session.
    reviewed = {base_of(c["id"]) for c, _ in seen_primary}
    new_held += [ce for ce in new_primary if base_of(ce[0]["id"]) in reviewed]
    new_primary = [ce for ce in new_primary
                   if base_of(ce[0]["id"]) not in reviewed]

    # Fill from one-per-item first. Only if that cannot fill the session do
    # siblings come back, and the spacing rule keeps them apart.
    limit_new = NEW_PER_SESSION if new_cap is None else new_cap
    picked = seen_primary[:cap]
    room_for_new = min(cap - len(picked), limit_new)

    # Hold slots back for new material when reviews would otherwise fill the
    # session. The displaced reviews stay due and lead the next one.
    if new_primary and room_for_new < min(NEW_RESERVED, limit_new):
        picked = seen_primary[:max(0, cap - NEW_RESERVED)]
        room_for_new = min(cap - len(picked), limit_new)

    if room_for_new > 0:
        picked += new_primary[:room_for_new]

    # Only a genuinely thin session is worth padding with the reverse cards.
    if len(picked) < MIN_SESSION:
        for extra in (seen_held, new_held):
            if len(picked) < cap:
                picked += extra[:cap - len(picked)]

    # Interleave within each tier, so reviews still come before new material.
    out = []
    for tier in ([p for p in picked if p[1]["reps"] > 0],
                 [p for p in picked if p[1]["reps"] == 0]):
        remaining = list(tier)
        while remaining:
            scored = [(_penalty(cand, out, gap), i) for i, cand in enumerate(remaining)]
            best = min(s for s, _ in scored)
            near = [i for s, i in scored if s <= best + ORDER_SLACK]
            out.append(remaining.pop(random.choice(near)))
    return out


def select_queue(cards, state, mode="due", now=None, new_cap=None):
    """Pick what a session should contain.

    "due" is the scheduler talking and is what the scheduled firings use.
    Everything else is you overriding it from the home screen -- practice on
    demand, which deliberately ignores the due dates but still grades and
    reschedules normally.
    """
    now = now or datetime.now()

    if mode == "due":
        return order_queue(due_cards(cards, state, now), new_cap=new_cap)

    if mode in ("vocab", "sentences"):
        pool = [c for c in cards if c.get("cat") == mode]
    elif mode in ("ar2en", "en2ar"):
        pool = [c for c in cards if c.get("dir") == mode]
    elif mode == "hardest":
        pool = sorted(
            cards,
            key=lambda c: (-entry_for(state, c["id"])["lapses"],
                           entry_for(state, c["id"])["ease"]),
        )
        pool = [c for c in pool if entry_for(state, c["id"])["lapses"] > 0]
    elif mode == "new":
        pool = [c for c in cards if entry_for(state, c["id"])["reps"] == 0]
    elif mode == "lesson":
        # Whatever was added most recently. cards.json tags each batch with a
        # lesson id, so "the new stuff" is answerable without guessing.
        tags = sorted({c.get("lesson", "") for c in cards if c.get("lesson")})
        pool = [c for c in cards if c.get("lesson") == tags[-1]] if tags else []
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

KICKERS = {"ar2en": "CHOOSE THE MEANING", "en2ar": "CHOOSE THE ARABIC"}


def epoch(when):
    return round(when.timestamp())


def build_payload(cards, state, queue, now):
    """Everything drill_ui.js needs, so it never has to ask a second time.

    The two `dueIf*` values let the closing screen name the next due time
    without a round trip: grade() is pure, so both outcomes are known here.
    """
    items = []
    for card, entry in queue:
        opts = list(card["options"])
        random.shuffle(opts)
        items.append({
            "id": card["id"],
            "kicker": KICKERS.get(card["dir"], "CHOOSE THE ANSWER"),
            "prompt": card["prompt"],
            "answer": card["answer"],
            "hint": card.get("hint") or "",
            "options": opts,
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


def build_app_from(source, dest, display="Arabic Drill",
                   bundle_id="local.arabic-drill"):
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
    right = wrong = 0
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
        bases = {}
        for n, (card, entry) in enumerate(queue, 1):
            b = base_of(card["id"])
            note = "" if b not in bases else f"  <- same item as #{bases[b]}"
            bases.setdefault(b, n)
            tag = "new" if entry["reps"] == 0 else f"rep{entry['reps']}"
            print(f"  {n:2d}. {card['dir']:5s} {card['cat']:9s} {tag:5s} "
                  f"{card['prompt'][:38]:38s}{note}")
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
