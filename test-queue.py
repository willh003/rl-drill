#!/usr/bin/env python3
"""Queue-building invariants for drill.py (the reference side).

test-queue.js asserts the same invariants over webapp/srs.js. The queue
builders are randomised on purpose (ORDER_SLACK), so every scenario runs
many times: an invariant that only usually holds is a bug.

  * a session never exceeds SESSION_CAP
  * mode=due introduces at most NEW_PER_SESSION never-seen cards
  * reviews come before new material
  * a healthy session shows one direction per item; the reverse waits
  * a thin session pads with siblings but spreads them as far apart as
    the item count allows
  * cards tagged deliver="table" are never handed out as flashcards, in
    any mode
"""

import json
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


def make_deck(n_items):
    cards = []
    for i in range(n_items):
        base = f"item{i:02d}"
        for d in ("ar2en", "en2ar"):
            cards.append({
                "id": f"vocab:{base}:{d}", "dir": d,
                "prompt": f"p{i}{d}", "answer": f"a{i}{d}", "hint": "",
                "options": [f"a{i}{d}", "x", "y", "z"], "cat": "vocab",
                "lesson": "L1",
            })
    return cards


def seen_entry(minutes_ago=60, reps=3):
    return {"due": (NOW - timedelta(minutes=minutes_ago))
            .isoformat(timespec="seconds"),
            "step": 3, "interval_min": 1440, "ease": 2.5,
            "reps": reps, "lapses": 0}


def bases(queue):
    return [drill.base_of(c["id"]) for c, _ in queue]


def min_same_base_gap(queue):
    last = {}
    gap = len(queue)
    for i, b in enumerate(bases(queue)):
        if b in last:
            gap = min(gap, i - last[b])
        last[b] = i
    return gap


# --- healthy session: big seen backlog --------------------------------------
deck = make_deck(26)
state = {c["id"]: seen_entry() for c in deck}
for _ in range(TRIALS):
    q = drill.select_queue(deck, state, "due", NOW)
    check(len(q) == drill.SESSION_CAP, f"cap: got {len(q)}")
    check(len(set(bases(q))) == len(q), "healthy session repeats an item")

# --- all-new deck: the drip -------------------------------------------------
for _ in range(TRIALS):
    q = drill.select_queue(deck, {}, "due", NOW)
    check(len(q) == drill.NEW_PER_SESSION,
          f"new drip: got {len(q)}, want {drill.NEW_PER_SESSION}")
    check(all(e["reps"] == 0 for _, e in q), "non-new card in an all-new deck")
    check(len(set(bases(q))) == len(q), "new session repeats an item")

# --- mixed: backlog first, but new cards keep their reserved slots ----------
deck_mixed = make_deck(28)
state_mixed = {}
for i, c in enumerate(deck_mixed):
    if c["id"].split(":")[1] < "item18":         # 18 items seen, 10 new
        state_mixed[c["id"]] = seen_entry(minutes_ago=60 + i)
for _ in range(TRIALS):
    q = drill.select_queue(deck_mixed, state_mixed, "due", NOW)
    n_new = sum(1 for _, e in q if e["reps"] == 0)
    check(len(q) == drill.SESSION_CAP, f"mixed cap: got {len(q)}")
    check(n_new == drill.NEW_RESERVED,
          f"mixed: {n_new} new, want the {drill.NEW_RESERVED} reserved slots")
    seen_flags = [e["reps"] > 0 for _, e in q]
    check(seen_flags == sorted(seen_flags, reverse=True),
          "a new card came before a review")

# --- thin session: siblings return, spread as far as possible ---------------
deck_thin = make_deck(4)
state_thin = {c["id"]: seen_entry() for c in deck_thin}
for _ in range(TRIALS):
    q = drill.select_queue(deck_thin, state_thin, "due", NOW)
    check(len(q) == 8, f"thin session: got {len(q)}, want all 8")
    check(min_same_base_gap(q) >= 3,
          f"thin session: siblings {min_same_base_gap(q)} apart")

# --- deliver="table" never drills, in any mode ------------------------------
drill.CARDS = os.path.join(HERE, "cards.example.json")
example = drill.load_cards(for_drill=True)
example_all = drill.load_cards(for_drill=False)
check(len(example_all) > len(example), "example deck has no table cards")
check(all(c.get("deliver") != "table" for c in example),
      "load_cards(for_drill=True) let a table card through")
table_ids = {c["id"] for c in example_all if c.get("deliver") == "table"}
modes = ["due", "all", "vocab", "sentences", "ar2en", "en2ar",
         "hardest", "new", "lesson"]
lapsed = {c["id"]: dict(seen_entry(), lapses=2, ease=2.1) for c in example_all}
for mode in modes:
    for st in ({}, lapsed):
        for _ in range(10):
            q = drill.select_queue(example, st, mode, NOW)
            check(not any(c["id"] in table_ids for c, _ in q),
                  f"table card drilled in mode {mode}")
            check(len(q) <= drill.SESSION_CAP, f"cap broken in mode {mode}")

print(f"test-queue.py: {'FAILED, ' + str(len(failures)) + ' failure(s)' if failures else 'all invariants hold'}")
sys.exit(1 if failures else 0)
