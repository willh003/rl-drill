#!/usr/bin/env python3
"""Scheduled entry point for the RL drill.

The launchd agent installed by install.sh points at this path, so it stays
as the thing launchd runs; the actual work lives in drill.py next door.

There is no Anki in this any more, and no AnkiConnect. The old version of this
file woke Anki up, asked it what was due over HTTP, dragged it to the front and
dropped a trigger file for an add-on to notice -- all to work around
guiDeckReview reporting success before Anki bounced back to the deck overview.
The drill now owns its own scheduling and its own window, so none of that
apparatus is needed.

Exits 0 and silently whenever nothing is due, which is most firings.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import drill  # noqa: E402  (path has to be set first)

def _notify():
    # Phone notifications ride along on the same hourly firing. Never let
    # them break the drill itself.
    try:
        import notify
        notify.maybe_notify()
    except Exception as exc:
        drill.log(f"[notify] skipped ({exc})")


def _sync(step):
    try:
        import sync
        sync.pull() if step == "pull" else sync.push()
    except Exception as exc:
        drill.log(f"[sync] skipped ({exc})")


if __name__ == "__main__":
    try:
        _sync("pull")
        code = drill.main()
        _sync("push")
        _notify()
        raise SystemExit(code)
    except SystemExit:
        raise
    except Exception as exc:
        # A scheduled job that dies loudly every two hours is worse than one
        # that misses a session, so log it and leave quietly.
        drill.log(f"unexpected failure: {exc}")
        raise SystemExit(0)
