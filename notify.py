#!/usr/bin/env python3
"""Native iPhone notifications via Web Push -- no app, no pop-ups.

The phone's home-screen web app registers a push subscription; it syncs to
this Mac through the private repo. At the hours below, if enough cards are
due and nobody has studied recently, push-send.js (RFC 8291/8292, validated
against the RFC test vectors) sends an encrypted push through Apple's own
service. It lands as a normal lock-screen notification; tapping it opens
the app.

Silent until the phone has enabled notifications once (Enable notifications
button in the app).
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import config   # noqa: E402
import drill    # noqa: E402

NOTIFY_HOURS = {9, 13, 17, 21}
MIN_DUE = 15
QUIET_MIN = 90
SUB_FILE = os.path.join(HERE, ".push-subscription.json")
APP_URL = config.APP_URL
NODE = config.NODE


def _studied_recently(minutes=QUIET_MIN):
    reviews = drill.load_reviews()
    if not reviews:
        return False
    last = datetime.fromisoformat(reviews[-1]["ts"])
    return datetime.now() - last < timedelta(minutes=minutes)


def maybe_notify(force=False):
    now = datetime.now()
    if not force and now.hour not in NOTIFY_HOURS:
        return "off-hour"
    if not os.path.exists(SUB_FILE):
        return "no subscription yet"

    cards = drill.load_cards()
    state = drill.load_state()
    due = len(drill.due_cards(cards, state, now))
    if not force:
        if due < MIN_DUE:
            return f"only {due} due"
        if _studied_recently():
            return "studied recently"

    title = "RL Drill"
    body = f"{due} cards due — a session takes ~3 minutes"
    res = subprocess.run(
        [NODE, os.path.join(HERE, "push-send.js"), SUB_FILE,
         title, body, APP_URL],
        capture_output=True, text=True, timeout=30)
    if res.returncode != 0:
        out = (res.stdout + res.stderr).strip()
        drill.log(f"[notify] push failed: {out[:120]}")
        if out.startswith(("404", "410")):      # subscription expired
            os.rename(SUB_FILE, SUB_FILE + ".expired")
            drill.log("[notify] subscription expired -- re-enable on the phone")
        return "failed"
    drill.log(f"[notify] pushed: {body}")
    return "sent"


if __name__ == "__main__":
    print(maybe_notify(force="--force" in sys.argv))
