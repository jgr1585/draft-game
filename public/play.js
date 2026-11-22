'use strict';

const TOKEN_KEY = 'charakter-auktion-token';
const socket = io();
let S = null;
let meId = null;
let photoData = null;
let jokerOpen = null;   // 'block' | 'swap' | null
let swapRow = null;
const peeks = [];   // eigene Spick-Ergebnisse (nur dieses Handy)
let lastBidKey = null;

socket.on('connect', async () => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    const r = await emit(socket, 'player:resume', { token });
    if (r.ok) meId = r.playerId;
    else { localStorage.removeItem(TOKEN_KEY); meId = null; }
  }
  render();
});
socket.on('disconnect', () => toast('Verbindung verloren – verbinde neu …'));
socket.on('kicked', () => {
  localStorage.removeItem(TOKEN_KEY);
  meId = null;
  toast('Du wurdest aus der Lobby entfernt.');
  render();
});
socket.on('state', (s) => { checkBuild(s); S = s; render(); });

async function act(event, payload) {
  const r = await emit(socket, event, payload);
  if (!r.ok) toast(r.error);
  return r;
}

const me = () => S?.players.find((p) => p.id === meId);

// ---------------------------------------------------------------------------
function render() {
  if (!S) return;
  const p = me();
  $('#joinView').hidden = !!p;
  $('#waitView').hidden = !p || S.phase !== 'lobby';
  $('#gameView').hidden = !p || S.phase === 'lobby';
  if (!p) return renderJoin();
  renderWheelBanner();
  if (S.phase === 'lobby') return renderWait(p);
  renderGame(p);
}

