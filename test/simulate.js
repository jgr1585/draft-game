'use strict';
// Spielt ein komplettes Spiel automatisch durch: node test/simulate.js
// Erwartet einen laufenden Server mit SPIN_MS=60 auf PORT (Standard 3999).
const { io } = require('socket.io-client');
const assert = require('assert');

const URL = `http://localhost:${process.env.PORT || 3999}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => new Promise((res) => { const s = io(URL, { transports: ['websocket'] }); s.on('connect', () => res(s)); });
const emit = (s, ev, p) => new Promise((res) => s.emit(ev, p || {}, res));
let state;

(async () => {
  const host = await connect();
  host.on('state', (s) => (state = s));
  assert((await emit(host, 'host:hello')).ok, 'host hello');
  await emit(host, 'host:reset', { keepPlayers: false });
  assert(!(await emit(host, 'host:config', { payoutMin: 10, payoutMax: 5 })).ok, 'payout min > max');
  assert(!(await emit(host, 'host:config', { payoutMin: 1.5 })).ok, 'payout whole numbers');
  assert((await emit(host, 'host:config', { maxPlayers: 3, rows: 5, payoutMin: -20, payoutMax: 60 })).ok);
  assert(!(await emit(host, 'host:config', { rows: 11 })).ok, 'rows limit');

  const names = ['Soso', 'Mia', 'Tom'];
  const ps = [];
  for (const name of names) {
    const s = await connect();
    const r = await emit(s, 'player:join', { name });
    assert(r.ok, r.error);
    ps.push({ s, id: r.playerId, name });
  }
  const extra = await connect();
  assert(!(await emit(extra, 'player:join', { name: 'Zu viel' })).ok, 'lobby full');

  const P0 = () => ps[0].s;
  // --- Joker-Einsätze in der Lobby einstellen (gilt sofort für alle Spieler)
  assert.deepEqual(state.players[0].jokers, { monster: 1, block: 1, swap: 1, peek: 1 }, 'default joker uses');
  assert(!(await emit(host, 'host:config', { jokerUses: { monster: 12 } })).ok, 'joker uses limit');
  assert((await emit(host, 'host:config', { jokerUses: { monster: 2, peek: 2 } })).ok);
  await sleep(20);
  assert.deepEqual(state.players[2].jokers, { monster: 2, block: 1, swap: 1, peek: 2 }, 'joker uses applied');
  // Nicht-Host darf nicht starten
  assert(!(await emit(ps[0].s, 'host:start')).ok, 'player cannot start');
  // --- Kategorie-Plan: vorbelegt, in der Lobby umstellbar
  const cats = state.categories.map((c) => c.name);
  assert.deepEqual(state.config.categoryPlan, [0, 1, 2, 3, 4].map((i) => cats[i % cats.length]), 'default plan cycles categories');
  const plan = [cats[2], null, cats[0], cats[1], cats[2]];
  assert(!(await emit(P0(), 'admin:categoryPlan', { plan })).ok, 'player cannot edit plan');
  assert(!(await emit(host, 'admin:categoryPlan', { plan: plan.slice(1) })).ok, 'plan length checked');
  assert(!(await emit(host, 'admin:categoryPlan', { plan: ['Gibtsnicht', null, null, null, null] })).ok, 'unknown category');
  assert((await emit(host, 'admin:categoryPlan', { plan })).ok);
  await sleep(20);
  assert.deepEqual(state.config.categoryPlan, plan);

  assert((await emit(host, 'host:start')).ok);
  await sleep(50);
  // --- Vorbereitung: Stapel der ersten Runde vor dem Start umsortieren
  assert.equal(state.phase, 'prepare', 'round starts with preparation');
  assert.equal(state.roundCategory, plan[0]);
  assert.equal(state.current, null, 'no auction yet');
  const prepAdmin = await connect();
  let PA; prepAdmin.on('admin', (a) => (PA = a));
  assert((await emit(prepAdmin, 'admin:hello')).ok); await sleep(30);
  assert(PA.queue.length > 1 && PA.queue.every((c) => c.category === plan[0]), 'queue of round category');
  const wanted = PA.queue.map((c) => c.id).reverse();
  assert((await emit(prepAdmin, 'admin:queue', { order: wanted })).ok);
  assert(!(await emit(P0(), 'bid', { amount: 1e8 })).ok, 'no bidding during preparation');
  assert(!(await emit(P0(), 'host:beginRound')).ok, 'player cannot begin round');
  assert((await emit(host, 'host:beginRound')).ok);
  await sleep(30);
  assert(!(await emit(host, 'host:beginRound')).ok, 'begin only once');
  assert.equal(state.phase, 'auction');
  assert.equal(PA.current.id, wanted[0], 'first char follows arranged order');
  assert.equal(state.current.char.category, plan[0], 'char from planned category');
  prepAdmin.close();
  const catOf = {};   // Runde -> Kategorie, wird unten geprüft
  let replanned = false;
  assert.equal(state.grid.length, 5);
  assert.equal(state.grid[0].length, 3);

  const P = (i) => ps[i];
  const money = (id) => state.players.find((p) => p.id === id).money;

  // --- Verdeckt: Name/Bild werden nicht verraten
  assert.equal(state.current.revealed, false);
  assert.equal(state.current.char.name, null, 'name hidden');
  assert.equal(state.current.char.image, null, 'image hidden');
  assert(state.current.char.category, 'category visible');
  const hidden = state.current.char;

  // --- Monster-Joker nur vor dem Aufdecken
  let r = await emit(P(1).s, 'joker', { type: 'monster' });
  assert(r.ok, r.error); await sleep(30);
  assert.equal(money(P(1).id), 1.1e9);
  assert((await emit(P(1).s, 'joker', { type: 'monster' })).ok, 'second use allowed'); await sleep(20);
  assert.equal(money(P(1).id), 1.2e9);
  assert.equal(state.players[1].jokers.monster, 0);
  assert(!(await emit(P(1).s, 'joker', { type: 'monster' })).ok, 'no uses left');
  // Skippen geht auch verdeckt (Umschalten an/aus)
  assert((await emit(P(0).s, 'skip')).ok, 'skip before reveal'); await sleep(20);
  assert(state.current.skips.includes(P(0).id));
  assert((await emit(P(0).s, 'skip')).ok); await sleep(20);
  assert(!state.current.skips.includes(P(0).id), 'skip toggled off');
  assert(!(await emit(P(0).s, 'host:reveal')).ok, 'player cannot reveal');
  assert((await emit(host, 'host:reveal')).ok);
  await sleep(30);
  assert(state.current.revealed && state.current.char.name, 'revealed');
  assert.equal(state.current.char.value, hidden.value);
  assert(!(await emit(P(0).s, 'joker', { type: 'monster' })).ok, 'no monster after reveal');

  // --- Validierungen
  const ch = state.current.char;
  r = await emit(P(0).s, 'bid', { amount: ch.value - 1 });
  assert(!r.ok, 'below start value');
  r = await emit(P(0).s, 'bid', { amount: 2e9 });
  assert(!r.ok, 'more than money');

  // --- Sperre: P0 sperrt P2, P1 bietet, P0 bietet höher, P1 steigt aus -> P0 gewinnt
  assert((await emit(P(0).s, 'joker', { type: 'block', targetId: P(2).id })).ok);
  assert(!(await emit(P(2).s, 'bid', { amount: ch.value })).ok, 'blocked cannot bid');
  assert((await emit(P(1).s, 'bid', { amount: ch.value })).ok);
  assert(!(await emit(P(1).s, 'joker', { type: 'block', targetId: P(0).id })).ok, 'no block after first bid');
  assert(!(await emit(P(1).s, 'withdraw')).ok, 'highest cannot withdraw');
  assert((await emit(P(0).s, 'bid', { amount: ch.value + 5e6 })).ok);
  assert((await emit(P(1).s, 'withdraw')).ok);
  await sleep(30);
  assert.equal(state.grid[0][0].charId, ch.id, 'P0 got char');
  assert.equal(money(P(0).id), 1e9 - ch.value - 5e6);

  // --- Gamemaster-Einstellungen: sehen verdeckte Charakter, sortieren den Stapel
  const admin = await connect();
  let A;
  admin.on('admin', (a) => (A = a));
  assert(!(await emit(P(1).s, 'admin:queue', { order: [] })).ok, 'player cannot edit queue');
  assert((await emit(admin, 'admin:hello')).ok);
  await sleep(30);
  assert.equal(state.current.char.name, null, 'public still hidden');
  assert(A.current.name, 'admin sees hidden name');
  const reversed = A.queue.map((c) => c.id).reverse();
  assert((await emit(admin, 'admin:queue', { order: reversed })).ok); await sleep(20);
  assert.deepEqual(A.queue.map((c) => c.id), reversed, 'queue reordered');
  assert(!(await emit(admin, 'admin:queue', { order: ['gibtsnicht'] })).ok, 'unknown id rejected');

  // --- Skip per Mehrheit (2 von 2 verbleibenden), noch verdeckt
  const before = A.current.id;
  assert.equal(state.current.revealed, false);
  await emit(P(1).s, 'skip'); await emit(P(2).s, 'skip');
  await sleep(30);
  assert.notEqual(A.current.id, before, 'skipped while hidden');
  assert.equal(A.current.id, reversed[0], 'next char follows reordered queue');
  assert.equal(state.skippedCount, 1);

  // --- Aussteigen geht auch verdeckt: steigen alle aus, ohne dass jemand geboten hat, ist er gleich weg
  let hiddenId = A.current.id;
  const skippedBefore = state.skippedCount;
  assert.equal(state.current.revealed, false);
  assert((await emit(P(1).s, 'withdraw')).ok, 'withdraw before reveal');
  assert((await emit(P(2).s, 'withdraw')).ok);
  await sleep(30);
  assert.notEqual(A.current.id, hiddenId, 'everyone out -> next char');
  assert.equal(state.skippedCount, skippedBefore + 1);
  assert(state.log.at(-1).msg.startsWith('Verdeckter Charakter'), 'name not leaked in log');
  // Mit Vorab-Gebot: Zuschlag erst nach dem Aufdecken
  hiddenId = A.current.id;
  const hv = state.current.char.value;
  assert((await emit(P(1).s, 'bid', { amount: hv })).ok);
  assert((await emit(P(2).s, 'withdraw')).ok);
  await sleep(30);
  assert.equal(A.current.id, hiddenId, 'no award while hidden');
  assert((await emit(host, 'host:reveal')).ok); await sleep(30);
  assert.equal(state.grid[0][1].charId, hiddenId, 'award right after reveal');

  // --- Musik: Play/Stopp und Status vom TV
  assert((await emit(host, 'host:config', { music: { playing: false } })).ok); await sleep(20);
  assert.equal(state.config.music.playing, false);
  assert((await emit(host, 'host:musicStatus', { state: 'blocked' })).ok); await sleep(20);
  assert.equal(state.musicStatus.state, 'blocked');
  assert(!(await emit(P(0).s, 'host:musicStatus', { state: 'playing' })).ok, 'player cannot report music');
  assert((await emit(host, 'host:config', { music: { playing: true } })).ok);

  // --- Geld und Joker ändern
  assert((await emit(admin, 'admin:money', { playerId: P(2).id, money: '500M' })).ok); await sleep(20);
  assert.equal(money(P(2).id), 500e6);
  assert((await emit(admin, 'admin:money', { playerId: P(2).id, delta: '+100M' })).ok); await sleep(20);
  assert.equal(money(P(2).id), 600e6);
  assert((await emit(admin, 'admin:joker', { playerId: P(1).id, type: 'monster', delta: 1 })).ok); await sleep(20);
  assert.equal(state.players[1].jokers.monster, 1, 'monster given back');
  assert((await emit(admin, 'admin:joker', { playerId: P(0).id, type: 'swap', delta: -1 })).ok); await sleep(20);
  assert.equal(state.players[0].jokers.swap, 0, 'swap removed');
  assert((await emit(admin, 'admin:joker', { playerId: P(0).id, type: 'swap', delta: -1 })).ok); await sleep(20);
  assert.equal(state.players[0].jokers.swap, 0, 'not below zero');
  assert((await emit(admin, 'admin:joker', { playerId: P(0).id, type: 'swap', uses: 1 })).ok);

  // --- Spicken: Position wählen, nur der Spieler sieht das Ergebnis
  await sleep(20);
  const hiddenNow = state.current.revealed ? null : A.current.id;
  const expectAt = (pos) => (hiddenNow ? [hiddenNow, ...A.queue.map((c) => c.id)] : A.queue.map((c) => c.id))[pos - 1];
  assert.equal(state.peek.count, (hiddenNow ? 1 : 0) + A.queue.length, 'peekable positions');
  assert(!(await emit(P(1).s, 'joker', { type: 'peek', position: 999 })).ok, 'invalid position');
  let pk = await emit(P(1).s, 'joker', { type: 'peek', position: 1 });
  assert(pk.ok && pk.peek.id === expectAt(1) && pk.peek.name, 'peek position 1');
  pk = await emit(P(1).s, 'joker', { type: 'peek', position: 2 });
  assert(pk.ok && pk.peek.id === expectAt(2), 'peek position 2');
  assert(!(await emit(P(1).s, 'joker', { type: 'peek', position: 1 })).ok, 'peek uses exhausted');
  await sleep(20);
  assert(!JSON.stringify(state.log).includes(pk.peek.name) || state.current.revealed, 'peek result not public');
  // Vom Gamemaster gesetzte Charakter verschwinden aus dem Stapel
  if (A.queue.length) {
    const qid = A.queue[0].id;
    assert((await emit(admin, 'admin:setCell', { round: 4, playerId: P(0).id, charId: qid })).ok); await sleep(20);
    assert(!A.queue.some((c) => c.id === qid), 'set char removed from queue');
    assert((await emit(admin, 'admin:setCell', { round: 4, playerId: P(0).id, charId: null })).ok);
  }

  // --- Eigene Glücksräder
  assert(!(await emit(admin, 'admin:wheelsSave', { wheels: [{ name: 'Kaputt', segments: ['nur eins'] }] })).ok, 'wheel needs 2 segments');
  assert((await emit(admin, 'admin:wheelsSave', { wheels: [{ name: 'Testrad', segments: ['A', 'B', 'C'] }, { name: 'Wer?', segments: 'players' }] })).ok);
  await sleep(20);
  assert.equal(A.wheels.length, 2);
  assert(!(await emit(admin, 'admin:wheelSpin')).ok, 'nothing shown yet');
  // Schritt 1: anzeigen – dreht noch nicht, Ziel bleibt geheim
  assert((await emit(admin, 'admin:wheelShow', { id: A.wheels[0].id })).ok);
  await sleep(150);
  assert.equal(state.customWheel.state, 'ready', 'shown, not spinning');
  assert.deepEqual(state.customWheel.labels, ['A', 'B', 'C']);
  assert.equal(state.customWheel.target, null, 'target not leaked');
  assert.equal(state.customWheel.result, null);
  assert(!(await emit(P(0).s, 'admin:wheelSpin')).ok, 'player cannot spin');
  // Schritt 2: drehen
  assert((await emit(admin, 'admin:wheelSpin')).ok);
  await sleep(10);
  assert.equal(state.customWheel.state, 'spinning');
  assert(!(await emit(admin, 'admin:wheelSpin')).ok, 'already spinning');
  assert(!(await emit(admin, 'admin:wheelShow', { id: A.wheels[1].id })).ok, 'no switching while spinning');
  await sleep(150);
  assert.equal(state.customWheel.state, 'done');
  assert(['A', 'B', 'C'].includes(state.customWheel.result), 'wheel result');
  assert((await emit(admin, 'admin:wheelSpin')).ok, 'spin again'); await sleep(150);
  assert(['A', 'B', 'C'].includes(state.customWheel.result));
  assert((await emit(admin, 'admin:wheelShow', { id: A.wheels[1].id })).ok, 'next wheel after result'); await sleep(20);
  assert.deepEqual(state.customWheel.labels, names, 'player wheel shows names');
  assert((await emit(admin, 'admin:wheelSpin')).ok); await sleep(150);
  assert(names.includes(state.customWheel.result), 'player wheel');
  assert((await emit(admin, 'admin:wheelClose')).ok); await sleep(20);
  assert.equal(state.customWheel, null);
  let payouts = 0;
  let swapTested = false;

  // --- Restliches Spiel: jeweils erster Bedürftiger bietet Startwert, Rest steigt aus
  let guard = 0;
  while (state.phase !== 'finished' && guard++ < 500) {
    if (state.phase === 'prepare') {
      assert((await emit(host, 'host:beginRound')).ok);
      await sleep(20);
      continue;
    }
    if (state.phase === 'auction' && state.round === 1 && !replanned) {
      // Während des Spiels: gespielte Runde fest, künftige Runden tauschen
      const p2 = [...state.roundCategories];
      const bad = [...p2]; bad[0] = cats[1];
      assert(!(await emit(host, 'admin:categoryPlan', { plan: bad })).ok, 'played round locked');
      [p2[3], p2[4]] = [p2[4], p2[3]];
      assert((await emit(host, 'admin:categoryPlan', { plan: p2 })).ok);
      await sleep(20);
      assert.deepEqual(state.roundCategories, p2, 'future rounds swapped');
      replanned = true;
    }
    if (state.phase === 'auction') {
      catOf[state.round] = state.roundCategory;
      if (state.roundCategory) assert.equal(state.current.char.category, state.roundCategory, 'char matches round category');
      if (!state.current.revealed) {
        // Vorab-Gebot vor dem Aufdecken darf noch nichts entscheiden
        assert((await emit(host, 'host:reveal')).ok); await sleep(20); continue;
      }
      const c = state.current;
      const need = c.need.map((id) => ps.find((p) => p.id === id));
      const rich = need.find((p) => money(p.id) >= c.char.value);
      if (!rich) { assert((await emit(host, 'host:giveChar', { playerId: need[0].id })).ok); await sleep(20); continue; }
      assert((await emit(rich.s, 'bid', { amount: c.char.value })).ok);
      for (const p of need) if (p !== rich) await emit(p.s, 'withdraw');
      await sleep(20);
    } else if (state.phase === 'payout') {
      // Rundengeld: jeder bekommt einen Betrag aus der Liste, ohne Rad
      const po = state.payout;
      assert.equal(po.results.length, 3);
      for (const r of po.results) {
        assert(r.amount % 1e6 === 0 && r.amount >= -20e6 && r.amount <= 60e6, 'payout whole Mio in range');
        assert.equal(money(r.playerId), r.before + r.amount, 'payout applied');
      }
      payouts++;
      if (!swapTested) {
        // Tausch ist ein Angebot: ablehnen kostet nichts, annehmen tauscht und verbraucht den Joker
        const mine = state.grid[0][2].charId, theirs = state.grid[0][0].charId;
        let o = await emit(P(2).s, 'joker', { type: 'swap', targetId: P(0).id, row: 0 });
        assert(o.ok && o.pending, 'offer created'); await sleep(20);
        assert.equal(state.trades.length, 1);
        assert.equal(state.grid[0][2].charId, mine, 'nothing swapped yet');
        assert(!(await emit(P(2).s, 'joker', { type: 'swap', targetId: P(1).id, row: 0 })).ok, 'one open offer only');
        assert((await emit(P(0).s, 'trade:respond', { id: state.trades[0].id, accept: false })).ok); await sleep(20);
        assert.equal(state.trades.length, 0);
        assert.equal(state.players[2].jokers.swap, 1, 'decline keeps joker');
        o = await emit(P(2).s, 'joker', { type: 'swap', targetId: P(0).id, row: 0 }); await sleep(20);
        const tid = state.trades[0].id;
        assert(!(await emit(P(1).s, 'trade:respond', { id: tid, accept: true })).ok, 'only target can answer');
        assert((await emit(P(0).s, 'trade:respond', { id: tid, accept: true })).ok); await sleep(20);
        assert.equal(state.grid[0][2].charId, theirs, 'swapped after accept');
        assert.equal(state.grid[0][0].charId, mine);
        assert.equal(state.players[2].jokers.swap, 0, 'accept uses joker');
        // Gamemaster tauscht ohne Zustimmung (auch über Runden hinweg) und wieder zurück
        const a00 = state.grid[0][0].charId, b11 = state.grid[1]?.[1]?.charId;
        assert((await emit(host, 'admin:swapCells', { a: { round: 0, playerId: P(0).id }, b: { round: 1, playerId: P(1).id } })).ok); await sleep(20);
        assert.equal(state.grid[1][1].charId, a00, 'GM swap');
        assert.equal(state.grid[0][0]?.charId, b11);
        assert((await emit(host, 'admin:swapCells', { a: { round: 0, playerId: P(0).id }, b: { round: 1, playerId: P(1).id } })).ok); await sleep(20);
        assert.equal(state.grid[0][0].charId, a00, 'GM swap back');
        swapTested = true;
      }
      assert((await emit(host, 'host:nextRound')).ok);
      await sleep(30);
    }
  }
  assert.equal(state.phase, 'finished');
  // Nach dem Spiel: Tausch-Joker geht noch, alles andere nicht
  assert(!(await emit(P(0).s, 'joker', { type: 'monster' })).ok, 'no monster after the game');
  {
    const mine = state.grid[4][state.players[0].column].charId, theirs = state.grid[4][state.players[1].column].charId;
    assert((await emit(P(0).s, 'joker', { type: 'swap', targetId: P(1).id, row: 4 })).ok, 'swap offer after the game'); await sleep(20);
    assert((await emit(P(1).s, 'trade:respond', { id: state.trades[0].id, accept: true })).ok); await sleep(20);
    assert.equal(state.grid[4][state.players[0].column].charId, theirs, 'swapped after the game');
    assert.equal(state.grid[4][state.players[1].column].charId, mine);
    assert.equal(state.players[0].jokers.swap, 0);
  }
  assert.equal(payouts, 4, 'one payout per round except the last');
  assert.equal(state.payout, null, 'no payout at the end');
  assert(swapTested, 'swap tested');
  assert.deepEqual(state.roundCategories, [plan[0], null, plan[2], plan[4], plan[3]], 'rounds followed the (re)arranged plan');
  assert(Object.keys(catOf).length === 5, 'all rounds seen');
  for (const [r, cat] of Object.entries(catOf)) {
    if (cat) assert(state.grid[r].every((cell) => cell.char.category === cat || state.phase === 'finished'), `round ${r} category`);
  }
  state.grid.forEach((row, r) => {
    const ids = row.map((c) => c.charId);
    if (cats.length && state.roundCategories[r]) assert.equal(new Set(ids).size, ids.length, `no duplicate in round ${r + 1}`);
  });
  console.log('Kategorien:', state.roundCategories.map((c) => c || 'Gemischt').join(', '));
  assert(state.grid.every((row) => row.every(Boolean)), 'grid full');
  const ids = state.grid.flat().map((c) => c.charId);
  console.log('Raster:', state.grid.map((row) => row.map((c) => c.char.name.padEnd(14)).join(' ')).join('\n        '));
  console.log('Geld:', state.players.map((p) => `${p.name}: ${(p.money / 1e6).toFixed(0)} Mio`).join(', '));
  console.log('Log (Ende):', state.log.map((l) => l.msg).join(' | '));
  console.log(`\nOK – Spiel komplett durchgelaufen (${ids.length} Felder, ${new Set(ids).size} verschiedene Charakter).`);
  process.exit(0);
})().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });
