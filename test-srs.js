#!/usr/bin/env node
// The golden test: webapp/srs.js must grade exactly like drill.py.
//
//   node test-srs.js
//
// Replays every vector in golden-srs.json (generated from drill.py by
// gen-golden.py) through SRS.grade and asserts every field of every step is
// identical -- due string, step, interval_min, reps, lapses, and ease as an
// exact IEEE 754 double (srs.js deliberately does not round ease; doubles
// are bit-equal across the two languages, so neither side may round).
// Also checks SRS.mergeEntry against sync.merge_entry on the same cases,
// and that the 25-correct streak walks the documented ladder:
//   10m, 30m, 2h, 1d, 2.5d, 6.25d, 15.6d, 39.1d, 97.7d, then the 180d cap.
//
// TZ is forced to UTC to match gen-golden.py -- see the note there.

'use strict';
process.env.TZ = 'UTC';

const fs = require('fs');
const path = require('path');
const SRS = require('./webapp/srs.js');

const G = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden-srs.json')));

let checked = 0;
let failed = 0;

function fail(msg) {
  failed++;
  console.error('FAIL: ' + msg);
}

function sameEntry(got, want, label) {
  for (const k of ['due', 'step', 'interval_min', 'ease', 'reps', 'lapses']) {
    checked++;
    if (got[k] !== want[k]) {
      fail(label + ': ' + k + ' = ' + JSON.stringify(got[k]) +
           ', reference says ' + JSON.stringify(want[k]));
    }
  }
}

// ---- grade parity -----------------------------------------------------------
const base = new Date(G.baseNow);
if (SRS.iso(base) !== G.baseNow) {
  fail('iso(baseNow) = ' + SRS.iso(base) + ' != ' + G.baseNow +
       ' -- is TZ not UTC?');
}

const freshEntry = () => ({ due: '1970-01-01T00:00:00', step: 0,
                            interval_min: 0, ease: SRS.EASE_START,
                            reps: 0, lapses: 0 });

for (const v of G.vectors) {
  let entry = freshEntry();
  const label = 'seq [' + v.seq.map(c => c ? 'y' : 'n').join('') + ']';
  for (let k = 0; k < v.seq.length; k++) {
    const now = new Date(base.getTime() + k * G.spacingMin * 60000);
    entry = SRS.grade(entry, v.seq[k], now);
    sameEntry(entry, v.steps[k], label + ' step ' + k);
  }
}

// ---- the ladder -------------------------------------------------------------
const streak = G.vectors[G.vectors.length - 1];
if (!streak.seq.every(Boolean) || streak.seq.length !== 25) {
  fail('last vector is not the 25-correct streak');
}
let e = freshEntry();
const intervals = [];
for (let k = 0; k < 25; k++) {
  e = SRS.grade(e, true, new Date(base.getTime() + k * G.spacingMin * 60000));
  intervals.push(e.interval_min);
}
const ladder = intervals.slice(0, G.ladder.length).join(',');
checked++;
if (ladder !== G.ladder.join(',')) {
  fail('ladder is ' + ladder + ', reference says ' + G.ladder.join(','));
}
checked++;
if (!intervals.slice(G.ladder.length).every(i => i === G.maxIntervalMin)) {
  fail('interval cap ' + G.maxIntervalMin + ' not held after the ladder: ' +
       intervals.join(','));
}

// ---- merge parity -----------------------------------------------------------
for (let i = 0; i < G.mergeCases.length; i++) {
  const c = G.mergeCases[i];
  // JSON has no undefined; Python's None arrives as null, and srs.js treats
  // null and undefined alike (plain falsy checks).
  const got = SRS.mergeEntry(c.a, c.b);
  checked++;
  if (JSON.stringify(got) !== JSON.stringify(c.merged)) {
    fail('merge case ' + i + ': got ' + JSON.stringify(got) +
         ', reference says ' + JSON.stringify(c.merged));
  }
}

// ---- removed-card merge parity ----------------------------------------------
for (let i = 0; i < G.removedCases.length; i++) {
  const c = G.removedCases[i];
  const got = SRS.mergeRemoved(c.a, c.b);
  checked++;
  if (JSON.stringify(got) !== JSON.stringify(c.merged)) {
    fail('removed case ' + i + ': got ' + JSON.stringify(got) +
         ', reference says ' + JSON.stringify(c.merged));
  }
}
const liveIds = SRS.liveCards([{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    { a: { removed: true, ts: 't' }, b: { removed: false, ts: 't' } })
    .map(c => c.id).join();
checked++;
if (liveIds !== 'b,c') fail('liveCards kept ' + liveIds + ', want b,c');

console.log('test-srs: ' + G.vectors.length + ' vectors, ' +
            G.mergeCases.length + ' merge cases, ' + checked +
            ' assertions, ' + failed + ' failure(s)');
process.exit(failed ? 1 : 0);