function countUp(el, to, ms) {
  const t0 = performance.now();
  const step = (now) => {
    const t = ms ? Math.min(1, (now - t0) / ms) : 1;
    el.textContent = fmtSigned(Math.round(to * (1 - Math.pow(1 - t, 3))));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Eigene Glücksräder laufen am TV – am Handy nur Hinweis und Ergebnis
function renderWheelBanner() {
  const w = S.customWheel;
  const el = $('#wheelBanner');
  el.hidden = !w;
  if (!w) return;
  if (w.state === 'ready') {
    el.innerHTML = `<b>${esc(w.name)}</b> · gleich wird am TV gedreht
      <div class="wfields">${w.labels.map((l) => `<span>${esc(l)}</span>`).join('')}</div>`;
  } else if (w.state === 'spinning') el.innerHTML = `<b>${esc(w.name)}</b> · das Rad dreht sich am TV …`;
  else el.innerHTML = `<b>${esc(w.name)}</b> · Ergebnis: <b class="res">${esc(w.result)}</b>`;
}

function headerHtml(p) {
  return `${avatarHtml(p)}<div><div class="name">${esc(p.name)}</div><div class="money">${fmt(p.money)}</div></div>`;
}

function renderJoin() {
  const full = S.players.length >= S.config.maxPlayers;
  let note = `${S.players.length} / ${S.config.maxPlayers} Spieler in der Lobby`;
  if (S.phase !== 'lobby') note = 'Das Spiel läuft schon. Warte auf die nächste Runde.';
  else if (full) note = 'Die Lobby ist voll.';
  $('#joinNote').textContent = note;
}

function renderWait(p) {
  $('#meHeaderWait').innerHTML = headerHtml(p);
  $('#waitText').textContent = `${S.players.length} / ${S.config.maxPlayers} Spieler · Der Gamemaster startet gleich.`;
  $('#waitPlayers').innerHTML = S.players.map((x) => `<span class="chipP">${avatarHtml(x, 'avatar sm')}${esc(x.name)}</span>`).join('');
}

// ---------------------------------------------------------------------------
function renderGame(p) {
  $('#meHeader').innerHTML = headerHtml(p);
  const c = S.current;
  const byId = Object.fromEntries(S.players.map((x) => [x.id, x]));
  const myCell = S.grid[S.round] && S.grid[S.round][p.column];
  const box = $('#phaseBox');
  if (S.phase !== 'payout') box.dataset.payout = '';
  const bidBox = $('#bidBox');
  bidBox.hidden = true;

  if (S.phase === 'auction' && c) {
    const ch = c.char;
    const top = c.highest && byId[c.highest.playerId];
    const minNext = c.highest ? c.highest.amount + 1e6 : ch.value;
    let status, statusCls = '';
    let canBid = false;

    if (myCell) status = `Du hast deinen Charakter für Runde ${S.round + 1}: <b>${esc(myCell.char?.name)}</b>. Warte, bis alle einen haben.`;
    else if (c.blocked.includes(p.id)) { status = 'Du wurdest für diesen Charakter gesperrt.'; statusCls = 'warn'; }
    else if (c.withdrawn.includes(p.id)) status = 'Du bist ausgestiegen.';
    else if (top && top.id === p.id) { status = `Du bietest am höchsten: <b>${fmt(c.highest.amount)}</b>`; statusCls = 'hot'; }
    else {
      canBid = true;
      if (!c.revealed) status = '<b>Verdeckt!</b> Du kannst schon vorab bieten. ';
      else status = '';
      status += top
        ? `Höchstgebot: <b>${fmt(c.highest.amount)}</b> von ${esc(top.name)}`
        : `Noch kein Gebot · Mindestens <b>${fmt(ch.value)}</b>`;
      if (minNext > p.money) { status += '<br>Du hast nicht genug Kohle zum Überbieten.'; statusCls = 'warn'; }
    }

    box.innerHTML = `
      <div class="roundbar">Runde ${S.round + 1} · Kategorie <span class="cat">${esc(S.roundCategory || 'Gemischt')}</span></div>
      <div class="panel">
        <div class="charcard">
          ${c.revealed ? `<img src="${esc(ch.image)}" alt="">` : '<div class="covered">?</div>'}
          <div>
            <div class="cname">${c.revealed ? esc(ch.name) : '<span class="muted">Noch verdeckt</span>'}</div>
            <span class="cat">${esc(ch.category)}</span>
            <div class="muted">Startwert ${fmt(ch.value)}</div>
          </div>
        </div>
        <div class="status ${statusCls}">${status}</div>
      </div>`;

    const canVote = !myCell && !c.blocked.includes(p.id);
    if (canVote) {
      bidBox.hidden = false;
      const key = `${c.seq}|${c.highest?.amount ?? 0}`;
      const input = $('#bidInput');
      if (key !== lastBidKey && document.activeElement !== input) input.value = toMio(Math.min(minNext, Math.max(p.money, minNext)));
      lastBidKey = key;
      $('#bidBtn').disabled = !canBid || minNext > p.money;
      bidBox.querySelectorAll('.quick button').forEach((b) => (b.disabled = !canBid));
      $('#withdrawBtn').disabled = !canBid;
      const voted = c.skips.includes(p.id);
      const skipBtn = $('#skipBtn');
      skipBtn.textContent = `${voted ? 'Skip zurücknehmen' : 'Skippen'} (${c.skips.length}/${c.skipNeeded})`;
      skipBtn.classList.toggle('on', voted);
    }
  } else if (S.phase === 'prepare') {
    box.innerHTML = `<div class="panel center"><h2>Runde ${S.round + 1}</h2>
      <div>Kategorie <span class="cat">${esc(S.roundCategory || 'Gemischt')}</span></div>
      <div class="muted">Gleich geht's los – der Gamemaster bereitet die Runde vor.</div></div>`;
  } else if (S.phase === 'payout' && S.payout) {
    const key = String(S.payout.t);
    if (box.dataset.payout !== key) {
      const mine = S.payout.results.find((r) => r.playerId === p.id);
      box.innerHTML = `<div class="panel center payout"><h2>Rundengeld</h2>
        <div class="pamt ${mine && mine.amount < 0 ? 'neg' : ''}">+0</div>
        <div class="muted">Gleich geht's weiter mit der nächsten Runde.</div></div>`;
      box.dataset.payout = key;
      if (mine) countUp($('.pamt', box), mine.amount, Date.now() - S.payout.t < 8000 ? 1800 : 0);
    }
    renderTrades(p);
    renderJokers(p, byId);
    renderMyGrid(p);
    return;
  } else if (S.phase === 'finished') {
    box.innerHTML = `<div class="panel center"><h2>Raster voll!</h2><div class="muted">Jetzt wird diskutiert, wer gewonnen hat.${p.jokers.swap > 0 ? '<br>Deinen Tausch-Joker kannst du noch einsetzen.' : ''}</div></div>`;
  }

  renderTrades(p);
  renderJokers(p, byId);
  renderMyGrid(p);
}

const toMio = (n) => +(n / 1e6).toFixed(1);

// ---------------------------------------------------------------------------
function renderJokers(p, byId) {
  const box = $('#jokerBox');
  const fin = S.phase === 'finished';   // nach dem Spiel geht nur noch Tausch
  if (fin && jokerOpen && jokerOpen !== 'swap') jokerOpen = null;
  const c = S.current;
  const inAuction = S.phase === 'auction' && c;

  // Sperre: Ziele = Spieler, die noch mitbieten können
  const blockTargets = inAuction && !c.highest
    ? S.players.filter((x) => x.id !== p.id && c.need.includes(x.id) && !c.blocked.includes(x.id))
    : [];

  // Tausch: Runden, in denen ich und mindestens ein anderer einen Charakter haben
  const swapRows = S.grid
    .map((row, r) => ({ r, mine: row[p.column], others: S.players.filter((x) => x.id !== p.id && row[x.column]) }))
    .filter((x) => x.mine && x.others.length);

  const myOffer = S.trades.find((t) => t.fromId === p.id);
  const peekCount = S.peek.count;

  const card = (type, title, desc, enabled, extra = '') => {
    const left = p.jokers[type] || 0;
    if (!left && !S.config.jokerUses[type]) return '';   // Joker in diesem Spiel abgeschaltet
    return `
    <div class="joker ${left ? '' : 'used'}">
      <div><div class="t">${title} <span class="cnt">${left}×</span></div><div class="d">${left ? desc : 'verbraucht'}</div></div>
      <button class="btn small ${jokerOpen === type ? 'on' : ''}" data-joker="${type}" ${!left || !enabled ? 'disabled' : ''}>
        ${type === 'monster' ? 'Einsetzen' : jokerOpen === type ? 'Abbrechen' : 'Wählen'}
      </button>
    </div>${extra}`;
  };

  let blockPicker = '';
  if (jokerOpen === 'block') {
    blockPicker = `<div class="picker">${blockTargets.map((x) => `<button class="btn" data-block="${x.id}">${esc(x.name)}</button>`).join('') || '<span class="muted">Niemand sperrbar</span>'}</div>`;
  }
  let swapPicker = '';
  if (jokerOpen === 'swap') {
    const sel = swapRows.find((x) => x.r === swapRow);
    swapPicker = `<div class="picker">${swapRows.map((x) => `<button class="btn ${x.r === swapRow ? 'on' : ''}" data-row="${x.r}">Runde ${x.r + 1}</button>`).join('')}</div>`;
    if (sel) {
      swapPicker += `<div class="picker">${sel.others.map((x) => {
        const cell = S.grid[sel.r][x.column];
        return `<button class="btn" data-swap="${x.id}">${esc(x.name)}: ${esc(cell.char?.name)}</button>`;
      }).join('')}</div>`;
    }
  }
  let peekPicker = '';
  if (jokerOpen === 'peek') {
    const label = (i) => (i === 0 && S.peek.currentHidden ? 'Aktueller' : `Nr. ${i + 1}`);
    peekPicker = `<div class="hint">Welche Position im Stapel dieser Runde willst du sehen?${S.peek.currentHidden ? ' Nr. 1 ist der Charakter, der gerade verdeckt versteigert wird.' : ' Nr. 1 kommt als Nächstes dran.'}</div>
      <div class="picker">${Array.from({ length: peekCount }, (_, i) => `<button class="btn" data-peek="${i + 1}">${label(i)}</button>`).join('')}</div>`;
  }
  const peekList = peeks.length ? `<div class="peeks"><div class="muted small">Gespickt:</div>${peeks.slice().reverse().map((k) => `
    <div class="peekrow"><img src="${esc(k.image)}" alt=""><span><b>${esc(k.name)}</b> <span class="cat">${esc(k.category)}</span><br>
      <span class="muted small">Runde ${k.round + 1} · Position ${k.position} (zu dem Zeitpunkt) · ${fmt(k.value)}</span></span></div>`).join('')}</div>` : '';

  const swapCard = card('swap', 'Tausch', myOffer ? 'Du wartest noch auf eine Antwort' : `Tausch in derselben Runde anbieten – der andere muss zustimmen${fin ? ' · geht auch nach dem Spiel' : ''}`, swapRows.length > 0 && !myOffer, swapPicker);
  if (fin) {
    box.hidden = !swapCard;
    box.innerHTML = swapCard ? `<h3>Joker</h3>${swapCard}` : '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `<h3>Joker</h3>` +
    card('monster', 'Weißes Monster', `+${fmt(S.rules.monsterBonus)} · nur solange der Charakter verdeckt ist`, inAuction && !c.revealed) +
    card('block', 'Sperre', inAuction && c.highest ? 'Geht nicht mehr – es wurde schon geboten' : 'Einen Spieler für diesen Charakter sperren · nur vor dem ersten Gebot', blockTargets.length > 0, blockPicker) +
    swapCard +
    card('peek', 'Spicken', 'Heimlich einen Charakter dieser Runde ansehen – du wählst die Position', peekCount > 0, peekPicker) +
    peekList;
}

// Offene Tauschangebote: eingehende annehmen/ablehnen, eigenes zurückziehen
function renderTrades(p) {
  const box = $('#tradeBox');
  const byId = Object.fromEntries(S.players.map((x) => [x.id, x]));
  const cellName = (pl, r) => S.grid[r]?.[pl?.column]?.char?.name || '?';
  const incoming = S.trades.filter((t) => t.toId === p.id).map((t) => {
    const from = byId[t.fromId];
    return `<div class="trade in">
      <div><b>${esc(from?.name)}</b> möchte in Runde ${t.row + 1} tauschen:<br>
        du gibst <b>${esc(cellName(p, t.row))}</b> und bekommst <b>${esc(cellName(from, t.row))}</b></div>
      <div class="two"><button class="btn primary" data-trade="${t.id}" data-accept="1">Annehmen</button><button class="btn" data-trade="${t.id}" data-accept="0">Ablehnen</button></div>
    </div>`;
  });
  const outgoing = S.trades.filter((t) => t.fromId === p.id).map((t) => {
    const to = byId[t.toId];
    return `<div class="trade out">
      <div>Dein Tauschangebot an <b>${esc(to?.name)}</b> (Runde ${t.row + 1}: ${esc(cellName(p, t.row))} ⇄ ${esc(cellName(to, t.row))}) – warte auf Antwort …</div>
      <button class="btn small" data-tradecancel="${t.id}">Zurückziehen</button>
    </div>`;
  });
  box.innerHTML = [...incoming, ...outgoing].join('');
  box.hidden = !incoming.length && !outgoing.length;
}

function renderMyGrid(p) {
  const rows = S.grid.map((row, r) => {
    const cell = row[p.column];
    const rc = S.roundCategories[r];
    return `<div class="mrow"><span class="n">${r + 1}</span>${cell
      ? `<img src="${esc(cell.char?.image)}" alt=""><span>${esc(cell.char?.name)} <span class="cat">${esc(cell.char?.category)}</span> <span class="muted">· ${fmt(cell.price)}</span></span>`
      : `<span class="empty"></span>${rc !== undefined ? `<span class="muted">${esc(rc || 'Gemischt')}</span>` : ''}`}</div>`;
  }).join('');
  $('#myGrid').innerHTML = `<h3>Dein Raster</h3><div class="rows">${rows}</div>`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
// Galerie (ohne capture) oder direkt die Frontkamera
document.querySelectorAll('.photoInput').forEach((input) => input.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    photoData = await resizeImage(file, 320, true);
    const img = $('#photoPreview');
    img.src = photoData;
    img.hidden = false;
    $('#photoHint').hidden = true;
  } catch (err) { toast(err.message); }
}));

$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await act('player:join', { name: $('#nameInput').value, avatar: photoData });
  if (r.ok) {
    localStorage.setItem(TOKEN_KEY, r.token);
    meId = r.playerId;
    render();
  }
});

