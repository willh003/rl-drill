#!/usr/bin/env python3
"""Sanity-check a deck before studying from it.

    python3 validate-deck.py [cards.json [tables.json]]

Defaults to the example files, which is what CI checks. Run it on your own
cards.json after editing -- a malformed card fails quietly at study time,
which is the worst place to find out.
"""

import json
import sys

cards_path = sys.argv[1] if len(sys.argv) > 1 else "cards.example.json"
tables_path = sys.argv[2] if len(sys.argv) > 2 else "tables.example.json"

problems = []


def problem(msg):
    problems.append(msg)
    print(f"PROBLEM: {msg}")


cards = json.load(open(cards_path))
seen_ids = set()
for c in cards:
    cid = c.get("id", "<missing id>")
    if cid in seen_ids:
        problem(f"{cid}: duplicate id")
    seen_ids.add(cid)
    for field in ("id", "dir", "prompt", "answer", "options", "cat"):
        if field not in c:
            problem(f"{cid}: missing {field}")
    if c.get("dir") not in ("ar2en", "en2ar"):
        problem(f"{cid}: dir must be ar2en or en2ar")
    if cid.count(":") < 2:
        problem(f"{cid}: id must be cat:item:direction -- the part before "
                "the last colon groups the two directions of one item")
    elif not cid.endswith(":" + c.get("dir", "")):
        problem(f"{cid}: id direction suffix disagrees with dir")
    opts = c.get("options", [])
    if len(opts) != 4:
        problem(f"{cid}: {len(opts)} options, want exactly 4")
    if c.get("answer") not in opts:
        problem(f"{cid}: answer is not among the options")
    if len(set(opts)) != len(opts):
        problem(f"{cid}: duplicate option")
    if c.get("deliver") not in (None, "table"):
        problem(f"{cid}: deliver must be absent or \"table\"")

drillable = [c for c in cards if c.get("deliver") != "table"]
if not drillable:
    problem("every card is table-delivered; nothing would ever drill")

try:
    tables = json.load(open(tables_path))
except OSError:
    tables = None
    print(f"note: no {tables_path}; skipping table checks "
          "(the phone's grid and matching games need one)")

if tables:
    person_keys = [p["key"] for p in tables.get("persons", [])]
    for par in tables.get("paradigms", []):
        for pk in person_keys:
            cell = par.get("cells", {}).get(pk)
            if not cell:
                problem(f"paradigm {par.get('key')}: no cell for {pk}")
                continue
            if cell.get("cardId") not in seen_ids:
                problem(f"paradigm {par.get('key')}/{pk}: cardId "
                        f"{cell.get('cardId')} is not in the deck")
    par_keys = {p["key"] for p in tables.get("paradigms", [])}
    for want in ("pron", "ending", "book"):
        if want not in par_keys:
            problem(f"paradigm key \"{want}\" missing -- the app's matching "
                    "games refer to pron, ending and book by name")
    for t in tables.get("tables", []):
        for col in t.get("columns", []):
            if col not in par_keys:
                problem(f"table {t.get('id')}: unknown column {col}")

n = len(cards)
print(f"{cards_path}: {n} cards ({len(drillable)} drillable), "
      f"{'FAILED, ' + str(len(problems)) + ' problem(s)' if problems else 'ok'}")
sys.exit(1 if problems else 0)
