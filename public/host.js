'use strict';

const socket = io();
const params = new URLSearchParams(location.search);
let S = null;
let isHost = false;
let lastRevealSeq = null;

socket.on('connect', async () => {
  const r = await emit(socket, 'host:hello', { key: params.get('key') });
  isHost = r.ok;
  const fatal = $('#fatal');
  fatal.hidden = r.ok;
  if (!r.ok) fatal.textContent = r.error;
  render();
});
socket.on('disconnect', () => toast('Verbindung zum Server verloren …'));
socket.on('state', (s) => { checkBuild(s); S = s; render(); });

async function act(event, payload) {
  const r = await emit(socket, event, payload);
  if (!r.ok) toast(r.error);
  return r;
}

const JOKER_LABEL = { monster: 'Weißes Monster', block: 'Sperre', swap: 'Tausch', peek: 'Spicken' };
// Joker als Spiel-Items (Plättchen mit Symbol) statt Text
const JOKER_ICON = {
  monster: '<path d="M6 21V11a6 6 0 0 1 12 0v10l-2-1.6-2 1.6-2-1.6-2 1.6-2-1.6z" fill="#fff"/><path d="M7.5 6.5 6 3.5M16.5 6.5 18 3.5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="9.5" cy="11" r="1.6" fill="#2b2160"/><circle cx="14.5" cy="11" r="1.6" fill="#2b2160"/><path d="M9.5 15q2.5 2 5 0" stroke="#2b2160" stroke-width="1.4" fill="none" stroke-linecap="round"/>',
  block: '<rect x="5" y="10.5" width="14" height="10" rx="2.2" fill="#fff"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="#fff" stroke-width="2.2" fill="none"/><circle cx="12" cy="15" r="1.6" fill="#7a1d2b"/><path d="M12 15v2.6" stroke="#7a1d2b" stroke-width="1.6" stroke-linecap="round"/>',
  swap: '<path d="M4 8.5h13M13.5 4.5l4 4-4 4M20 15.5H7M10.5 11.5l-4 4 4 4" stroke="#fff" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  peek: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="#fff"/><circle cx="12" cy="12" r="3.6" fill="#0d4a52"/><circle cx="13.2" cy="10.8" r="1.1" fill="#fff"/>',
};
function jokerItem(type, uses) {
  return `<span class="jk jk-${type} ${uses > 0 ? '' : 'used'}" title="${JOKER_LABEL[type]}${uses > 0 ? ` – noch ${uses}×` : ' – aufgebraucht'}">
    <svg viewBox="0 0 24 24" aria-hidden="true">${JOKER_ICON[type]}</svg>${uses > 1 ? `<b>${uses}</b>` : ''}</span>`;
}

