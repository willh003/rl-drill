#!/usr/bin/env node
// Queue-building invariants for webapp/srs.js -- the same scenarios as
// test-queue.py runs against drill.py. The builders are randomised on
// purpose (ORDER_SLACK), so every scenario runs many times.

'use strict';
process.env.TZ = 'UTC';

const fs = require('fs');
const path = require('path');
const SRS = require('./webapp/srs.js');

const TRIALS = 40;
const NOW = new Date('2026-01-05T09:00:00');

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('FAIL: ' + msg); }
}

function makeDeck(nItems) {
  const cards = [];
  for (let i = 0; i < nItems; i++) {
    const base = 'item' + String(i).padStart(2, '0');
    for (const d of ['ar2en', 'en2ar']) {
      cards.push({ id: 'vocab:' + base + ':' + d, dir: d,
                   prompt: 'p' + i + d, answer: 'a' + i + d, hint: '',
                   options: ['a' + i + d, 'x', 'y', 'z'], cat: 'vocab',
                   lesson: 'L1' });
    }
  }
  return cards;
}

function seenEntry(minutesAgo, reps) {
  minutesAgo = minutesAgo === undefined ? 60 : minutesAgo;
  return { due: SRS.iso(new Date(NOW.getTime() - minutesAgo * 60000)),
           step: 3, interval_min: 1440, ease: 2.5,
           reps: reps === undefined ? 3 : reps, lapses: 0 };
}

const bases = q => q.map(p => SRS.baseOf(p[0].id));
function minSameBaseGap(q) {
  const last = {};
  let gap = q.length;
  bases(q).forEach((b, i) => {
    if (b in last) gap = Math.min(gap, i - last[b]);
    last[b] = i;
  });
  return gap;
}

// --- healthy session: big seen backlog --------------------------------------
const deck = makeDeck(26);
const state = {};
for (const c of deck) state[c.id] = seenEntry();
for (let t = 0; t < TRIALS; t++) {
  const q = SRS.selectQueue(deck, state, 'due', NOW);
  check(q.length === SRS.SESSION_CAP, 'cap: got ' + q.length);
  check(new Set(bases(q)).size === q.length, 'healthy session repeats an item');
}

// --- all-new deck: the drip -------------------------------------------------
for (let t = 0; t < TRIALS; t++) {
  const q = SRS.selectQueue(deck, {}, 'due', NOW);
  check(q.length === SRS.NEW_PER_SESSION,
        'new drip: got ' + q.length + ', want ' + SRS.NEW_PER_SESSION);
  check(q.every(p => p[1].reps === 0), 'non-new card in an all-new deck');
  check(new Set(bases(q)).size === q.length, 'new session repeats an item');
}

// --- mixed: backlog first, but new cards keep their reserved slots ----------
const deckMixed = makeDeck(28);
const stateMixed = {};
deckMixed.forEach((c, i) => {
  if (c.id.split(':')[1] < 'item18') stateMixed[c.id] = seenEntry(60 + i);
});
for (let t = 0; t < TRIALS; t++) {
  const q = SRS.selectQueue(deckMixed, stateMixed, 'due', NOW);
  const nNew = q.filter(p => p[1].reps === 0).length;
  check(q.length === SRS.SESSION_CAP, 'mixed cap: got ' + q.length);
  check(nNew === SRS.NEW_RESERVED,
        'mixed: ' + nNew + ' new, want the ' + SRS.NEW_RESERVED + ' reserved');
  const seenFlags = q.map(p => p[1].reps > 0 ? 1 : 0);
  check(seenFlags.join('') === seenFlags.slice().sort((a, b) => b - a).join(''),
        'a new card came before a review');
}

// --- thin session: siblings return, spread as far as possible ---------------
const deckThin = makeDeck(4);
const stateThin = {};
for (const c of deckThin) stateThin[c.id] = seenEntry();
for (let t = 0; t < TRIALS; t++) {
  const q = SRS.selectQueue(deckThin, stateThin, 'due', NOW);
  check(q.length === 8, 'thin session: got ' + q.length + ', want all 8');
  check(minSameBaseGap(q) >= 3,
        'thin session: siblings ' + minSameBaseGap(q) + ' apart');
}

// --- deliver:"table" never drills, in any mode ------------------------------
const exampleAll = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'cards.example.json')));
const tableIds = new Set(exampleAll.filter(c => c.deliver === 'table')
                                   .map(c => c.id));
check(tableIds.size > 0, 'example deck has no table cards');
check(SRS.drillable(exampleAll).every(c => c.deliver !== 'table'),
      'drillable() let a table card through');
const lapsed = {};
for (const c of exampleAll) {
  lapsed[c.id] = Object.assign(seenEntry(), { lapses: 2, ease: 2.1 });
}
const modes = ['due', 'all', 'vocab', 'sentences', 'ar2en', 'en2ar',
               'hardest', 'new', 'lesson'];
for (const mode of modes) {
  for (const st of [{}, lapsed]) {
    for (let t = 0; t < 10; t++) {
      const q = SRS.selectQueue(exampleAll, st, mode, NOW);
      check(!q.some(p => tableIds.has(p[0].id)),
            'table card drilled in mode ' + mode);
      check(q.length <= SRS.SESSION_CAP, 'cap broken in mode ' + mode);
    }
  }
}

console.log('test-queue.js: ' + (failures
    ? 'FAILED, ' + failures + ' failure(s)' : 'all invariants hold'));
process.exit(failures ? 1 : 0);
