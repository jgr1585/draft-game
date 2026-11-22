'use strict';
// Gamemaster-Einstellungsfenster: sieht die verdeckten Charakter und kann das ganze Spiel verändern.

const socket = io();
const params = new URLSearchParams(location.search);
let S = null;     // öffentlicher Zustand
let A = null;     // Admin-Zustand (Stapel, Räder …)
let tab = params.get('tab') || (() => { try { return localStorage.getItem('admin-tab') || 'game'; } catch { return 'game'; } })();
let selectedCell = null;     // { r, pid } im Raster-Tab
let wheelDraft = null;       // Bearbeitungsstand der Glücksräder
let wheelDirty = false;
let wheelSel = 0;
let addFilter = '';
let dragging = false;

socket.on('connect', async () => {
  const r = await emit(socket, 'admin:hello', { key: params.get('key') });
  $('#fatal').hidden = r.ok;
  if (!r.ok) $('#fatal').textContent = r.error;
});
socket.on('disconnect', () => toast('Verbindung zum Server verloren …'));
socket.on('state', (s) => { checkBuild(s); S = s; render(); });
socket.on('admin', (a) => { A = a; render(); });

async function act(event, payload, okMsg) {
  const r = await emit(socket, event, payload);
  if (!r.ok) toast(r.error);
  else if (okMsg) toast(okMsg, 'ok');
  return r;
}

const PHASE = { lobby: 'Lobby', prepare: 'Vorbereitung', auction: 'Auktion', payout: 'Rundengeld', finished: 'Spiel vorbei' };
const JOKERS = { monster: 'Weißes Monster', block: 'Sperre', swap: 'Tausch', peek: 'Spicken' };
const byId = () => Object.fromEntries(S.players.map((p) => [p.id, p]));

// Formularfelder nicht unter dem Cursor neu aufbauen
const editing = (el) => el.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
// Während die Maus gedrückt ist, nichts neu aufbauen – sonst geht der Klick verloren
let pointerDown = false;
document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
document.addEventListener('pointerup', () => { pointerDown = false; setTimeout(render, 0); }, true);
document.addEventListener('focusout', () => { if (!pointerDown) setTimeout(render, 0); });

// ---------------------------------------------------------------------------
let prepareSeen = null;
function render() {
  if (!S || !A || pointerDown) return;
  const prepKey = S.phase === 'prepare' ? `${S.round}|${S.roundCategory}` : null;
  if (prepKey && prepKey !== prepareSeen) {
    tab = 'queue';
    try { localStorage.setItem('admin-tab', tab); } catch { /* egal */ }
  }
  prepareSeen = prepKey;
  renderTop();
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${tab}`; });
  const el = $(`#tab-${tab}`);
  if (editing(el) || dragging) return;
  ({ game: renderGameTab, queue: renderQueueTab, players: renderPlayersTab, grid: renderGridTab, wheels: renderWheelsTab, settings: renderSettingsTab })[tab](el);
}

$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]')?.dataset.tab;
  if (!t) return;
  tab = t;
  try { localStorage.setItem('admin-tab', t); } catch { /* egal */ }
  render();
});

// ---------------------------------------------------------------------------
// Kopfzeile mit den wichtigsten Knöpfen
// ---------------------------------------------------------------------------
function renderTop() {
  const cat = ['prepare', 'auction', 'payout'].includes(S.phase) ? ` · ${esc(S.roundCategory || 'Gemischt')}` : '';
  const round = S.phase === 'lobby' ? `${S.players.length} Spieler in der Lobby` : `Runde ${S.round + 1} / ${S.grid.length}${cat}`;
  $('#status').innerHTML = `<span class="phase">${PHASE[S.phase] || S.phase}</span> <span>${round}</span>`;

  const c = S.current;
  let q = '';
  if (S.phase === 'lobby') q = `<button class="btn primary" data-act="host:start">Spiel starten</button>`;
  if (S.phase === 'prepare') q = `<button class="btn primary" data-act="host:beginRound">Runde ${S.round + 1} starten</button> <button class="btn" data-goto="queue">Stapel ordnen</button>`;
  if (S.phase === 'auction' && c) {
    q = (c.revealed
      ? `<button class="btn primary" data-act="host:hammer" ${c.highest ? '' : 'disabled'}>Zuschlag</button>`
      : `<button class="btn primary" data-act="host:reveal">Aufdecken</button>`) +
      ` <button class="btn" data-act="host:skipChar">Skippen</button>
        <button class="btn" data-act="admin:resetAuction" data-confirm="Alle Gebote, Ausstiege, Sperren und Skips für diesen Charakter zurücksetzen?">Gebote zurücksetzen</button>`;
  }
  if (S.phase === 'payout') q = `<button class="btn primary" data-act="host:nextRound">Weiter mit Runde ${S.round + 2}</button>`;
  const w = S.customWheel;
  if (w) q += ` ${activeWheelHtml(w)}`;
  $('#quick').innerHTML = q;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b) {
    if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
    act(b.dataset.act, b.dataset.payload ? JSON.parse(b.dataset.payload) : {});
  }
  const g = e.target.closest('[data-goto]');
  if (g) { tab = g.dataset.goto; render(); }
});

