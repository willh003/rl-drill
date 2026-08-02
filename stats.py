#!/usr/bin/env python3
"""Everything the home screen and the analytics page display.

Kept apart from drill.py on purpose: drill.py is the thing launchd runs eight
times a day and it should stay boring. This is read-only over cards.json,
state.json and reviews.jsonl, so it can never disturb a schedule.

`python3 stats.py` prints the same figures as text, which is handy when you
want the numbers without a window.
"""

import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import drill  # noqa: E402


DAY = 24 * 60


def _bucket(interval_min, reps):
    if reps == 0:
        return "new"
    if interval_min < DAY:
        return "learning"
    if interval_min < 7 * DAY:
        return "week"
    if interval_min < 30 * DAY:
        return "month"
    return "mature"


BUCKET_ORDER = ["new", "learning", "week", "month", "mature"]
BUCKET_LABEL = {
    "new": "Unseen",
    "learning": "Learning",
    "week": "Under a week",
    "month": "Under a month",
    "mature": "A month or more",
}


def streak(reviews, now=None):
    """Consecutive days up to today with at least one review.

    Today not having started yet does not break a streak -- it only ends once
    a whole day has gone by with nothing in it.
    """
    now = now or datetime.now()
    days = {r["ts"][:10] for r in reviews}
    if not days:
        return 0
    today = now.date()
    if today.isoformat() not in days:
        # Yesterday can still anchor a live streak; anything older cannot.
        if (today - timedelta(days=1)).isoformat() not in days:
            return 0
        today = today - timedelta(days=1)
    n = 0
    while (today - timedelta(days=n)).isoformat() in days:
        n += 1
    return n


def compute(cards, state, reviews, now=None):
    now = now or datetime.now()
    today = now.date().isoformat()

    total = len(cards)
    seen = sum(1 for c in cards if drill.entry_for(state, c["id"])["reps"] > 0)
    due_now = len(drill.due_cards(cards, state, now))

    buckets = Counter()
    eases, lapses_by_card = [], []
    for c in cards:
        e = drill.entry_for(state, c["id"])
        buckets[_bucket(e["interval_min"], e["reps"])] += 1
        if e["reps"]:
            eases.append(e["ease"])
        if e["lapses"]:
            lapses_by_card.append((e["lapses"], e["ease"], c))

    todays = [r for r in reviews if r["ts"][:10] == today]
    right_today = sum(1 for r in todays if r["correct"])
    all_right = sum(1 for r in reviews if r["correct"])

    # Fourteen days of activity, oldest first, for the bar chart.
    per_day = defaultdict(lambda: [0, 0])       # day -> [done, right]
    for r in reviews:
        d = per_day[r["ts"][:10]]
        d[0] += 1
        d[1] += int(bool(r["correct"]))
    history = []
    for i in range(13, -1, -1):
        key = (now.date() - timedelta(days=i)).isoformat()
        done, right = per_day.get(key, [0, 0])
        history.append({"day": key, "done": done, "right": right,
                        "label": (now.date() - timedelta(days=i)).strftime("%a")})

    # Where the workload lands next. Disjoint windows, not running totals --
    # four identical cumulative numbers tell you nothing.
    end_today = datetime.combine(now.date(), datetime.min.time()) + timedelta(days=1)
    edges = [
        ("next hour", now + timedelta(hours=1)),
        ("later today", end_today),
        ("tomorrow", end_today + timedelta(days=1)),
        ("rest of week", end_today + timedelta(days=7)),
    ]
    upcoming = []
    lower = now
    for label, upper in edges:
        if upper <= lower:
            upcoming.append({"label": label, "count": 0})
            continue
        n = sum(1 for c in cards
                if lower < datetime.fromisoformat(
                    drill.entry_for(state, c["id"])["due"]) <= upper)
        upcoming.append({"label": label, "count": n})
        lower = upper

    by_cat = {}
    for cat in sorted({c.get("cat", "") for c in cards}):
        pool = [c for c in cards if c.get("cat") == cat]
        done = sum(1 for c in pool
                   if drill.entry_for(state, c["id"])["reps"] > 0)
        by_cat[cat] = {"total": len(pool), "seen": done}

    lapses_by_card.sort(key=lambda t: (-t[0], t[1]))
    hardest = [{
        "prompt": c["prompt"],
        "answer": c["answer"],
        "lapses": n,
        "ease": round(ease, 2),
    } for n, ease, c in lapses_by_card[:6]]

    nxt = drill.next_due_at(cards, state, now)

    dir_counts = Counter(c.get("dir", "") for c in cards)

    tags = sorted({c.get("lesson", "") for c in cards if c.get("lesson")})
    latest = tags[-1] if tags else None
    latest_cards = [c for c in cards if c.get("lesson") == latest] if latest else []
    latest_seen = sum(1 for c in latest_cards
                      if drill.entry_for(state, c["id"])["reps"] > 0)

    return {
        "sessionCap": drill.SESSION_CAP,
        "latestLesson": latest,
        "latestTotal": len(latest_cards),
        "latestSeen": latest_seen,
        "dirCounts": {"ar2en": dir_counts.get("ar2en", 0),
                      "en2ar": dir_counts.get("en2ar", 0)},
        "total": total,
        "seen": seen,
        "dueNow": due_now,
        "graduated": buckets["week"] + buckets["month"] + buckets["mature"],
        "buckets": [{"key": k, "label": BUCKET_LABEL[k], "count": buckets[k]}
                    for k in BUCKET_ORDER],
        "todayDone": len(todays),
        "todayRight": right_today,
        "todayAccuracy": round(100 * right_today / len(todays)) if todays else None,
        "totalReviews": len(reviews),
        "overallAccuracy": round(100 * all_right / len(reviews)) if reviews else None,
        "streak": streak(reviews, now),
        "avgEase": round(sum(eases) / len(eases), 2) if eases else None,
        "history": history,
        "upcoming": upcoming,
        "byCat": by_cat,
        "hardest": hardest,
        "nextDue": nxt.isoformat(timespec="seconds") if nxt else None,
        "nextDueHuman": drill.human_delta(nxt, now) if nxt else None,
        "newLeft": buckets["new"],
        "lapsedCount": len(lapses_by_card),
    }


def snapshot(now=None):
    # analytics describe the whole deck, including table-delivered cards
    cards = drill.load_cards(for_drill=False)
    state = drill.load_state()
    return compute(cards, state, drill.load_reviews(), now)


def main():
    s = snapshot()
    pct = round(100 * s["seen"] / s["total"]) if s["total"] else 0
    print(f"Levantine Arabic — {s['seen']}/{s['total']} cards started ({pct}%)")
    print(f"  due now        {s['dueNow']}")
    print(f"  today          {s['todayDone']} reviews"
          + (f", {s['todayAccuracy']}% right" if s["todayAccuracy"] is not None else ""))
    print(f"  streak         {s['streak']} day(s)")
    print(f"  lifetime       {s['totalReviews']} reviews"
          + (f", {s['overallAccuracy']}% right" if s["overallAccuracy"] is not None else ""))
    if s["nextDueHuman"]:
        print(f"  next card      {s['nextDueHuman']}")
    print("  spread        ", ", ".join(
        f"{b['label']} {b['count']}" for b in s["buckets"]))
    if s["hardest"]:
        print("  giving trouble:")
        for h in s["hardest"]:
            print(f"    {h['lapses']}x  {h['prompt']}  ->  {h['answer']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
