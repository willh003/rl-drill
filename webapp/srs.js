// SM-2 scheduling + queue building for the phone, ported line-for-line from
// drill.py. The Python file remains the reference implementation; the golden
// test asserts this port grades identically (`node test-srs.js`, vectors
// from gen-golden.py; CI runs both). If you change one, change both,
// regenerate the vectors, and re-run the test.
'use strict';

const SRS = {
  LEARNING_STEPS_MIN: [10, 30, 120],
  GRADUATED_MIN: 24 * 60,
  EASE_START: 2.5,
  EASE_FLOOR: 1.3,
  EASE_PENALTY: 0.2,
  MAX_INTERVAL_MIN: 180 * 24 * 60,
  SESSION_CAP: 20,
  NEW_PER_SESSION: 12,
  NEW_RESERVED: 6,

  // Local-time ISO without milliseconds, matching Python's isoformat --
  // the two sides must produce comparable strings.
  iso(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  },

  entryFor(state, id) {
    return state[id] || { due: '1970-01-01T00:00:00', step: 0, interval_min: 0,
                          ease: SRS.EASE_START, reps: 0, lapses: 0 };
  },

  grade(entry, correct, now) {
    const e = Object.assign({}, entry);
    let wait;
    if (correct) {
      e.reps += 1;
      if (e.step < SRS.LEARNING_STEPS_MIN.length) {
        wait = SRS.LEARNING_STEPS_MIN[e.step];
        e.step += 1;
      } else if (e.interval_min < SRS.GRADUATED_MIN) {
        wait = SRS.GRADUATED_MIN;
      } else {
        wait = Math.floor(e.interval_min * e.ease);
      }
      e.interval_min = Math.min(wait, SRS.MAX_INTERVAL_MIN);
    } else {
      e.lapses += 1;
      // no rounding: Python keeps the raw float and IEEE 754 doubles are
      // identical across the two languages, so the ports stay bit-equal
      e.ease = Math.max(SRS.EASE_FLOOR, e.ease - SRS.EASE_PENALTY);
      wait = SRS.LEARNING_STEPS_MIN[0];
      e.step = 1;
      e.interval_min = wait;
    }
    e.due = SRS.iso(new Date(now.getTime() + wait * 60000));
    return e;
  },

  // Answers on two devices can arrive in any order; every answer increments
  // reps or lapses, so the entry with the larger total has seen more history
  // and wins. Ties (same count) break toward the later due date.
  mergeEntry(a, b) {
    if (!a) return b;
    if (!b) return a;
    const ca = a.reps + a.lapses, cb = b.reps + b.lapses;
    if (ca !== cb) return ca > cb ? a : b;
    return a.due >= b.due ? a : b;
  },

  mergeState(local, remote) {
    const out = {};
    const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
    for (const k of keys) out[k] = SRS.mergeEntry(local[k], remote[k]);
    return out;
  },

  dueCards(cards, state, now) {
    const nowIso = SRS.iso(now);
    const out = [];
    for (const c of cards) {
      const e = SRS.entryFor(state, c.id);
      if (e.due <= nowIso) out.push([c, e]);
    }
    out.sort((x, y) => {
      const nx = x[1].reps === 0 ? 1 : 0, ny = y[1].reps === 0 ? 1 : 0;
      if (nx !== ny) return nx - ny;
      return x[1].due < y[1].due ? -1 : x[1].due > y[1].due ? 1 : 0;
    });
    return out;
  },

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  // Reviews first, then new material -- see order_queue in drill.py.
  orderQueue(pairs, cap, newCap) {
    cap = cap || SRS.SESSION_CAP;
    if (!pairs.length) return [];
    const seen = pairs.filter(p => p[1].reps > 0);
    const fresh = pairs.filter(p => p[1].reps === 0);

    const limitNew = (newCap === undefined || newCap === null)
        ? SRS.NEW_PER_SESSION : newCap;
    let pickedSeen = seen.slice(0, cap);
    let room = Math.min(cap - pickedSeen.length, limitNew);
    if (fresh.length && room < Math.min(SRS.NEW_RESERVED, limitNew)) {
      pickedSeen = seen.slice(0, Math.max(0, cap - SRS.NEW_RESERVED));
      room = Math.min(cap - pickedSeen.length, limitNew);
    }
    const pickedNew = room > 0 ? fresh.slice(0, room) : [];
    return SRS.shuffle(pickedSeen).concat(pickedNew);
  },

  // Modes: due, all, hardest, new, batch, and "topic:NAME".
  selectQueue(cards, state, mode, now) {
    now = now || new Date();
    if (mode === 'due') return SRS.orderQueue(SRS.dueCards(cards, state, now));

    let pool;
    if (mode.startsWith('topic:')) {
      const topic = mode.slice(6);
      pool = cards.filter(c => c.cat === topic);
    } else if (mode === 'hardest') {
      pool = cards.slice().sort((a, b) => {
        const ea = SRS.entryFor(state, a.id), eb = SRS.entryFor(state, b.id);
        return (eb.lapses - ea.lapses) || (ea.ease - eb.ease);
      }).filter(c => SRS.entryFor(state, c.id).lapses > 0);
    } else if (mode === 'new') {
      pool = cards.filter(c => SRS.entryFor(state, c.id).reps === 0);
    } else if (mode === 'batch') {
      const tags = [...new Set(cards.map(c => c.batch).filter(Boolean))].sort();
      const latest = tags[tags.length - 1];
      pool = latest ? cards.filter(c => c.batch === latest) : [];
    } else {
      pool = cards.slice();
    }

    if (mode !== 'hardest') {
      const dueIds = new Set(SRS.dueCards(cards, state, now).map(p => p[0].id));
      pool = pool.filter(c => dueIds.has(c.id))
                 .concat(SRS.shuffle(pool.filter(c => !dueIds.has(c.id))));
    }
    return SRS.orderQueue(pool.map(c => [c, SRS.entryFor(state, c.id)]),
                          undefined, mode === 'new' ? SRS.SESSION_CAP : undefined);
  },
};

if (typeof module !== 'undefined') module.exports = SRS;