// ---------------------------------------------------------------------------
function render() {
  if (!S) return;
  const bg = $('#bg');
  bg.style.backgroundColor = S.config.bgColor;
  bg.style.backgroundImage = S.background ? `url("${S.background}")` : 'none';

  $('#lobby').hidden = S.phase !== 'lobby';
  $('#game').hidden = S.phase === 'lobby';
  if (S.phase === 'lobby') renderLobby();
  else renderGame();
  renderPayout();
  renderRoundIntro();
  renderCustomWheel();
  if (isHost) Music.apply(S.config.music.track, S.config.music.volume, S.config.music.playing, S.musicTracks);
  renderMusicToggles();
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
function setIfIdle(el, value) {
  if (document.activeElement !== el && el.value !== String(value)) el.value = value;
}

function renderLobby() {
  const c = S.config;
  setIfIdle($('#cfgPlayers'), c.maxPlayers);
  setIfIdle($('#cfgRows'), c.rows);
  setIfIdle($('#cfgColor'), c.bgColor);
  setIfIdle($('#cfgMinRaise'), c.minRaise);
  setIfIdle($('#cfgPayoutMin'), c.payoutMin);
  setIfIdle($('#cfgPayoutMax'), c.payoutMax);
  $('#outPlayers').textContent = c.maxPlayers;
  $('#outRows').textContent = c.rows;
  $('#gridSize').textContent = gridSizeText(c.maxPlayers, c.rows);
  renderMusicSelect($('#cfgMusic'));
  setIfIdle($('#cfgVolume'), c.music.volume);
  document.querySelectorAll('[data-juse]').forEach((el) => setIfIdle(el, c.jokerUses[el.dataset.juse]));
  $('#planPreview').innerHTML = c.categoryPlan.map((cat, r) =>
    `<span class="pr"><small>R${r + 1}</small>${esc(cat || 'Gemischt')}</span>`).join('');
  $('#charCount').textContent = `${S.characterCount} Charakter im Ordner`;
  $('#joinUrl').textContent = S.joinUrl;
  const qr = $('#qr');
  const qrSrc = qrUrl();
  if (qr.getAttribute('src') !== qrSrc) qr.setAttribute('src', qrSrc);
  renderTunnel();
  $('#lobbyCount').textContent = `${S.players.length} / ${c.maxPlayers}`;

  const cards = S.players.map((p) => `
    <div class="lp">
      <button class="btn small ghost kick" data-kick="${p.id}" title="Entfernen">✕</button>
      ${avatarHtml(p, 'avatar lg')}
      <b>${esc(p.name)}</b>
    </div>`);
  for (let i = S.players.length; i < c.maxPlayers; i++) cards.push('<div class="lp empty">frei</div>');
  $('#lobbyPlayers').innerHTML = cards.join('');

  const start = $('#startBtn');
  start.disabled = S.players.length < S.rules.minPlayers || !S.characterCount;
  start.textContent = S.players.length < S.rules.minPlayers
    ? `Warte auf Spieler (min. ${S.rules.minPlayers})`
    : `Spiel starten (${S.players.length} Spieler)`;
}

// QR-Bild hängt an der Beitritts-Adresse – so cacht es der Browser, bis sich die Adresse ändert (ngrok an/aus)
const qrUrl = () => `/api/qr?u=${encodeURIComponent(S.joinUrl)}`;

const gridSizeText = (players, rows) => `${players} Spieler × ${rows} Runden`;

function renderMusicSelect(sel) {
  const opts = [{ id: 'none', name: 'Keine Musik' }, ...S.musicTracks];
  const sig = opts.map((t) => t.id).join('|');
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = opts.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    sel.dataset.sig = sig;
  }
  if (document.activeElement !== sel) sel.value = S.config.music.track;
}

function renderTunnel() {
  const t = S.tunnel;
  const btn = $('#tunnelBtn');
  const status = $('#tunnelStatus');
  btn.disabled = t.status === 'starting';
  btn.textContent = t.status === 'on' ? 'Internet-Zugang ausschalten' : t.status === 'starting' ? 'Tunnel startet …' : 'Internet-Zugang (ngrok) einschalten';
  if (t.status === 'on') status.innerHTML = `<span class="ok">● Online</span> – der QR-Code funktioniert jetzt von überall.<br><span class="muted">Im WLAN geht auch: ${esc(S.lanJoinUrl)}</span>`;
  else if (t.status === 'error') status.innerHTML = `<span class="err">${esc(t.error)}</span>`;
  else status.textContent = t.status === 'starting' ? 'Verbinde mit ngrok …' : 'Nur im lokalen WLAN erreichbar.';
}