$('#leaveBtn').addEventListener('click', async () => {
  const r = await act('player:leave');
  if (r.ok) { localStorage.removeItem(TOKEN_KEY); meId = null; render(); }
});

$('#bidBox').addEventListener('click', (e) => {
  const q = e.target.closest('[data-q]')?.dataset.q;
  if (!q) return;
  const p = me(), c = S.current;
  const minNext = c.highest ? c.highest.amount + 1e6 : c.char.value;
  const input = $('#bidInput');
  const cur = Math.max(Math.round(parseFloat(input.value) * 1e6) || 0, minNext);
  let val = cur;
  if (q === 'min') val = minNext;
  else if (q === 'all') val = p.money;
  else val = cur + Number(q) * 1e6;
  input.value = toMio(Math.min(val, p.money));
});

$('#bidBtn').addEventListener('click', async () => {
  const amount = Math.round(parseFloat($('#bidInput').value.replace(',', '.')) * 1e6);
  if (!Number.isFinite(amount)) return toast('Bitte einen Betrag eingeben.');
  const r = await act('bid', { amount });
  if (r.ok) { $('#bidInput').blur(); toast(`Geboten: ${fmt(amount)}`, 'ok'); }
});

$('#withdrawBtn').addEventListener('click', () => {
  if (confirm('Bei diesem Charakter aussteigen?')) act('withdraw');
});
$('#skipBtn').addEventListener('click', () => act('skip'));

