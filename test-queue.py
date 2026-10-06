#!/usr/bin/env python3
"""Queue-building invariants for drill.py (the reference side).

test-queue.js asserts the same invariants over webapp/srs.js. The queue
builders shuffle on purpose, so every scenario runs many times: an invariant
that only usually holds is a bug.

  * a session never exceeds SESSION_CAP, and never repeats a card
  * mode=due introduces at most NEW_PER_SESSION never-seen cards
  * a backlog cannot crowd out new material: NEW_RESERVED slots are held
  * reviews come before new material
  * only due cards are served in mode=due
  * every practice mode serves what its name says
"""

import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import drill  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TRIALS = 40
NOW = datetime.fromisoformat("2026-01-05T09:00:00")

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)
        print(f"FAIL: {msg}")


def make_deck(n):
    topics = ["rl", "math", "ml"]
    return [{"id": f"{topics[i % 3]}:item{i:02d}", "front": f"q{i}",
             "back": f"a{i}", "cat": topics[i % 3],
             "batch": "b1" if i < n // 2 else "b2"} for i in range(n)]


def seen_entry(minutes_ago=60, reps=3, due_in=None):
    due = (NOW + timedelta(minutes=due_in)) if due_in is not None \
        else NOW - timedelta(minutes=minutes_ago)
    return {"due": due.isoformat(timespec="seconds"),
            "step": 3, "interval_min": 1440, "ease": 2.5,
            "reps": reps, "lapses": 0}


def ids(queue):
    return [c["id"] for c, _ in queue]


# --- big seen backlog: capped, no repeats -----------------------------------
deck = make_deck(30)
state = {c["id"]: seen_entry() for c in deck}
for _ in range(TRIALS):
    q = drill.select_queue(deck, state, "due", NOW)
    check(len(q) == drill.SESSION_CAP, f"cap: got {len(q)}")
    check(len(set(ids(q))) == len(q), "a card was served twice")

# --- the oldest backlog is what makes the cut -------------------------------
state_aged = {c["id"]: seen_entry(minutes_ago=60 + i) for i, c in enumerate(deck)}
oldest = {c["id"] for c in deck[-drill.SESSION_CAP:]}
for _ in range(TRIALS):
    q = drill.select_queue(deck, state_aged, "due", NOW)
    check(set(ids(q)) == oldest, "a newer review displaced an older one")

# --- all-new deck: the drip -------------------------------------------------
for _ in range(TRIALS):
    q = drill.select_queue(deck, {}, "due", NOW)
    check(len(q) == drill.NEW_PER_SESSION,
          f"new drip: got {len(q)}, want {drill.NEW_PER_SESSION}")
    check(all(e["reps"] == 0 for _, e in q), "non-new card in an all-new deck")
    check(ids(q) == [c["id"] for c in deck[:drill.NEW_PER_SESSION]],
          "new cards left deck order")

# --- mixed: backlog first, but new cards keep their reserved slots ----------
deck_mixed = make_deck(40)
state_mixed = {c["id"]: seen_entry(minutes_ago=60 + i)
               for i, c in enumerate(deck_mixed[:25])}       # 25 seen, 15 new
for _ in range(TRIALS):
    q = drill.select_queue(deck_mixed, state_mixed, "due", NOW)
    n_new = sum(1 for _, e in q if e["reps"] == 0)
    check(len(q) == drill.SESSION_CAP, f"mixed cap: got {len(q)}")
    check(n_new == drill.NEW_RESERVED,
          f"mixed: {n_new} new, want the {drill.NEW_RESERVED} reserved slots")
    flags = [e["reps"] > 0 for _, e in q]
    check(flags == sorted(flags, reverse=True), "a new card came before a review")

# --- due mode serves only what is due ---------------------------------------
state_future = {c["id"]: seen_entry(due_in=600) for c in deck}
state_future[deck[0]["id"]] = seen_entry()
q = drill.select_queue(deck, state_future, "due", NOW)
check(ids(q) == [deck[0]["id"]], f"due mode served {ids(q)}")

# --- every practice mode serves what its name says --------------------------
lapsed = {c["id"]: dict(seen_entry(due_in=600), lapses=2, ease=2.1)
          for c in deck[:6]}
for _ in range(TRIALS // 4):
    for topic in ("rl", "math", "ml"):
        q = drill.select_queue(deck, {}, f"topic:{topic}", NOW)
        check(q and all(c["cat"] == topic for c, _ in q), f"topic:{topic}")
    q = drill.select_queue(deck, {}, "batch", NOW)
    check(q and all(c["batch"] == "b2" for c, _ in q), "batch is not the latest")
    q = drill.select_queue(deck, lapsed, "hardest", NOW)
    check(len(q) == 6 and set(ids(q)) == set(lapsed), "hardest")
    q = drill.select_queue(deck, lapsed, "new", NOW)
    check(q and all(c["id"] not in lapsed for c, _ in q), "new served a seen card")
    q = drill.select_queue(deck, {}, "all", NOW)
    check(len(q) <= drill.SESSION_CAP and len(set(ids(q))) == len(q), "all")
check(drill.select_queue(deck, {}, "topic:nope", NOW) == [], "unknown topic")

# --- the example deck loads and every mode copes with it --------------------
drill.CARDS = os.path.join(HERE, "cards.example.json")
example = drill.load_cards()
check(len(example) > 0, "example deck is empty")
for mode in ["due", "all", "hardest", "new", "batch", "topic:" + example[0]["cat"]]:
    for st in ({}, {c["id"]: dict(seen_entry(), lapses=2) for c in example}):
        q = drill.select_queue(example, st, mode, NOW)
        check(len(q) <= drill.SESSION_CAP, f"cap broken in mode {mode}")

# --- removed cards never reach a session, and can be restored ---------------
import tempfile  # noqa: E402

with tempfile.TemporaryDirectory() as tmp:
    drill.REMOVED = os.path.join(tmp, "removed.json")
    drill.LOCKFILE = os.path.join(tmp, ".lock")
    full = drill.load_cards()
    victim = full[0]["id"]
    check(drill.load_removed() == set(), "removed set not empty at start")
    drill.change_removed(add=[victim])
    live = drill.load_cards()
    check(victim not in [c["id"] for c in live], "removed card still loaded")
    check(len(drill.load_cards(include_removed=True)) == len(full),
          "include_removed lost cards")
    for mode in ["due", "all", "new", "batch"]:
        q = drill.select_queue(live, {}, mode, NOW)
        check(victim not in ids(q), f"removed card served in mode {mode}")
    drill.change_removed(drop=[victim])
    check(victim in [c["id"] for c in drill.load_cards()], "restore failed")
    check(drill.load_removed_map()[victim]["removed"] is False,
          "restore left no tombstone for sync to carry")

print(f"test-queue.py: {'FAILED, ' + str(len(failures)) + ' failure(s)' if failures else 'all invariants hold'}")
sys.exit(1 if failures else 0)