let cfgTimer;
$('#cfgPlayers').addEventListener('input', (e) => {
  $('#outPlayers').textContent = e.target.value;
  $('#gridSize').textContent = gridSizeText(e.target.value, $('#cfgRows').value);
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(() => act('host:config', { maxPlayers: +e.target.value }), 200);
});
$('#cfgRows').addEventListener('input', (e) => {
  $('#outRows').textContent = e.target.value;
  $('#gridSize').textContent = gridSizeText($('#cfgPlayers').value, e.target.value);
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(() => act('host:config', { rows: +e.target.value }), 200);
});
[['#cfgMinRaise', 'minRaise'], ['#cfgPayoutMin', 'payoutMin'], ['#cfgPayoutMax', 'payoutMax']].forEach(([sel, key]) => $(sel).addEventListener('change', async (e) => {
  const r = await act('host:config', { [key]: Number(e.target.value) });
  if (r.ok) toast('Gespeichert', 'ok');
  else e.target.value = S.config[key];
}));
document.querySelectorAll('[data-juse]').forEach((el) => el.addEventListener('change', async () => {
  const r = await act('host:config', { jokerUses: { [el.dataset.juse]: Number(el.value) } });
  if (!r.ok) el.value = S.config.jokerUses[el.dataset.juse];
}));
$('#cfgColor').addEventListener('change', (e) => act('host:config', { bgColor: e.target.value }));
$('#cfgBg').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const dataUrl = await resizeImage(file, 1920, false);
    await act('host:background', { dataUrl });
  } catch (err) { toast(err.message); }
});
$('#tunnelBtn').addEventListener('click', () => act('host:tunnel', { enabled: S.tunnel.status !== 'on' }));

// Musik: Auswahl wirkt sofort (der Klick zählt als Freigabe für den Ton)
function onMusicChange(e) {
  Music.unlock();
  act('host:config', { music: { track: e.target.value } });
}
let volTimer;
function onVolumeInput(e) {
  const volume = Number(e.target.value);
  Music.apply(Music.track, volume, S.config.music.playing, S.musicTracks);
  clearTimeout(volTimer);
  volTimer = setTimeout(() => act('host:config', { music: { volume } }), 150);
}
$('#cfgMusic').addEventListener('change', onMusicChange);
$('#cfgVolume').addEventListener('input', onVolumeInput);
Music.onBlocked = (b) => { $('#musicUnlock').hidden = !b; renderMusicToggles(); };
// Der TV meldet dem Server, ob die Musik wirklich läuft – das Einstellungsfenster zeigt es an
Music.onStatus = (st) => {
  if (st.state === 'error') toast(st.error);
  if (isHost) emit(socket, 'host:musicStatus', st);
  renderMusicToggles();
};
// Jeder Klick auf den TV gibt blockierten Ton frei
let justUnlocked = false;
document.addEventListener('pointerdown', () => { justUnlocked = Music.blocked; Music.unlock(); }, true);
$('#musicUnlock').addEventListener('click', () => {
  Music.unlock();
  if (S && !S.config.music.playing) act('host:config', { music: { playing: true } });
});

// Play/Stopp-Knöpfe (Lobby + Gamemaster-Leiste)
function renderMusicToggles() {
  if (!S) return;
  const on = S.config.music.track !== 'none';
  const playing = S.config.music.playing;
  document.querySelectorAll('[data-music-toggle]').forEach((b) => {
    b.hidden = !on || !isHost;
    b.textContent = !playing ? '▶ Abspielen' : Music.blocked ? '♪ Starten' : '⏸ Stopp';
    b.classList.toggle('on', playing && !Music.blocked);
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-music-toggle]')) return;
  if (justUnlocked) { justUnlocked = false; return; }   // dieser Klick hat den Ton gerade erst freigegeben
  act('host:config', { music: { playing: !S.config.music.playing } });
});

$('#bgClear').addEventListener('click', () => act('host:background', { dataUrl: null }));
$('#rescan').addEventListener('click', async () => {
  const r = await act('host:rescan');
  if (r.ok) toast(`${S.characterCount} Charakter gefunden`, 'ok');
});
$('#startBtn').addEventListener('click', () => {
  if (S.players.length < S.config.maxPlayers &&
      !confirm(`Erst ${S.players.length} von ${S.config.maxPlayers} Spielern da. Trotzdem starten? Das Raster wird ${gridSizeText(S.players.length, S.config.rows)}.`)) return;
  act('host:start');
});
$('#lobbyPlayers').addEventListener('click', (e) => {
  const id = e.target.closest('[data-kick]')?.dataset.kick;
  if (id) act('host:kick', { playerId: id });
});