$('#jokerBox').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const p = me();
  if (b.dataset.joker === 'monster') {
    if (confirm(`Weißes Monster einsetzen? +${fmt(S.rules.monsterBonus)}`)) {
      const r = await act('joker', { type: 'monster' });
      if (r.ok) toast(`+${fmt(S.rules.monsterBonus)}!`, 'ok');
    }
    return;
  }
  if (b.dataset.joker) {
    jokerOpen = jokerOpen === b.dataset.joker ? null : b.dataset.joker;
    swapRow = null;
    return render();
  }
  if (b.dataset.block) {
    const t = S.players.find((x) => x.id === b.dataset.block);
    if (!confirm(`${t.name} für ${S.current.char.name || 'den verdeckten Charakter'} sperren?`)) return;
    const r = await act('joker', { type: 'block', targetId: t.id });
    if (r.ok) { jokerOpen = null; toast(`${t.name} gesperrt`, 'ok'); }
    return render();
  }
  if (b.dataset.row !== undefined) { swapRow = Number(b.dataset.row); return render(); }
  if (b.dataset.swap) {
    const t = S.players.find((x) => x.id === b.dataset.swap);
    const mine = S.grid[swapRow][p.column], theirs = S.grid[swapRow][t.column];
    if (!confirm(`${mine.char?.name} gegen ${theirs.char?.name} von ${t.name} tauschen?`)) return;
    const r = await act('joker', { type: 'swap', targetId: t.id, row: swapRow });
    if (r.ok) { jokerOpen = null; swapRow = null; toast(`Angebot an ${t.name} geschickt – warte auf Antwort`, 'ok'); }
    render();
  }
  if (b.dataset.peek) {
    const pos = Number(b.dataset.peek);
    if (!confirm(`Spicken-Joker einsetzen und Position ${pos} ansehen?`)) return;
    const r = await act('joker', { type: 'peek', position: pos });
    if (r.ok) {
      peeks.push(r.peek);
      jokerOpen = null;
      showPeek(r.peek);
    }
    render();
  }
});

