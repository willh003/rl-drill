#!/usr/bin/env python3
"""The Levantine Arabic home screen.

    /usr/bin/python3 home.py

Shows where you are, what is due and how the last fortnight went, and lets you
start a session -- either what the scheduler wants, or a slice you pick.

It runs as a loop: show home, wait for a command, run the session in the drill
window, then show home again with the new numbers. The home screen quits while
a session is on, so the two windows are never on screen competing for the
keyboard.

The drill itself does not depend on any of this. launchd still runs
arabic-drill.py -> drill.py, and that path never opens the home screen.
"""

import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import drill    # noqa: E402
import stats    # noqa: E402

UI = os.path.join(HERE, "home_ui.js")
APP = os.path.join(HERE, "ArabicHome.app")
PAYLOAD_FILE = os.path.join(HERE, ".home-payload.json")
RESULTS_FILE = os.path.join(HERE, ".home-results.jsonl")
PIDFILE = os.path.join(HERE, ".home.pid")

# How long to leave the home screen sitting there before giving up on it.
HOME_TIMEOUT = 60 * 60

MODE_NAMES = {
    "due": "what's due",
    "all": "the whole deck",
    "vocab": "vocab",
    "sentences": "sentences",
    "ar2en": "Arabic to English",
    "en2ar": "English to Arabic",
    "hardest": "trouble cards",
    "new": "new cards",
    "lesson": "the latest batch",
    "timed30": "a 30-minute crank",
}


def already_running():
    """True if another home.py loop owns the window.

    A pidfile rather than pgrep: the launcher's own command line contains the
    path to this script, so a pgrep pattern matches the launcher itself and
    nothing ever starts.
    """
    try:
        pid = int(open(PIDFILE).read().strip())
    except (OSError, ValueError):
        return False
    if pid == os.getpid():
        return False
    try:
        os.kill(pid, 0)         # signal 0 just tests for existence
    except OSError:
        return False
    # Guard against a recycled pid belonging to something unrelated.
    ps = subprocess.run(["/bin/ps", "-o", "command=", "-p", str(pid)],
                        capture_output=True, text=True).stdout
    return "home.py" in ps


def show_home(landing="home"):
    """Open the home window and wait for it to say what to do next.

    Returns a command dict, or None if the window was closed.
    """
    # Let any previous home window finish closing, or its parting "quit"
    # line lands in the file we are about to read and closes us immediately.
    for _ in range(40):
        if not drill.app_running(APP):
            break
        time.sleep(0.1)

    session = f"{time.time():.3f}"
    snap = stats.snapshot()
    snap["session"] = session
    snap["landing"] = landing
    with open(PAYLOAD_FILE, "w") as fh:
        json.dump(snap, fh)
    with open(RESULTS_FILE, "w"):
        pass

    drill.build_app_from(UI, APP, "Arabic", "local.arabic-home")
    subprocess.run(["/usr/bin/open", "-n", "-a", APP], check=True,
                   capture_output=True)

    seen = 0
    started = time.time()
    ever_running = False
    relaunched = False
    while time.time() - started < HOME_TIMEOUT:
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
            if msg.get("t") == "cmd" and msg.get("s") == session:
                return msg

        running = drill.app_running(APP)
        ever_running = ever_running or running
        if not running and time.time() - started > 8:
            if not ever_running and not relaunched:
                # First launch after a rebuild can take a while: the bundle has
                # just been re-registered with LaunchServices and `open` can
                # quietly lose the race. Try once more before giving up.
                relaunched = True
                drill.log("home window did not come up -- retrying once")
                subprocess.run(["/usr/bin/open", "-n", "-a", APP],
                               check=False, capture_output=True)
                started = time.time()
                continue
            return None
    return None


def main():
    if already_running():
        drill.log("home screen already open")
        return 0
    try:
        with open(PIDFILE, "w") as fh:
            fh.write(str(os.getpid()))
    except OSError:
        pass

    cards = drill.load_cards()

    # The Dock icon opens on the analytics page: "here is where you are",
    # with a way into a session from there. Plain `home.py` opens on home.
    landing = "home"
    if "--view" in sys.argv:
        i = sys.argv.index("--view")
        if len(sys.argv) > i + 1:
            landing = sys.argv[i + 1]

    while True:
        cmd = show_home(landing)
        if not cmd or cmd.get("cmd") != "start":
            return 0

        mode = cmd.get("mode", "due")
        # Reload state each time: a scheduled firing may have graded cards
        # while the home screen was sitting open.
        state = drill.load_state()

        if mode == "timed30":
            drill.log("session from home screen: 30-minute crank")
            try:
                r, w, rounds = drill.timed_run(cards, state, 30)
                drill.log(f"crank done: {rounds} round(s), {r} right, {w} wrong")
            except Exception as exc:
                drill.log(f"crank failed ({exc})")
            continue
        queue = drill.select_queue(cards, state, mode)
        if not queue:
            drill.log(f"nothing to study for '{mode}'")
            continue

        drill.log(f"session from home screen: {MODE_NAMES.get(mode, mode)}, "
                  f"{len(queue)} card(s)")
        try:
            result = drill.run_window(cards, state, mode=mode)
        except Exception as exc:
            drill.log(f"could not open the window ({exc})")
            return 0
        if result:
            right, wrong, _ = result
            drill.log(f"session done: {right} right, {wrong} wrong")
        # ...and round we go, back to a freshly-computed home screen.


def _cleanup():
    try:
        if already_running():
            return          # someone else owns it now
        os.unlink(PIDFILE)
    except OSError:
        pass


if __name__ == "__main__":
    try:
        code = main()
    finally:
        _cleanup()
    raise SystemExit(code)