// ---------------------------------------------------------------------------
// Spielansicht
// ---------------------------------------------------------------------------
function renderGame() {
  const c = S.current;
  const byId = Object.fromEntries(S.players.map((p) => [p.id, p]));
  const rowsTotal = S.grid.length;

  // ----- Spielerliste links
  $('#players').innerHTML = S.players.map((p) => {
    const hasRow = !!(S.grid[S.round] && S.grid[S.round][p.column]);
    let tag = '', cls = '';
    if (S.phase === 'auction' && c) {
      if (hasRow) { tag = 'Runde erledigt'; cls = 'done'; }
      else if (c.highest?.playerId === p.id) { tag = 'Höchstbietend'; cls = 'top'; }
      else if (c.blocked.includes(p.id)) { tag = 'Gesperrt'; cls = 'out'; }
      else if (c.withdrawn.includes(p.id)) { tag = 'Ausgestiegen'; cls = 'out'; }
      else if (c.skips.includes(p.id)) tag = 'will skippen';
      else tag = 'bietet mit';
    }
    const jokers = Object.keys(JOKER_LABEL).filter((k) => S.config.jokerUses[k] > 0 || p.jokers[k] > 0)
      .map((k) => jokerItem(k, p.jokers[k])).join('');
    return `
      <div class="pl ${cls}">
        ${p.connected ? '' : '<span class="off" title="offline"></span>'}
        ${avatarHtml(p)}
        <div class="info">
          <div class="name">${esc(p.name)}</div>
          <div class="money">${fmt(p.money)}</div>
          <div class="tag ${cls === 'top' ? 'hot' : ''}">${tag}</div>
          <div class="jokers">${jokers}</div>
        </div>
      </div>`;
  }).join('');

  // ----- Raster in der Mitte
  const catLabel = ['prepare', 'auction'].includes(S.phase) ? ` · Kategorie <span class="chip big">${esc(S.roundCategory || 'Gemischt')}</span>` : '';
  const rowLabel = S.phase === 'finished' ? 'Alle Runden voll' : `Runde <b>${S.round + 1}</b> von ${rowsTotal}${catLabel}`;
  const poolInfo = S.phase === 'auction' ? `Noch ${S.queueLeft} im Stapel · ${S.skippedCount} übersprungen` : '';
  $('#roundInfo').innerHTML = `<span>${rowLabel}</span><span class="muted">${poolInfo}</span>`;

  const grid = $('#grid');
  const finished = S.phase === 'finished';
  grid.style.gridTemplateColumns = `minmax(110px, 160px) repeat(${rowsTotal}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `44px repeat(${S.players.length}, minmax(0, 1fr))`;
  const fresh = S.lastAward && Date.now() - S.lastAward.t < 4000 ? S.lastAward : null;
  let html = '<div></div>';
  for (let r = 0; r < rowsTotal; r++) {
    const rc = S.roundCategories[r];
    const rcLabel = rc === undefined ? '' : esc(rc || 'Gemischt');
    html += `<div class="rl ${r === S.round && !finished ? 'cur' : ''}"><span>Runde ${r + 1}</span><small>${rcLabel}</small></div>`;
  }
  S.players.forEach((p) => {
    html += `<div class="gh">${avatarHtml(p, 'avatar sm')}<span>${esc(p.name)}</span></div>`;
    S.grid.forEach((row, r) => {
      const cell = row[p.column];
      const cur = r === S.round && !finished;
      if (!cell) { html += `<div class="cell ${cur ? 'cur' : ''}"></div>`; return; }
      const ch = cell.char || { name: '?', image: '', category: '' };
      const isFresh = fresh && fresh.charId === cell.charId && r === S.round;
      html += `<div class="cell ${isFresh ? 'fresh' : ''}" title="${esc(ch.name)} · ${esc(ch.category)}">
        <img src="${esc(ch.image)}" alt="">
        <span class="ccat">${esc(ch.category)}</span>
        <div class="cap"><b>${esc(ch.name)}</b>${fmt(cell.price)}</div>
      </div>`;
    });
  });
  grid.innerHTML = html;

  // ----- Spotlight rechts
  const spot = $('#spotlight');
  if (S.phase === 'auction' && c) {
    const ch = c.char;
    const top = c.highest && byId[c.highest.playerId];
    const justRevealed = c.revealed && lastRevealSeq !== c.seq;
    if (c.revealed) lastRevealSeq = c.seq;
    const media = c.revealed
      ? `<div class="spot-img ${justRevealed ? 'flip' : ''}"><img src="${esc(ch.image)}" alt=""></div>`
      : `<div class="spot-img covered"><div class="q">?</div><div class="cover-cat">${esc(ch.category)}</div><div class="muted">Wird gleich aufgedeckt …</div></div>`;
    spot.innerHTML = `
      ${media}
      <div class="catline"><span class="muted">Kategorie</span><span class="chip big">${esc(ch.category)}</span></div>
      <div class="spot-name">${c.revealed ? esc(ch.name) : '<span class="muted">Verdeckter Charakter</span>'}</div>
      <div class="kv"><span class="muted">Startwert</span><b>${fmt(ch.value)}</b></div>
      ${top ? `
        <div class="bidder">${avatarHtml(top)}<div><div class="muted">Höchstgebot · ${esc(top.name)}</div><div class="amt">${fmt(c.highest.amount)}</div><div class="nextbid">Nächstes Gebot ab ${fmt(c.highest.amount + S.config.minRaise * 1e6)}</div></div></div>`
      : `<div class="bidder"><div class="muted">${c.revealed ? 'Noch kein Gebot – jetzt am Handy bieten!' : 'Vorab-Gebote am Handy – Monster-Joker nur jetzt!'}</div></div>`}
      <div class="minirow">
        <span>Skippen: ${c.skips.length} / ${c.skipNeeded} nötig</span>
        <img class="miniqr" src="${qrUrl()}" alt="QR">
      </div>
      <div class="logbox">${S.log.slice(-3).reverse().map((l) => esc(l.msg)).join('<br>')}</div>`;
  } else if (S.phase === 'prepare') {
    spot.innerHTML = `<div class="finished">
      <div class="muted">Runde ${S.round + 1} von ${S.grid.length}</div>
      <div class="big">${esc(S.roundCategory || 'Gemischt')}</div>
      <div>Gleich geht's los – der Gamemaster mischt noch die Karten …</div>
      <img class="miniqr" src="${qrUrl()}" alt="QR">
    </div>`;
  } else if (S.phase === 'finished') {
    spot.innerHTML = `<div class="finished">
      <div class="big">Raster voll!</div>
      <div>Jetzt dürft ihr ausdiskutieren, wer das beste Team hat.</div>
    </div>`;
  } else {
    spot.innerHTML = `<div class="finished"><div class="big">Rundenende</div><div>Das Rundengeld wird verteilt …</div></div>`;
  }

  // ----- Gamemaster-Leiste
  const bar = $('#gmbar');
  if (!isHost) { bar.innerHTML = '<span class="lbl">Nur Anzeige</span>'; return; }
  const focused = bar.contains(document.activeElement) && document.activeElement.matches('select, input');
  if (focused) return;   // Musik-Auswahl nicht unter dem Cursor neu bauen
  if (S.phase === 'auction' && c) {
    const needers = c.need.map((id) => byId[id]).filter(Boolean);
    bar.innerHTML = `
      ${c.revealed
        ? `<button class="btn primary" data-act="host:hammer" ${c.highest ? '' : 'disabled'}>Zuschlag</button>`
        : '<button class="btn primary reveal" data-act="host:reveal">Charakter aufdecken</button>'}
      <button class="btn" data-act="host:skipChar">Charakter skippen</button>
      <span class="lbl">Verschenken an:</span>
      ${needers.map((p) => `<button class="btn small ghost" data-give="${p.id}">${esc(p.name)}</button>`).join('')}
      <span class="sep"></span>
      ${musicBarHtml()}
      <button class="btn small" data-open-admin>⚙ Einstellungen</button>
      <button class="btn small danger" data-reset="keep">Neu starten</button>
      <button class="btn small danger" data-reset="all">Zur Lobby</button>`;
  } else if (S.phase === 'prepare') {
    bar.innerHTML = `
      <button class="btn primary reveal" data-act="host:beginRound">Runde ${S.round + 1} starten</button>
      <button class="btn" data-open-admin>Stapel ordnen …</button>
      <span class="lbl">${S.queueLeft} Charakter im Stapel</span>
      <span class="sep"></span>
      ${musicBarHtml()}
      <button class="btn small" data-open-admin>⚙ Einstellungen</button>
      <button class="btn small danger" data-reset="keep">Neu starten</button>
      <button class="btn small danger" data-reset="all">Zur Lobby</button>`;
  } else {
    bar.innerHTML = `
      <span class="sep"></span>
      ${musicBarHtml()}
      <button class="btn small" data-open-admin>⚙ Einstellungen</button>
      <button class="btn" data-reset="keep">Neues Spiel (gleiche Spieler)</button>
      <button class="btn danger" data-reset="all">Zurück zur Lobby</button>`;
  }
  renderMusicSelect($('#barMusic'));
}

function musicBarHtml() {
  return `<span class="lbl">♪</span><select class="music-select small" id="barMusic"></select>
    <button class="btn small musicToggle" data-music-toggle hidden></button>
    <input type="range" class="vol" id="barVolume" min="0" max="1" step="0.05" value="${S.config.music.volume}" title="Lautstärke">`;
}
$('#gmbar').addEventListener('change', (e) => { if (e.target.id === 'barMusic') onMusicChange(e); });
$('#gmbar').addEventListener('input', (e) => { if (e.target.id === 'barVolume') onVolumeInput(e); });

// Einstellungsfenster als eigenes Popup (übernimmt ?key=, falls vorhanden)
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-open-admin]')) return;
  const win = window.open(`/admin${location.search}`, 'auktion-admin', 'popup,width=1250,height=900');
  if (!win) toast('Popup blockiert – bitte Popups für diese Seite erlauben.');
  else win.focus();
});

$('#gmbar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act) act(b.dataset.act);
  if (b.dataset.give) {
    const p = S.players.find((x) => x.id === b.dataset.give);
    if (confirm(`${S.current.char.name || 'Den verdeckten Charakter'} gratis an ${p.name} geben?`)) act('host:giveChar', { playerId: p.id });
  }
  if (b.dataset.reset === 'keep' && confirm('Spiel abbrechen und mit denselben Spielern neu in der Lobby starten?')) act('host:reset', { keepPlayers: true });
  if (b.dataset.reset === 'all' && confirm('Spiel abbrechen und alle Spieler entfernen?')) act('host:reset', { keepPlayers: false });
});

// ---------------------------------------------------------------------------
// Glücksräder
// ---------------------------------------------------------------------------
const COLORS = ['#ff6b6b', '#ffcc33', '#5be3a0', '#7ad1ff', '#b48cff', '#ff9f43', '#4dd0c8', '#ff7ac6', '#9ccc65', '#6c8cff'];
const TAU = Math.PI * 2;

class Wheel {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.rot = 0;
    this.labels = [];
    this.spinning = false;
    this.draw();
  }
  setLabels(labels) {
    if (this.spinning || JSON.stringify(labels) === JSON.stringify(this.labels)) return;
    this.labels = labels;
    this.draw();
  }
  draw() {
    const { ctx } = this;
    const W = this.c.width, cx = W / 2, cy = W / 2, r = W / 2 - 8;
    ctx.clearRect(0, 0, W, W);
    const n = this.labels.length;
    if (!n) {
      ctx.fillStyle = '#2a2d5a';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
      ctx.fillStyle = '#a3a8cc'; ctx.font = '600 24px Segoe UI, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('—', cx, cy + 8);
      return;
    }
    const seg = TAU / n;
    for (let i = 0; i < n; i++) {
      const a0 = this.rot + i * seg;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a0, a0 + seg);
      ctx.closePath();
      ctx.fillStyle = COLORS[i % COLORS.length];
      if (n % COLORS.length === 1 && i === n - 1) ctx.fillStyle = COLORS[2];
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(a0 + seg / 2);
      ctx.fillStyle = '#16142a';
      const size = n > 12 ? 17 : n > 8 ? 20 : 24;
      ctx.font = `700 ${size}px Segoe UI, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      let label = this.labels[i];
      while (ctx.measureText(label).width > r - 70 && label.length > 3) label = label.slice(0, -2) + '…';
      ctx.fillText(label, r - 16, 0);
      ctx.restore();
    }
    ctx.beginPath(); ctx.arc(cx, cy, 34, 0, TAU);
    ctx.fillStyle = '#141633'; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = '#ffcc33'; ctx.stroke();
  }
  // Dreht so, dass Segment `target` oben unter dem Zeiger landet
  spin(labels, target, ms) {
    this.labels = labels;
    const n = labels.length, seg = TAU / n;
    let end = -Math.PI / 2 - (target + 0.5) * seg + (Math.random() - 0.5) * seg * 0.6;
    if (ms < 300) { this.rot = end; this.draw(); return; }
    while (end < this.rot + 6 * TAU) end += TAU;
    const start = this.rot, t0 = performance.now();
    this.spinning = true;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      this.rot = start + (end - start) * (1 - Math.pow(1 - t, 4));
      this.draw();
      if (t < 1) requestAnimationFrame(step);
      else { this.rot = end % TAU; this.spinning = false; this.draw(); }
    };
    requestAnimationFrame(step);
  }
}

