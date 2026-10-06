#!/usr/bin/env python3
"""Two-way sync between this directory and the private sync repo.

The phone app writes state.json (and its own reviews-phone.jsonl) through
GitHub's contents API; this module is the Mac's half of the conversation,
driven by the already-authenticated `gh` CLI. The repo name comes from
config.json (`syncRepo`); with no config, sync quietly does nothing and
the drill runs local-only.

  pull()  fetch remote state, merge per-card, adopt phone review history,
          download the push subscription if the phone has registered one
  push()  upload merged state (compare-and-swap; on conflict re-merge and
          retry), plus cards.json whenever the deck changed and removed.json
          (cards you dropped; last write per card wins)

Merge rule (mirrors srs.js): every answer increments reps or lapses, so for
any card the entry with the larger reps+lapses total has seen more history
and wins; ties break toward the later due date. Order of arrival cannot lose
answers.

All failures are non-fatal by design -- offline means the drill simply runs
local-only until the next opportunity.
"""

import base64
import hashlib
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import config   # noqa: E402
import drill    # noqa: E402

REPO = config.SYNC_REPO
CURSOR = os.path.join(HERE, ".sync-cursor")          # phone review lines adopted
SUB_FILE = os.path.join(HERE, ".push-subscription.json")
GH = config.GH


def _gh(args, input_json=None):
    cmd = [GH, "api"] + args
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=30,
                         input=input_json)
    return res


def _get(path):
    res = _gh([f"repos/{REPO}/contents/{path}"])
    if res.returncode != 0:
        return None, None
    j = json.loads(res.stdout)
    return base64.b64decode(j["content"]).decode(), j["sha"]


def _put(path, text, sha, message):
    args = ["-X", "PUT", f"repos/{REPO}/contents/{path}",
            "-f", f"message={message}",
            "-f", "content=" + base64.b64encode(text.encode()).decode()]
    if sha:
        args += ["-f", f"sha={sha}"]
    return _gh(args).returncode == 0


def merge_entry(a, b):
    if not a:
        return b
    if not b:
        return a
    ca, cb = a["reps"] + a["lapses"], b["reps"] + b["lapses"]
    if ca != cb:
        return a if ca > cb else b
    return a if a["due"] >= b["due"] else b


def merge_state(local, remote):
    out = {}
    for k in set(local) | set(remote):
        out[k] = merge_entry(local.get(k), remote.get(k))
    return out


def merge_removed(a, b):
    """Per card, the later write wins; a tie goes to "removed" (the safe side:
    a card you meant to drop never reappears because of a clock tie)."""
    out = dict(a)
    for cid, v in b.items():
        mine = out.get(cid)
        if (not mine or v.get("ts", "") > mine.get("ts", "")
                or (v.get("ts", "") == mine.get("ts", "") and v.get("removed"))):
            out[cid] = v
    return out


def _remote_removed():
    text, sha = _get("removed.json")
    try:
        m = json.loads(text) if text else {}
    except ValueError:
        m = {}
    return (m if isinstance(m, dict) else {}), sha


def pull():
    """Adopt everything the phone has done. Returns True if state changed."""
    if not REPO:
        return False
    changed = False
    try:
        text, _sha = _get("state.json")
        if text:
            local = drill.load_state()
            merged = merge_state(local, json.loads(text))
            if merged != local:
                drill.save_state(merged)
                changed = True

        # phone review history -> local reviews.jsonl (cursor = lines taken)
        text, _sha = _get("reviews-phone.jsonl")
        if text is not None:
            lines = [l for l in text.split("\n") if l.strip()]
            try:
                cur = int(open(CURSOR).read().strip())
            except (OSError, ValueError):
                cur = 0
            fresh = lines[cur:]
            if fresh:
                have = set(open(drill.REVIEWS).read().split("\n"))
                with open(drill.REVIEWS, "a") as fh:
                    for l in fresh:
                        if l not in have:
                            fh.write(l + "\n")
                drill.log(f"[sync] adopted {len(fresh)} phone review(s)")
            with open(CURSOR, "w") as fh:
                fh.write(str(len(lines)))

        remote_rm, _sha = _remote_removed()
        local_rm = drill.load_removed_map()
        merged_rm = merge_removed(local_rm, remote_rm)
        if merged_rm != local_rm:
            drill.save_removed_map(merged_rm)
            changed = True

        text, _sha = _get("push-subscription.json")
        if text:
            open(SUB_FILE, "w").write(text)
    except Exception as exc:                     # noqa: BLE001
        drill.log(f"[sync] pull skipped ({exc})")
    return changed


def push():
    """Upload merged state; CAS-retry on conflict. Also cards when changed."""
    if not REPO:
        return
    try:
        for _ in range(4):
            text, sha = _get("state.json")
            merged = merge_state(drill.load_state(),
                                 json.loads(text) if text else {})
            drill.save_state(merged)
            if _put("state.json", json.dumps(merged, indent=1), sha,
                    "mac: graded cards"):
                break

        for _ in range(4):
            remote_rm, sha = _remote_removed()
            local_rm = drill.load_removed_map()
            merged_rm = merge_removed(local_rm, remote_rm)
            if merged_rm != local_rm:
                drill.save_removed_map(merged_rm)
            if merged_rm == remote_rm or _put(
                    "removed.json", json.dumps(merged_rm, indent=1, sort_keys=True),
                    sha, "mac: removed cards"):
                break

        local_cards = open(drill.CARDS).read()
        text, sha = _get("cards.json")
        if text is None or (hashlib.sha256(text.encode()).hexdigest() !=
                            hashlib.sha256(local_cards.encode()).hexdigest()):
            _put("cards.json", local_cards, sha, "mac: deck update")
            drill.log("[sync] pushed deck update")

        # keep the merged master history available to the phone's stats
        text, sha = _get("reviews.jsonl")
        local_rev = open(drill.REVIEWS).read()
        if text != local_rev:
            _put("reviews.jsonl", local_rev, sha, "mac: review history")
    except Exception as exc:                     # noqa: BLE001
        drill.log(f"[sync] push skipped ({exc})")


if __name__ == "__main__":
    if "--push" in sys.argv:
        push()
    else:
        pull()
        if "--pull-only" not in sys.argv:
            push()
    print("ok")