// Status + Knöpfe fürs gerade angezeigte Rad (Kopfzeile und Räder-Tab)
function activeWheelHtml(w) {
  const st = w.state === 'ready' ? 'wartet' : w.state === 'spinning' ? 'dreht …' : `<b class="hot">${esc(w.result)}</b>`;
  return `<span class="wheelstate">Rad „${esc(w.name)}“: ${st}</span>
    ${w.state !== 'spinning' ? `<button class="btn small primary" data-act="admin:wheelSpin">${w.state === 'done' ? 'Nochmal drehen' : 'Drehen'}</button>
      <button class="btn small" data-act="admin:wheelClose">Schließen</button>` : ''}`;
}

const charLine = (ch, extra = '') => `
  <img class="thumb" src="${esc(ch.image)}" alt="">
  <span class="cn"><b>${esc(ch.name)}</b><span class="cat">${esc(ch.category)}</span></span>
  <span class="val">${fmt(ch.value)}</span>${extra}`;

// ---------------------------------------------------------------------------
// Tab: Spiel
// ---------------------------------------------------------------------------
function renderGameTab(el) {
  const c = S.current, ac = A.current, P = byId();
  let cur = '<p class="muted">Gerade wird kein Charakter versteigert.</p>';
  if (c && ac) {
    const top = c.highest && P[c.highest.playerId];
    const rows = S.players.map((p) => {
      const has = S.grid[S.round]?.[p.column];
      let st = 'bietet mit';
      if (has) st = 'Runde erledigt';
      else if (c.highest?.playerId === p.id) st = `<b class="hot">Höchstgebot ${fmt(c.highest.amount)}</b>`;
      else if (c.blocked.includes(p.id)) st = 'gesperrt';
      else if (c.withdrawn.includes(p.id)) st = 'ausgestiegen';
      if (c.skips.includes(p.id)) st += ' · will skippen';
      return `<tr><td>${esc(p.name)}</td><td>${fmt(p.money)}</td><td>${st}</td>
        <td>${has ? '' : `<button class="btn small ghost" data-give="${p.id}">Verschenken</button>`}</td></tr>`;
    }).join('');
    cur = `
      <div class="curcard">
        <img src="${esc(ac.image)}" alt="">
        <div>
          <div class="big">${esc(ac.name)} ${ac.revealed ? '<span class="badge ok">aufgedeckt</span>' : '<span class="badge">verdeckt – nur du siehst den Namen</span>'}</div>
          <div><span class="cat">${esc(ac.category)}</span> · Startwert ${fmt(ac.value)}</div>
          <div class="muted">Höchstgebot: ${top ? `${fmt(c.highest.amount)} von ${esc(top.name)}` : '–'} · Skips ${c.skips.length}/${c.skipNeeded}</div>
        </div>
      </div>
      <table class="tbl"><tr><th>Spieler</th><th>Geld</th><th>Status</th><th></th></tr>${rows}</table>`;
  }

  const plan = currentPlan();
  const locked = lockedRounds();
  const planRows = plan.map((cat, r) => {
    const isLocked = r < locked;
    const isCur = ['prepare', 'auction'].includes(S.phase) && r === S.round;
    const opts = [`<option value="">Gemischt (alle)</option>`, ...S.categories.map((k) =>
      `<option value="${esc(k.name)}" ${cat === k.name ? 'selected' : ''}>${esc(k.name)} (${k.count})</option>`)].join('');
    return `<li class="planrow ${isLocked ? 'locked' : ''} ${isCur ? 'cur' : ''}">
      <span class="pos">R${r + 1}</span>
      <select data-plan="${r}" ${isLocked ? 'disabled' : ''}>${opts}</select>
      <span class="acts">
        <button class="btn small ghost" data-planmove="up" data-r="${r}" ${isLocked || r - 1 < locked ? 'disabled' : ''} title="Mit der Runde davor tauschen">↑</button>
        <button class="btn small ghost" data-planmove="down" data-r="${r}" ${isLocked || r + 1 >= plan.length ? 'disabled' : ''} title="Mit der Runde danach tauschen">↓</button>
      </span>
      <span class="muted small">${isLocked ? 'gespielt' : isCur ? (S.phase === 'prepare' ? 'wird vorbereitet' : 'läuft gerade') : ''}</span>
    </li>`;
  }).join('');

  el.innerHTML = `
    <div class="cols">
      <div class="panel">
        <h2>Aktueller Charakter</h2>
        ${cur}
      </div>
      <div class="panel">
        <div class="row between"><h2>Kategorien pro Runde</h2>
          <span><button class="btn small" data-planop="auto">Automatisch</button> <button class="btn small" data-planop="shuffle">Mischen</button></span></div>
        <ol class="planlist">${planRows}</ol>
        <p class="muted small">Vorbelegt mit allen Kategorien der Reihe nach. Gespielte Runden sind fest. Ändert sich die laufende Runde, wird ihr Stapel neu gemischt (aktuelles Gebot verfällt).</p>
        <h2>Verlauf</h2>
        <div class="log">${S.log.slice().reverse().map((l) => `<div>${esc(l.msg)}</div>`).join('')}</div>
      </div>
    </div>`;
}