// ---------------------------------------------------------------------------
// Rundenende: Geld hochzählen statt Rad
// ---------------------------------------------------------------------------
let payoutKey = null;

function countUp(el, from, to, ms, delay, format) {
  el.textContent = format(from);
  const t0 = performance.now() + delay;
  const step = (now) => {
    const t = Math.max(0, Math.min(1, (now - t0) / ms));
    el.textContent = format(Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3))));
    if (t < 1) requestAnimationFrame(step);
    else el.closest('.pcard')?.classList.add('done');
  };
  requestAnimationFrame(step);
}

function renderPayout() {
  const overlay = $('#payoutOverlay');
  const po = S.payout;
  overlay.hidden = S.phase !== 'payout' || !po;
  if (overlay.hidden) { payoutKey = null; return; }
  const next = $('#nextRoundBtn');
  next.disabled = !isHost;
  next.textContent = `Weiter mit Runde ${S.round + 2}`;
  if (payoutKey === po.t) return;   // Animation nur einmal pro Rundenende
  payoutKey = po.t;

  $('#payoutTitle').textContent = `Runde ${po.round + 1} geschafft – Rundengeld!`;
  const byId = Object.fromEntries(S.players.map((p) => [p.id, p]));
  $('#payoutCards').innerHTML = po.results.map((r) => {
    const p = byId[r.playerId];
    return `<div class="pcard ${r.amount < 0 ? 'neg' : r.amount > 0 ? 'pos' : 'zero'}">
      ${avatarHtml(p, 'avatar lg')}
      <div class="pname">${esc(p?.name)}</div>
      <div class="pamt" data-amt="${r.amount}">+0</div>
      <div class="pbal muted" data-before="${r.before}" data-after="${r.before + r.amount}"></div>
    </div>`;
  }).join('');
  const animate = Date.now() - po.t < 8000;
  $('#payoutCards').querySelectorAll('.pcard').forEach((card, i) => {
    const amt = Number(card.querySelector('.pamt').dataset.amt);
    const bal = card.querySelector('.pbal');
    const before = Number(bal.dataset.before), after = Number(bal.dataset.after);
    const delay = animate ? i * 450 : 0, ms = animate ? 1800 : 0;
    countUp(card.querySelector('.pamt'), 0, amt, ms, delay, fmtSigned);
    countUp(bal, before, after, ms, delay, (v) => `Kontostand ${fmt(v)}`);
  });
}