function showPeek(k) {
  const el = $('#peekModal');
  el.innerHTML = `<div class="panel center">
    <div class="muted">Spicken · Runde ${k.round + 1} · Position ${k.position}</div>
    <img src="${esc(k.image)}" alt="">
    <h2>${esc(k.name)}</h2>
    <div><span class="cat">${esc(k.category)}</span> · Startwert ${fmt(k.value)}</div>
    <p class="muted small">Nur du siehst das. Die Reihenfolge kann sich noch ändern (z. B. durch Skippen).</p>
    <button class="btn primary big" id="peekClose">Verstanden</button></div>`;
  el.hidden = false;
}
$('#peekModal').addEventListener('click', (e) => { if (e.target.id === 'peekClose' || e.target.id === 'peekModal') $('#peekModal').hidden = true; });

$('#tradeBox').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.trade) {
    const accept = b.dataset.accept === '1';
    if (accept && !confirm('Tausch annehmen?')) return;
    const r = await act('trade:respond', { id: b.dataset.trade, accept });
    if (r.ok) toast(r.stale ? 'Der Tausch geht nicht mehr.' : accept ? 'Getauscht!' : 'Abgelehnt', r.stale ? 'error' : 'ok');
  }
  if (b.dataset.tradecancel) act('trade:cancel', { id: b.dataset.tradecancel });
});