// ----- Kategorie-Plan
const currentPlan = () => (S.phase === 'lobby' ? S.config.categoryPlan : S.roundCategories).map((c) => c ?? null);
const lockedRounds = () => (S.phase === 'lobby' ? 0 : S.phase === 'finished' ? S.grid.length : S.phase === 'payout' ? S.round + 1 : S.round);

function savePlan(plan) {
  const curChanged = ['prepare', 'auction'].includes(S.phase) && plan[S.round] !== currentPlan()[S.round];
  const what = S.phase === 'auction' ? 'Ihr Stapel wird neu gemischt, das aktuelle Gebot verfällt und die Runde startet wieder mit der Vorbereitung.' : 'Ihr Stapel wird neu gemischt (deine Sortierung geht verloren).';
  if (curChanged && !confirm(`Die Kategorie von Runde ${S.round + 1} ändert sich. ${what} Weiter?`)) return render();
  act('admin:categoryPlan', { plan }, 'Plan gespeichert');
}

$('#tab-game').addEventListener('change', (e) => {
  if (e.target.dataset.plan === undefined) return;
  const plan = currentPlan();
  plan[Number(e.target.dataset.plan)] = e.target.value || null;
  e.target.blur();
  savePlan(plan);
});

$('#tab-game').addEventListener('click', (e) => {
  const mv = e.target.closest('[data-planmove]');
  if (mv) {
    const plan = currentPlan(), r = Number(mv.dataset.r), o = mv.dataset.planmove === 'up' ? r - 1 : r + 1;
    [plan[r], plan[o]] = [plan[o], plan[r]];
    return savePlan(plan);
  }
  const op = e.target.closest('[data-planop]')?.dataset.planop;
  if (op) {
    const plan = currentPlan(), locked = lockedRounds();
    const cats = S.categories.map((k) => k.name);
    const open = plan.slice(locked);
    let fresh;
    if (op === 'auto') fresh = open.map((_, i) => (cats.length ? cats[(locked + i) % cats.length] : null));
    else {
      fresh = [...open];
      for (let k = fresh.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [fresh[k], fresh[j]] = [fresh[j], fresh[k]]; }
    }
    return savePlan([...plan.slice(0, locked), ...fresh]);
  }
  const give = e.target.closest('[data-give]')?.dataset.give;
  if (give) {
    const p = byId()[give];
    if (confirm(`${A.current?.name} gratis an ${p.name} geben?`)) act('host:giveChar', { playerId: give });
  }
});