$('#nextRoundBtn').addEventListener('click', () => act('host:nextRound'));

// ---------------------------------------------------------------------------
// Eigene Glücksräder – vom Gamemaster jederzeit über die Einstellungen ausgelöst
// ---------------------------------------------------------------------------
const wheelX = new Wheel($('#wheelCustom'));
let cwNonce = null, cwResultNonce = null;

function renderCustomWheel() {
  const overlay = $('#wheelOverlay');
  const w = S.customWheel;
  overlay.hidden = !w;
  if (!w) { if (cwNonce !== null) Sfx.stop(); cwNonce = null; return; }
  $('#cwTitle').textContent = w.name;
  // Angezeigt, aber noch nicht gedreht: Rad mit allen Feldern stehen lassen
  if (w.state === 'ready') wheelX.setLabels(w.labels);
  if (w.nonce && w.nonce !== cwNonce) {
    cwNonce = w.nonce;
    wheelX.spin(w.labels, w.target, w.remainingMs);
    if (isHost && w.remainingMs > 300) Sfx.play(w.sound, { maxMs: w.remainingMs + 250 });
  }
  const res = $('#cwResult');
  if (w.state === 'done') {
    res.innerHTML = `<span class="muted">Ergebnis:</span> <b>${esc(w.result)}</b>`;
    if (cwResultNonce !== w.nonce) {
      cwResultNonce = w.nonce;
      res.classList.remove('pop'); void res.offsetWidth; res.classList.add('pop');
      if (isHost) Sfx.play(w.endSound);
    }
  } else if (w.state === 'spinning') res.innerHTML = '<span class="muted">Das Rad dreht sich …</span>';
  else res.innerHTML = `<span class="muted">${isHost ? 'Bereit – auf „Drehen“ oder das Rad klicken' : 'Gleich wird gedreht …'}</span>`;

  const spin = $('#cwSpin');
  spin.hidden = !isHost || w.state === 'spinning';
  spin.textContent = w.state === 'done' ? 'Nochmal drehen' : 'Drehen';
  $('#cwClose').hidden = !isHost || w.state === 'spinning';
  overlay.classList.toggle('canspin', isHost && w.state !== 'spinning');
}

$('#cwSpin').addEventListener('click', () => act('admin:wheelSpin'));
$('#wheelCustom').addEventListener('click', () => {
  if (isHost && S.customWheel && S.customWheel.state !== 'spinning') act('admin:wheelSpin');
});
$('#cwClose').addEventListener('click', () => act('admin:wheelClose'));

// ---------------------------------------------------------------------------
// Rundenstart: Kategorie kurz groß einblenden
// ---------------------------------------------------------------------------
let introKey = null, introTimer;

function renderRoundIntro() {
  const el = $('#roundIntro');
  if (S.phase === 'lobby') { introKey = null; el.hidden = true; return; }
  if (!['prepare', 'auction'].includes(S.phase)) return;
  const key = `${S.round}|${S.roundCategory}`;
  if (key === introKey) return;
  const first = introKey === null && Date.now() - (S.log.at(-1)?.t || 0) > 5000;   // TV mitten im Spiel neu geladen
  introKey = key;
  if (first) return;
  $('#riRound').textContent = `Runde ${S.round + 1} von ${S.grid.length}`;
  $('#riCat').textContent = S.roundCategory || 'Gemischt';
  el.hidden = false;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(introTimer);
  introTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

