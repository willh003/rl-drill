#!/usr/bin/env node
// Queue-building invariants for webapp/srs.js -- the same scenarios as
// test-queue.py runs against drill.py. The builders shuffle on purpose, so
// every scenario runs many times.

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

function makeDeck(n) {
  const topics = ['rl', 'math', 'ml'];
  const cards = [];
  for (let i = 0; i < n; i++) {
    cards.push({ id: topics[i % 3] + ':item' + String(i).padStart(2, '0'),
                 front: 'q' + i, back: 'a' + i, cat: topics[i % 3],
                 batch: i < n / 2 ? 'b1' : 'b2' });
  }
  return cards;
}

function seenEntry(minutesAgo, dueIn) {
  const t = dueIn !== undefined ? NOW.getTime() + dueIn * 60000
      : NOW.getTime() - (minutesAgo === undefined ? 60 : minutesAgo) * 60000;
  return { due: SRS.iso(new Date(t)), step: 3, interval_min: 1440,
           ease: 2.5, reps: 3, lapses: 0 };
}

const ids = q => q.map(p => p[0].id);
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// --- big seen backlog: capped, no repeats -----------------------------------
const deck = makeDeck(30);
const state = {};
for (const c of deck) state[c.id] = seenEntry();
for (let t = 0; t < TRIALS; t++) {
  const q = SRS.selectQueue(deck, state, 'due', NOW);
  check(q.length === SRS.SESSION_CAP, 'cap: got ' + q.length);
  check(new Set(ids(q)).size === q.length, 'a card was served twice');
}

// --- the oldest backlog is what makes the cut -------------------------------
const stateAged = {};
deck.forEach((c, i) => { stateAged[c.id] = seenEntry(60 + i); });
const oldest = deck.slice(-SRS.SESSION_CAP).map(c => c.id);
for (let t = 0; t < TRIALS; t++) {
  check(sameSet(ids(SRS.selectQueue(deck, stateAged, 'due', NOW)), oldest),
        'a newer review displaced an older one');
}

// --- all-new deck: the drip -------------------------------------------------
for (let t = 0; t < TRIALS; t++) {
  const q = SRS.selectQueue(deck, {}, 'due', NOW);
  check(q.length === SRS.NEW_PER_SESSION,
        'new drip: got ' + q.length + ', want ' + SRS.NEW_PER_SESSION);
  check(q.every(p => p[1].reps === 0), 'non-new card in an all-new deck');
  check(ids(q).join() === deck.slice(0, SRS.NEW_PER_SESSION).map(c => c.id).join(),
        'new cards left deck order');
}

// --- mixed: backlog first, but new cards keep their reserved slots ----------
const deckMixed = makeDeck(40);
const stateMixed = {};
deckMixed.slice(0, 25).forEach((c, i) => { stateMixed[c.id] = seenEntry(60 + i); });
for (let t = 0; t < TRIALS; t++) {
  const q = SRS.selectQueue(deckMixed, stateMixed, 'due', NOW);
  const nNew = q.filter(p => p[1].reps === 0).length;
  check(q.length === SRS.SESSION_CAP, 'mixed cap: got ' + q.length);
  check(nNew === SRS.NEW_RESERVED,
        'mixed: ' + nNew + ' new, want the ' + SRS.NEW_RESERVED + ' reserved');
  const flags = q.map(p => p[1].reps > 0 ? 1 : 0);
  check(flags.join('') === flags.slice().sort((a, b) => b - a).join(''),
        'a new card came before a review');
}

// --- due mode serves only what is due ---------------------------------------
const stateFuture = {};
for (const c of deck) stateFuture[c.id] = seenEntry(0, 600);
stateFuture[deck[0].id] = seenEntry();
check(ids(SRS.selectQueue(deck, stateFuture, 'due', NOW)).join() === deck[0].id,
      'due mode served something that is not due');

// --- every practice mode serves what its name says --------------------------
const lapsed = {};
for (const c of deck.slice(0, 6)) {
  lapsed[c.id] = Object.assign(seenEntry(0, 600), { lapses: 2, ease: 2.1 });
}
for (let t = 0; t < TRIALS / 4; t++) {
  for (const topic of ['rl', 'math', 'ml']) {
    const q = SRS.selectQueue(deck, {}, 'topic:' + topic, NOW);
    check(q.length && q.every(p => p[0].cat === topic), 'topic:' + topic);
  }
  let q = SRS.selectQueue(deck, {}, 'batch', NOW);
  check(q.length && q.every(p => p[0].batch === 'b2'), 'batch is not the latest');
  q = SRS.selectQueue(deck, lapsed, 'hardest', NOW);
  check(sameSet(ids(q), Object.keys(lapsed)), 'hardest');
  q = SRS.selectQueue(deck, lapsed, 'new', NOW);
  check(q.length && q.every(p => !(p[0].id in lapsed)), 'new served a seen card');
  q = SRS.selectQueue(deck, {}, 'all', NOW);
  check(q.length <= SRS.SESSION_CAP && new Set(ids(q)).size === q.length, 'all');
}
check(SRS.selectQueue(deck, {}, 'topic:nope', NOW).length === 0, 'unknown topic');

// --- the example deck loads and every mode copes with it --------------------
const example = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'cards.example.json')));
check(example.length > 0, 'example deck is empty');
const lapsedAll = {};
for (const c of example) lapsedAll[c.id] = Object.assign(seenEntry(), { lapses: 2 });
for (const mode of ['due', 'all', 'hardest', 'new', 'batch', 'topic:' + example[0].cat]) {
  for (const st of [{}, lapsedAll]) {
    check(SRS.selectQueue(example, st, mode, NOW).length <= SRS.SESSION_CAP,
          'cap broken in mode ' + mode);
  }
}

// --- removed cards never reach a session ------------------------------------
const rm = { [deck[0].id]: { removed: true, ts: 't' } };
const live = SRS.liveCards(deck, rm);
check(live.length === deck.length - 1, 'liveCards did not drop the removed card');
for (const mode of ['due', 'all', 'new', 'batch']) {
  check(!ids(SRS.selectQueue(live, {}, mode, NOW)).includes(deck[0].id),
        'removed card served in mode ' + mode);
}

console.log('test-queue.js: ' + (failures
    ? 'FAILED, ' + failures + ' failure(s)' : 'all invariants hold'));
process.exit(failures ? 1 : 0);