// ---------------------------------------------------------------------------
// Tab: Stapel (kommende Charakter sehen und umsortieren)
// ---------------------------------------------------------------------------
function renderQueueTab(el) {
  const queueIds = new Set(A.queue.map((c) => c.id));
  const owned = new Map();
  S.grid.forEach((row, r) => row.forEach((cell, col) => { if (cell) owned.set(cell.charId, `${S.players[col]?.name}, R${r + 1}`); }));

  const q = A.queue.map((ch, i) => `
    <li class="qrow" draggable="true" data-i="${i}">
      <span class="handle" title="Ziehen zum Umsortieren">⠿</span><span class="pos">${i + 1}</span>
      ${charLine(ch)}
      <span class="acts">
        <button class="btn small ghost" data-q="top" title="Ganz nach oben">⤒</button>
        <button class="btn small ghost" data-q="up" title="Hoch">↑</button>
        <button class="btn small ghost" data-q="down" title="Runter">↓</button>
        <button class="btn small ghost" data-q="remove" title="Aus dem Stapel nehmen">✕</button>
      </span>
    </li>`).join('');

  const cats = [...new Set(A.characters.map((c) => c.category))];
  const pool = A.characters.filter((c) => !addFilter || c.category === addFilter).map((ch) => `
    <li class="qrow">
      ${charLine(ch, `<span class="muted small">${queueIds.has(ch.id) ? 'im Stapel' : owned.has(ch.id) ? esc(owned.get(ch.id)) : ''}</span>`)}
      <span class="acts">
        <button class="btn small ghost" data-add="top" data-id="${ch.id}">nach oben</button>
        <button class="btn small ghost" data-add="bottom" data-id="${ch.id}">unten</button>
      </span>
    </li>`).join('');

  const sk = A.skipped.map((ch, i) => `<li class="qrow">${charLine(ch)}<span class="acts"><button class="btn small ghost" data-unskip="${i}">→ Stapel oben</button></span></li>`).join('');

  const prep = S.phase === 'prepare' ? `
    <div class="panel prepbar">
      <div><b>Runde ${S.round + 1} · ${esc(S.roundCategory || 'Gemischt')}</b><br>
        <span class="muted small">Reihenfolge festlegen (ziehen oder ⤒ ↑ ↓), dann die Runde starten. Der oberste Charakter kommt zuerst.</span></div>
      <button class="btn primary" data-act="host:beginRound">Runde ${S.round + 1} starten</button>
    </div>` : '';
  el.innerHTML = `${prep}
    <div class="cols">
      <div class="panel">
        <div class="row between"><h2>Als Nächstes (${A.queue.length})</h2>
          <span><button class="btn small" data-q="shuffle">Mischen</button> <button class="btn small danger" data-q="clear">Leeren</button></span></div>
        ${A.current ? `<div class="qrow current"><span class="pos">▶</span>${charLine(A.current, `<span class="badge">${A.current.revealed ? 'läuft' : 'läuft, verdeckt'}</span>`)}</div>` : ''}
        <ol id="queueList" class="qlist">${q || '<li class="muted">Stapel leer – wird automatisch mit der Kategorie der Runde neu gemischt.</li>'}</ol>
        <h2>Übersprungen (${A.skipped.length})</h2>
        <p class="muted small">Kommen automatisch wieder dran, wenn der Stapel leer ist.</p>
        <ol class="qlist">${sk || '<li class="muted">–</li>'}</ol>
        ${A.skipped.length ? '<button class="btn small" data-unskip="all">Alle zurück in den Stapel</button>' : ''}
      </div>
      <div class="panel">
        <div class="row between"><h2>Charakter hinzufügen</h2>
          <select id="addFilter"><option value="">Alle Kategorien</option>${cats.map((k) => `<option ${k === addFilter ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></div>
        <ol class="qlist">${pool}</ol>
      </div>
    </div>`;
}

const ids = (list) => list.map((c) => c.id);
const setQueue = (order) => act('admin:queue', { order });

$('#tab-queue').addEventListener('change', (e) => {
  if (e.target.id === 'addFilter') { addFilter = e.target.value; e.target.blur(); render(); }
});

$('#tab-queue').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const order = ids(A.queue);
  if (b.dataset.q) {
    const i = Number(b.closest('[data-i]')?.dataset.i);
    const op = b.dataset.q;
    if (op === 'shuffle') {
      for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
    } else if (op === 'clear') {
      if (!confirm('Stapel leeren? Er wird dann automatisch neu gemischt.')) return;
      order.length = 0;
    } else if (op === 'top') order.unshift(order.splice(i, 1)[0]);
    else if (op === 'up' && i > 0) [order[i - 1], order[i]] = [order[i], order[i - 1]];
    else if (op === 'down' && i < order.length - 1) [order[i + 1], order[i]] = [order[i], order[i + 1]];
    else if (op === 'remove') order.splice(i, 1);
    return setQueue(order);
  }
  if (b.dataset.add) {
    const id = b.dataset.id;
    const without = order.filter((x) => x !== id);
    return setQueue(b.dataset.add === 'top' ? [id, ...without] : [...without, id]);
  }
  if (b.dataset.unskip !== undefined) {
    const skipped = ids(A.skipped);
    const back = b.dataset.unskip === 'all' ? skipped : skipped.splice(Number(b.dataset.unskip), 1);
    const rest = b.dataset.unskip === 'all' ? [] : skipped;
    act('admin:skipped', { order: rest }).then((r) => r.ok && setQueue([...back, ...order.filter((x) => !back.includes(x))]));
  }
});

// Drag & Drop im Stapel
let dragFrom = null;
$('#tab-queue').addEventListener('dragstart', (e) => {
  const li = e.target.closest('#queueList [data-i]');
  if (!li) return;
  dragFrom = Number(li.dataset.i);
  dragging = true;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});
$('#tab-queue').addEventListener('dragover', (e) => {
  const li = e.target.closest('#queueList [data-i]');
  if (!li || dragFrom === null) return;
  e.preventDefault();
  document.querySelectorAll('.dropabove, .dropbelow').forEach((x) => x.classList.remove('dropabove', 'dropbelow'));
  const below = e.offsetY > li.offsetHeight / 2;
  li.classList.add(below ? 'dropbelow' : 'dropabove');
});
$('#tab-queue').addEventListener('drop', (e) => {
  const li = e.target.closest('#queueList [data-i]');
  if (!li || dragFrom === null) return;
  e.preventDefault();
  let to = Number(li.dataset.i) + (li.classList.contains('dropbelow') ? 1 : 0);
  const order = ids(A.queue);
  const [moved] = order.splice(dragFrom, 1);
  if (to > dragFrom) to--;
  order.splice(to, 0, moved);
  dragFrom = null; dragging = false;
  setQueue(order);
});
$('#tab-queue').addEventListener('dragend', () => { dragFrom = null; dragging = false; render(); });

// ---------------------------------------------------------------------------
// Tab: Spieler (Geld, Joker, Name)
// ---------------------------------------------------------------------------
function renderPlayersTab(el) {
  if (!S.players.length) { el.innerHTML = '<div class="panel muted">Noch keine Spieler.</div>'; return; }
  el.innerHTML = `<div class="pgrid">${S.players.map((p) => `
    <div class="panel pcard">
      <div class="row">${avatarHtml(p)}<input class="pname" data-rename="${p.id}" value="${esc(p.name)}" maxlength="20">
        <span class="dot ${p.connected ? 'on' : ''}" title="${p.connected ? 'verbunden' : 'offline'}"></span></div>
      <div class="money">${fmt(p.money)}</div>
      <div class="row">
        <input class="minput" data-money="${p.id}" placeholder="z. B. 750M oder 1,2Mrd">
        <button class="btn small" data-setmoney="${p.id}">Setzen</button>
      </div>
      <div class="row deltas">${['-100M', '-50M', '-10M', '+10M', '+50M', '+100M'].map((d) =>
        `<button class="btn small ghost" data-delta="${d}" data-pid="${p.id}">${d.replace('M', '')}</button>`).join('')}</div>
      <div class="jokers">${Object.entries(JOKERS).map(([k, label]) => `
        <span class="jk ${p.jokers[k] > 0 ? '' : 'none'}">${label}
          <button class="btn small ghost" data-jd="-1" data-joker="${k}" data-pid="${p.id}" ${p.jokers[k] > 0 ? '' : 'disabled'}>−</button>
          <b>${p.jokers[k] || 0}</b>
          <button class="btn small ghost" data-jd="1" data-joker="${k}" data-pid="${p.id}">+</button></span>`).join('')}
      </div>
      <p class="muted small">Zahl = übrige Einsätze</p>
    </div>`).join('')}</div>`;
}

$('#tab-players').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.rename) act('admin:rename', { playerId: t.dataset.rename, name: t.value }, 'Name geändert');
});
$('#tab-players').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset.money) { e.preventDefault(); $(`[data-setmoney="${e.target.dataset.money}"]`).click(); }
});
$('#tab-players').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.setmoney) {
    const input = $(`[data-money="${b.dataset.setmoney}"]`);
    if (!input.value.trim()) return toast('Betrag eingeben, z. B. 500M');
    const r = await act('admin:money', { playerId: b.dataset.setmoney, money: input.value.trim() }, 'Geld gesetzt');
    if (r.ok) { input.value = ''; input.blur(); }
  }
  if (b.dataset.delta) act('admin:money', { playerId: b.dataset.pid, delta: b.dataset.delta });
  if (b.dataset.jd) act('admin:joker', { playerId: b.dataset.pid, type: b.dataset.joker, delta: Number(b.dataset.jd) });
});

// ---------------------------------------------------------------------------
// Tab: Raster (Charakter entfernen / zuweisen)
// ---------------------------------------------------------------------------
function renderGridTab(el) {
  if (!S.grid.length) { el.innerHTML = '<div class="panel muted">Das Raster entsteht beim Spielstart.</div>'; return; }
  const head = S.grid.map((_, r) => `<th>Runde ${r + 1}<br><small>${esc(S.roundCategories[r] === undefined ? '' : S.roundCategories[r] || 'Gemischt')}</small></th>`).join('');
  const body = S.players.map((p) => `<tr><th>${esc(p.name)}</th>${S.grid.map((row, r) => {
    const cell = row[p.column];
    const sel = selectedCell && selectedCell.r === r && selectedCell.pid === p.id;
    return `<td class="gcell ${sel ? 'sel' : ''} ${r === S.round && S.phase !== 'finished' ? 'cur' : ''}" data-r="${r}" data-pid="${p.id}">
      ${cell ? `<b>${esc(cell.char?.name)}</b><br><small>${fmt(cell.price)}</small>` : '<span class="muted">leer</span>'}</td>`;
  }).join('')}</tr>`).join('');

  let editor = '<p class="muted">Ein Feld anklicken, um es zu bearbeiten.</p>';
  let swapDefault = 0;
  if (selectedCell) {
    const p = byId()[selectedCell.pid];
    const cell = p && S.grid[selectedCell.r]?.[p.column];
    const groups = [...new Set(A.characters.map((c) => c.category))].map((k) =>
      `<optgroup label="${esc(k)}">${A.characters.filter((c) => c.category === k).map((c) => `<option value="${c.id}">${esc(c.name)} (${fmt(c.value)})</option>`).join('')}</optgroup>`).join('');
    editor = p ? `
      <h3>${esc(p.name)} · Runde ${selectedCell.r + 1}</h3>
      <p>${cell ? `Jetzt: <b>${esc(cell.char?.name)}</b> für ${fmt(cell.price)}` : 'Feld ist leer.'}</p>
      ${cell ? `<div class="row"><button class="btn" data-clear="refund">Entfernen + Geld zurück</button><button class="btn danger" data-clear="keep">Entfernen ohne Geld</button></div>` : ''}
      <h3>${cell ? 'Ersetzen durch' : 'Charakter setzen'}</h3>
      <div class="row"><select id="cellChar">${groups}</select></div>
      <div class="row"><input id="cellPrice" placeholder="Preis (wird abgezogen), leer = gratis"><button class="btn primary" id="cellSet">Setzen</button></div>
      ${cell ? '<label class="small"><input type="checkbox" id="cellRefund"> Preis des alten Charakters zurückgeben</label>' : ''}
      <h3>Tauschen <span class="muted small">(ohne dass die Spieler zustimmen müssen)</span></h3>
      <div class="row"><select id="swapWith">${S.grid.map((row, r) => `<optgroup label="Runde ${r + 1}">${S.players.filter((x) => !(x.id === p.id && r === selectedCell.r)).map((x) => {
        const other = row[x.column];
        return `<option value="${r}:${x.id}" ${r === selectedCell.r && !swapDefault++ ? 'selected' : ''}>${esc(x.name)} · ${other ? esc(other.char?.name) : 'leer'}</option>`;
      }).join('')}</optgroup>`).join('')}</select><button class="btn" id="cellSwap">Tauschen</button></div>
      <p class="muted small">Die Preise wandern mit den Charakteren mit. Geld ändert sich nicht.</p>` : '';
  }
  el.innerHTML = `<div class="panel"><div class="scroll"><table class="tbl grid"><tr><th></th>${head}</tr>${body}</table></div></div>
    <div class="panel">${editor}</div>`;
}

$('#tab-grid').addEventListener('click', (e) => {
  const td = e.target.closest('.gcell');
  if (td) { selectedCell = { r: Number(td.dataset.r), pid: td.dataset.pid }; return render(); }
  if (!selectedCell) return;
  const b = e.target.closest('button');
  if (b?.dataset.clear) {
    act('admin:setCell', { round: selectedCell.r, playerId: selectedCell.pid, charId: null, refund: b.dataset.clear === 'refund' });
  }
  if (b?.id === 'cellSwap') {
    const [r, pid] = $('#swapWith').value.split(':');
    act('admin:swapCells', { a: { round: selectedCell.r, playerId: selectedCell.pid }, b: { round: Number(r), playerId: pid } }, 'Getauscht');
  }
  if (b?.id === 'cellSet') {
    act('admin:setCell', { round: selectedCell.r, playerId: selectedCell.pid, charId: $('#cellChar').value, price: $('#cellPrice').value.trim(), refund: !!$('#cellRefund')?.checked });
  }
});

// ---------------------------------------------------------------------------
// Tab: Glücksräder (vordefinieren, speichern in wheels/wheels.json, jederzeit drehen)
// ---------------------------------------------------------------------------
const clone = (x) => JSON.parse(JSON.stringify(x));

function renderWheelsTab(el) {
  if (!wheelDirty || !wheelDraft) wheelDraft = clone(A.wheels);
  if (wheelSel >= wheelDraft.length) wheelSel = Math.max(0, wheelDraft.length - 1);
  const w = wheelDraft[wheelSel];
  const soundOpts = (cur) => `<option value="">(kein Sound)</option>` + A.wheelSounds.map((f) => `<option ${f === cur ? 'selected' : ''}>${esc(f)}</option>`).join('');
  const active = S.customWheel;

  const list = wheelDraft.map((x, i) => `
    <li class="wrow ${i === wheelSel ? 'sel' : ''}" data-wsel="${i}">
      <span><b>${esc(x.name || 'Ohne Namen')}</b><br><small class="muted">${x.segments === 'players' ? 'Spielernamen' : `${(x.segments || []).length} Felder`}${x.sound ? ' · ♪' : ''}</small></span>
      <button class="btn small ${active?.id === x.id ? '' : 'primary'}" data-wshow="${esc(x.id || '')}" ${wheelDirty || !x.id || active?.state === 'spinning' ? 'disabled' : ''} title="Am TV und auf den Handys anzeigen – gedreht wird erst mit „Drehen“">${active?.id === x.id ? 'Wird gezeigt' : 'Anzeigen'}</button>
    </li>`).join('');

  const editor = w ? `
    <label class="field"><span>Name</span><input data-wf="name" value="${esc(w.name)}" maxlength="60"></label>
    <label class="check"><input type="checkbox" data-wf="players" ${w.segments === 'players' ? 'checked' : ''}> Felder = aktuelle Spielernamen</label>
    ${w.segments === 'players' ? '' : `<label class="field"><span>Felder (eins pro Zeile, 2–30)</span><textarea data-wf="segments" rows="8">${esc((w.segments || []).join('\n'))}</textarea></label>`}
    <div class="cols3">
      <label class="field"><span>Dauer (Sekunden)</span><input data-wf="duration" type="number" min="1" max="30" step="0.5" value="${(w.durationMs || 5000) / 1000}"></label>
      <label class="field"><span>Dreh-Sound (optional)</span><select data-wf="sound">${soundOpts(w.sound)}</select></label>
      <label class="field"><span>Ergebnis-Sound (optional)</span><select data-wf="endSound">${soundOpts(w.endSound)}</select></label>
    </div>
    <div class="row"><button class="btn danger small" id="wDel">Rad löschen</button></div>` : '<p class="muted">Noch kein Rad angelegt.</p>';

  el.innerHTML = `
    <div class="cols">
      <div class="panel">
        <div class="row between"><h2>Räder</h2><button class="btn small" id="wAdd">+ Neues Rad</button></div>
        <ul class="wlist">${list}</ul>
        ${active ? `<div class="activew row">${activeWheelHtml(active)}</div>` : '<p class="muted small">„Anzeigen“ zeigt das Rad am TV und auf allen Handys. Gedreht wird erst, wenn du auf „Drehen“ klickst (hier oder am TV).</p>'}
        <p class="muted small">Gespeichert in <code>${esc(A.wheelFile)}</code>. Sounds (mp3, ogg …) einfach in denselben Ordner legen und „Dateien neu einlesen“ drücken.</p>
        <button class="btn small" data-act="admin:rescanFiles">Dateien neu einlesen</button>
      </div>
      <div class="panel">
        <h2>Bearbeiten</h2>
        ${editor}
        <div class="row savebar ${wheelDirty ? 'dirty' : ''}">
          <button class="btn primary" id="wSave" ${wheelDirty ? '' : 'disabled'}>Speichern</button>
          <button class="btn ghost" id="wDiscard" ${wheelDirty ? '' : 'disabled'}>Verwerfen</button>
          ${wheelDirty ? '<span class="muted small">Ungespeicherte Änderungen – zum Anzeigen erst speichern.</span>' : ''}
        </div>
      </div>
    </div>`;
}

$('#tab-wheels').addEventListener('input', (e) => {
  const f = e.target.dataset.wf;
  if (!f) return;
  const w = wheelDraft[wheelSel];
  if (f === 'name') w.name = e.target.value;
  if (f === 'segments') w.segments = e.target.value.split('\n');
  if (f === 'duration') w.durationMs = Math.round(Number(e.target.value) * 1000);
  if (f === 'sound' || f === 'endSound') w[f] = e.target.value || null;
  if (f === 'players') { w.segments = e.target.checked ? 'players' : []; }
  wheelDirty = true;
  if (f === 'players' || e.target.tagName === 'SELECT') { e.target.blur(); render(); return; }
  // Beim Tippen nur die Speichern-Leiste aktualisieren, das Feld behält den Fokus
  $('#wSave').disabled = false;
  $('#wDiscard').disabled = false;
  $('.savebar').classList.add('dirty');
  const row = document.querySelector(`[data-wsel="${wheelSel}"] b`);
  if (row && f === 'name') row.textContent = w.name || 'Ohne Namen';
});

$('#tab-wheels').addEventListener('click', async (e) => {
  const show = e.target.closest('[data-wshow]');
  if (show) { act('admin:wheelShow', { id: show.dataset.wshow }); return; }
  const row = e.target.closest('[data-wsel]');
  if (row) { wheelSel = Number(row.dataset.wsel); return render(); }
  if (e.target.id === 'wAdd') {
    wheelDraft.push({ id: '', name: 'Neues Rad', segments: ['Feld 1', 'Feld 2'], durationMs: 5000, sound: null, endSound: null });
    wheelSel = wheelDraft.length - 1; wheelDirty = true; render();
  }
  if (e.target.id === 'wDel' && confirm(`Rad „${wheelDraft[wheelSel].name}“ löschen?`)) {
    wheelDraft.splice(wheelSel, 1); wheelDirty = true; render();
  }
  if (e.target.id === 'wDiscard') { wheelDirty = false; render(); }
  if (e.target.id === 'wSave') {
    const payload = wheelDraft.map((w) => ({ ...w, segments: w.segments === 'players' ? 'players' : (w.segments || []).map((x) => x.trim()).filter(Boolean) }));
    const r = await act('admin:wheelsSave', { wheels: payload }, 'Räder gespeichert');
    if (r.ok) { wheelDirty = false; render(); }
  }
});

// ---------------------------------------------------------------------------
// Tab: Einstellungen
// ---------------------------------------------------------------------------
function musicStatusHtml() {
  const c = S.config.music, st = S.musicStatus || { state: 'off' };
  if (c.track === 'none') return '';
  const label = {
    playing: '<span class="ok">● Läuft am TV</span>',
    stopped: '<span class="muted">■ Gestoppt</span>',
    blocked: '<span class="err">Der TV-Browser blockiert den Ton – einmal auf den TV klicken (oder „♪ Musik starten“ dort).</span>',
    error: `<span class="err">${esc(st.error || 'Fehler beim Abspielen')}</span>`,
    off: '<span class="muted">Kein TV verbunden</span>',
  }[st.state] || '';
  return `<div class="row"><button class="btn small ${c.playing ? '' : 'primary'}" data-act="host:config" data-payload='{"music":{"playing":${!c.playing}}}'>${c.playing ? '⏸ Stopp' : '▶ Abspielen'}</button> ${label}</div>`;
}

function renderSettingsTab(el) {
  const c = S.config, lobby = S.phase === 'lobby', t = S.tunnel;
  const music = [{ id: 'none', name: 'Keine Musik' }, ...S.musicTracks].map((m) => `<option value="${esc(m.id)}" ${m.id === c.music.track ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  el.innerHTML = `
    <div class="cols">
      <div class="panel">
        <h2>Spiel</h2>
        <div class="field"><span>Joker pro Spieler ${lobby ? '' : '<small class="muted">nur in der Lobby – im Spiel unter „Spieler“ anpassen</small>'}</span>
          <div class="cols3">${Object.entries(JOKERS).map(([k, label]) => `<label class="field"><span class="small">${label}</span><input type="number" min="0" max="9" data-juse="${k}" value="${c.jokerUses[k]}" ${lobby ? '' : 'disabled'}></label>`).join('')}</div></div>
        <label class="field"><span>Spieler (max.) ${lobby ? '' : '<small class="muted">nur in der Lobby</small>'}</span><input type="number" id="sPlayers" min="${S.rules.minPlayers}" max="${S.rules.maxPlayers}" value="${c.maxPlayers}" ${lobby ? '' : 'disabled'}></label>
        <label class="field"><span>Runden ${lobby ? '' : '<small class="muted">nur in der Lobby</small>'}</span><input type="number" id="sRows" min="${S.rules.minRows}" max="${S.rules.maxRows}" value="${c.rows}" ${lobby ? '' : 'disabled'}></label>
        <label class="field"><span>Mindest-Erhöhung (Mio) <small class="muted">– um so viel muss ein Gebot das Höchstgebot mindestens übersteigen, jederzeit änderbar</small></span><input type="number" min="1" max="1000" step="1" id="sMinRaise" value="${c.minRaise}"></label>
        <div class="field"><span>Rundengeld <small class="muted">– zufällig zwischen Minimum und Maximum, in ganzen Mio (nach der letzten Runde gibt's keins)</small></span>
          <div class="row"><label class="field"><span class="small">Minimum (Mio)</span><input type="number" step="1" id="sPayoutMin" value="${c.payoutMin}"></label>
          <label class="field"><span class="small">Maximum (Mio)</span><input type="number" step="1" id="sPayoutMax" value="${c.payoutMax}"></label></div></div>
        <h2>Spiel steuern</h2>
        <div class="row">
          <button class="btn danger" data-act="host:reset" data-payload='{"keepPlayers":true}' data-confirm="Spiel abbrechen und mit denselben Spielern zurück in die Lobby?">Neu starten (gleiche Spieler)</button>
          <button class="btn danger" data-act="host:reset" data-payload='{"keepPlayers":false}' data-confirm="Spiel abbrechen und alle Spieler entfernen?">Zur Lobby (alle raus)</button>
        </div>
      </div>
      <div class="panel">
        <h2>TV</h2>
        <label class="field"><span>Hintergrundmusik <small class="muted">(Dateien in <code>music/</code>)</small></span>
          <div class="row"><select id="sMusic">${music}</select><input type="range" id="sVolume" min="0" max="1" step="0.05" value="${c.music.volume}"></div></label>
        ${musicStatusHtml()}
        ${S.musicTracks.length ? '' : '<p class="muted small">Keine Musik gefunden. Lege mp3/ogg/m4a-Dateien in den Ordner <code>music/</code> und lies die Dateien neu ein.</p>'}
        <label class="field"><span>Hintergrundfarbe</span><input type="color" id="sColor" value="${c.bgColor}"></label>
        <button class="btn small" data-act="${lobby ? 'host:rescan' : 'admin:rescanFiles'}">${lobby ? 'Charakter, Musik & Räder neu einlesen' : 'Musik & Räder neu einlesen'}</button>
        <h2>Internet-Zugang</h2>
        <p>${t.status === 'on' ? `<span class="ok">● Online:</span> ${esc(S.joinUrl)}` : t.status === 'error' ? `<span class="err">${esc(t.error)}</span>` : t.status === 'starting' ? 'Verbinde …' : 'Nur im WLAN.'}</p>
        <button class="btn small" data-act="host:tunnel" data-payload='{"enabled":${t.status !== 'on'}}' ${t.status === 'starting' ? 'disabled' : ''}>${t.status === 'on' ? 'ngrok ausschalten' : 'ngrok einschalten'}</button>
      </div>
    </div>`;
}

$('#tab-settings').addEventListener('change', (e) => {
  const id = e.target.id;
  if (id === 'sPlayers') act('host:config', { maxPlayers: Number(e.target.value) }, 'Gespeichert');
  if (id === 'sRows') act('host:config', { rows: Number(e.target.value) }, 'Gespeichert');
  if (id === 'sMinRaise') act('host:config', { minRaise: Number(e.target.value) }, 'Mindest-Erhöhung gespeichert');
  if (id === 'sPayoutMin') act('host:config', { payoutMin: Number(e.target.value) }, 'Rundengeld gespeichert');
  if (id === 'sPayoutMax') act('host:config', { payoutMax: Number(e.target.value) }, 'Rundengeld gespeichert');
  if (id === 'sMusic') act('host:config', { music: { track: e.target.value } });
  if (id === 'sVolume') act('host:config', { music: { volume: Number(e.target.value) } });
  if (id === 'sColor') act('host:config', { bgColor: e.target.value });
  if (e.target.dataset.juse) act('host:config', { jokerUses: { [e.target.dataset.juse]: Number(e.target.value) } }, 'Gespeichert');
});
