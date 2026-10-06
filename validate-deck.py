#!/usr/bin/env python3
"""Sanity-check a deck before studying from it.

    python3 validate-deck.py [cards.json]

Defaults to the example deck, which is what CI checks. Run it on your own
cards.json after editing -- a malformed card fails quietly at study time,
which is the worst place to find out. Beyond the shape of each card it
catches the mistakes that are easy to make when writing LaTeX inside JSON:
an unbalanced $ (everything after it renders as math) and a lone backslash
that JSON swallowed ("\\frac" is a form feed followed by "rac").
"""

import json
import re
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "cards.example.json"

problems = []


def problem(msg):
    problems.append(msg)
    print(f"PROBLEM: {msg}")


def dollars_balanced(text):
    # \$ is a literal dollar sign, and $$ is one delimiter, not two.
    t = text.replace("\\$", "").replace("$$", "\x00")
    return t.count("$") % 2 == 0 and t.count("\x00") % 2 == 0


try:
    cards = json.load(open(path))
except (OSError, ValueError) as exc:
    print(f"PROBLEM: cannot read {path}: {exc}")
    sys.exit(1)

if not isinstance(cards, list):
    print("PROBLEM: cards.json must be a JSON array")
    sys.exit(1)

seen_ids = set()
for c in cards:
    cid = c.get("id", "<missing id>")
    if cid in seen_ids:
        problem(f"{cid}: duplicate id")
    seen_ids.add(cid)
    for field in ("id", "front", "back", "cat"):
        if not isinstance(c.get(field), str) or not c[field].strip():
            problem(f"{cid}: missing or empty {field}")
    if "batch" in c and not isinstance(c["batch"], str):
        problem(f"{cid}: batch must be a string")
    for field in ("front", "back"):
        text = c.get(field)
        if not isinstance(text, str):
            continue
        if not dollars_balanced(text):
            problem(f"{cid}: unbalanced $ in {field}")
        if re.search(r"[\x07\x08\x0c\x0b\r\t]", text):
            problem(f"{cid}: control character in {field} -- a single "
                    "backslash in JSON (\\b, \\f, \\t, \\r, \\a) was "
                    "swallowed; write \\\\frac, \\\\beta, \\\\theta, \\\\to")

n = len(cards)
if not n:
    problem("the deck is empty")
topics = sorted({c.get("cat", "") for c in cards})
print(f"{path}: {n} cards in {len(topics)} topic(s) ({', '.join(topics)}), "
      f"{'FAILED, ' + str(len(problems)) + ' problem(s)' if problems else 'ok'}")
sys.exit(1 if problems else 0)
