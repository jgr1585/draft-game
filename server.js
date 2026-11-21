  'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const CHAR_DIR = path.resolve(process.env.CHAR_DIR || path.join(__dirname, 'characters'));
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || path.join(__dirname, 'music'));
const WHEEL_DIR = path.resolve(process.env.WHEEL_DIR || path.join(__dirname, 'wheels'));
const WHEEL_FILE = path.join(WHEEL_DIR, 'wheels.json');
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(3).toString('hex');
const MIO = 1e6;

const RULES = {
  startMoney: 1000 * MIO,      // 1 Milliarde
  monsterBonus: 100 * MIO,     // Joker "Weißes Monster"
  minPlayers: 2,
  maxPlayers: 8,
  minRows: 5,
  maxRows: 10,
  spinMs: Number(process.env.SPIN_MS) || 5200,
};

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.wav', '.webm', '.flac']);
const AMOUNT_RE = /^([-+]?\d+(?:[.,]\d+)?)(k|tsd|m|mio|b|bn|mrd)?$/i;
const MULT = { k: 1e3, tsd: 1e3, m: 1e6, mio: 1e6, b: 1e9, bn: 1e9, mrd: 1e9 };

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------
class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

function parseAmount(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input) : NaN;
  const m = String(input ?? '').trim().replace(/\s+/g, '').match(AMOUNT_RE);
  if (!m) return NaN;
  const n = parseFloat(m[1].replace(',', '.'));
  return Math.round(n * (MULT[(m[2] || '').toLowerCase()] || 1));
}

function fmt(n) {
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e9) return `${s}${+(a / 1e9).toFixed(2)} Mrd`;
  if (a >= 1e6) return `${s}${+(a / 1e6).toFixed(1)} Mio`;
  return `${s}${a}`;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const rid = () => crypto.randomBytes(5).toString('hex');

function lanAddress() {
  if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;
  const score = (ip) => (ip.startsWith('192.168.') ? 3 : ip.startsWith('10.') ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1 : 0);
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  }
  ips.sort((a, b) => score(b) - score(a));
  return ips[0] || 'localhost';
}

const PUBLIC_BASE = process.env.PUBLIC_URL || `http://${lanAddress()}:${PORT}`;
const LAN_JOIN_URL = `${PUBLIC_BASE}/play`;

// ---------------------------------------------------------------------------
// ngrok-Tunnel: Spieler können von außerhalb des WLANs beitreten
//   Authtoken aus NGROK_AUTHTOKEN oder aus der ngrok-CLI-Konfiguration (ngrok.yml)
// ---------------------------------------------------------------------------
const tunnel = { status: 'off', url: null, error: null, listener: null }; // off | starting | on | error

function ngrokToken() {
  if (process.env.NGROK_AUTHTOKEN) return process.env.NGROK_AUTHTOKEN.trim();
  const home = os.homedir();
  const candidates = [
    process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, 'ngrok', 'ngrok.yml'),
    path.join(home, '.config', 'ngrok', 'ngrok.yml'),
    path.join(home, 'Library', 'Application Support', 'ngrok', 'ngrok.yml'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ngrok', 'ngrok.yml'),
    path.join(home, '.ngrok2', 'ngrok.yml'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const m = fs.readFileSync(file, 'utf8').match(/^\s*authtoken:\s*["']?([^\s"'#]+)/m);
      if (m) return m[1];
    } catch { /* Datei gibt es nicht */ }
  }
  return null;
}

async function startTunnel() {
  if (tunnel.status === 'on' || tunnel.status === 'starting') return;
  const authtoken = ngrokToken();
  if (!authtoken) {
    Object.assign(tunnel, { status: 'error', error: 'Kein ngrok-Authtoken gefunden. NGROK_AUTHTOKEN setzen oder "ngrok config add-authtoken …" ausführen.' });
    broadcast();
    return;
  }
  Object.assign(tunnel, { status: 'starting', error: null });
  broadcast();
  try {
    const ngrok = require('@ngrok/ngrok');
    const opts = { addr: PORT, authtoken };
    if (process.env.NGROK_DOMAIN) opts.domain = process.env.NGROK_DOMAIN;
    const listener = await ngrok.forward(opts);
    Object.assign(tunnel, { status: 'on', url: listener.url(), listener });
    console.log(`  ngrok aktiv – Spieler von überall:     ${joinUrl()}`);
  } catch (err) {
    const msg = String(err?.message || err).split('\n')[0];
    Object.assign(tunnel, { status: 'error', url: null, listener: null, error: `ngrok-Fehler: ${msg}` });
    console.warn(`  ! ${tunnel.error}`);
  }
  broadcast();
}

async function stopTunnel() {
  const l = tunnel.listener;
  Object.assign(tunnel, { status: 'off', url: null, error: null, listener: null });
  broadcast();
  try { await l?.close(); } catch { /* egal */ }
}

const WANT_TUNNEL = process.argv.includes('--ngrok') || /^(1|true|yes|on)$/i.test(process.env.NGROK || '');
const joinUrl = () => (tunnel.url ? `${tunnel.url}/play` : LAN_JOIN_URL);

function parseDataUrl(dataUrl, maxBytes) {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) fail('Bildformat nicht unterstützt (PNG, JPG, WEBP, GIF).');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) fail(`Bild ist zu groß (max. ${Math.round(maxBytes / 1e6)} MB).`);
  return { mime: m[1], buf };
}

// ---------------------------------------------------------------------------
// Charakter aus dem Ordner einlesen
//   characters/<Kategorie>/<Name>_<Wert>.png      z. B. Krieger/Eisenfaust_300M.png
//   optional daneben <Name>_<Wert>.json  { "name": "...", "value": "300M", "category": "..." }
// ---------------------------------------------------------------------------
let characters = [];
let charMap = new Map();

function scanCharacters() {
  const out = [];
  if (!fs.existsSync(CHAR_DIR)) return out;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (!IMG_EXT.has(ext)) continue;

      const base = e.name.slice(0, -ext.length);
      const rel = path.relative(CHAR_DIR, full).split(path.sep);
      let category = rel.length > 1 ? rel.slice(0, -1).join(' / ') : 'Ohne Kategorie';
      let name = base;
      let value = NaN;

      const m = base.match(/^(.*?)[\s_-]+(-?\d+(?:[.,]\d+)?\s*(?:k|tsd|m|mio|b|bn|mrd)?)$/i);
      if (m) { name = m[1]; value = parseAmount(m[2]); }

      const sidecar = path.join(dir, `${base}.json`);
      if (fs.existsSync(sidecar)) {
        try {
          const meta = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
          if (meta.name) name = String(meta.name);
          if (meta.value !== undefined) value = parseAmount(meta.value);
          if (meta.category) category = String(meta.category);
        } catch (err) {
          console.warn(`  ! ${rel.join('/')}: JSON fehlerhaft (${err.message})`);
        }
      }

      if (!Number.isFinite(value) || value < 0) {
        console.warn(`  ! Übersprungen, kein Wert im Namen: ${rel.join('/')}  (Beispiel: Eisenfaust_300M.png)`);
        continue;
      }

      out.push({
        id: crypto.createHash('sha1').update(rel.join('/')).digest('hex').slice(0, 10),
        name: name.replace(/_/g, ' ').trim(),
        value,
        category,
        image: '/characters/' + rel.map(encodeURIComponent).join('/'),
      });
    }
  };
  walk(CHAR_DIR);
  return out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function loadCharacters() {
  characters = scanCharacters();
  charMap = new Map(characters.map((c) => [c.id, c]));
  config.categoryPlan = normalizePlan(config.categoryPlan, config.rows);
  console.log(`  ${characters.length} Charakter aus ${CHAR_DIR} geladen`);
}

// ---------------------------------------------------------------------------
// Hintergrundmusik aus music/ (beliebige Unterordner, Dateiname = Titel)
// ---------------------------------------------------------------------------
let musicFiles = [];

function loadMusic() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (!AUDIO_EXT.has(ext)) continue;
      const rel = path.relative(MUSIC_DIR, full).split(path.sep);
      out.push({
        id: 'file:' + rel.join('/'),
        name: e.name.slice(0, -ext.length).replace(/_/g, ' ').trim(),
        url: '/music/' + rel.map(encodeURIComponent).join('/'),
      });
    }
  };
  if (fs.existsSync(MUSIC_DIR)) walk(MUSIC_DIR);
  musicFiles = out.sort((a, b) => a.name.localeCompare(b.name));
}

const musicTracks = () => musicFiles;

// ---------------------------------------------------------------------------
// Spielzustand
// ---------------------------------------------------------------------------
const config = {
  maxPlayers: 4,
  rows: 5,
  payoutMin: 0,            // Rundengeld: zufällige ganze Mio zwischen min und max
  payoutMax: 300,
  bgColor: '#141633',
  categoryPlan: [],        // wird nach dem Einlesen der Charakter vorbelegt
  jokerUses: { monster: 1, block: 1, swap: 1, peek: 1 },   // Einsätze pro Spieler und Spiel
  music: { track: 'none', volume: 0.4, playing: true },
};

let players = [];          // { id, token, name, money, jokers: { typ: übrige Einsätze }, avatarVersion, sockets }
const JOKER_TYPES = ['monster', 'block', 'swap', 'peek'];
const JOKER_NAMES = { monster: 'Weißes Monster', block: 'Sperre', swap: 'Tausch', peek: 'Spicken' };
const freshJokers = () => ({ ...config.jokerUses });
const avatars = new Map(); // playerId -> { mime, buf }
let background = null;     // { mime, buf }
let bgVersion = 0;
let spinNonce = 0;
let auctionSeq = 0;
let musicStatus = { state: 'off', error: null };   // vom TV gemeldet: off | playing | stopped | blocked | error

const newGame = () => ({
  phase: 'lobby',          // lobby | prepare | auction | payout | finished
  grid: [],                // grid[reihe][spalte = spielerindex] = { charId, price } | null
  round: 0,                // aktuelle Runde
  roundCats: [],           // roundCats[runde] = Kategorie-Name | null (= gemischt), Kopie des Plans beim Start
  queue: [],
  skipped: [],
  current: null,           // { charId, highest, withdrawn[], blocked[], skips[] }
  payout: null,            // { round, results: [{ playerId, amount, before }], t }
  trades: [],              // offene Tauschangebote { id, fromId, toId, row, t }
  log: [],
});
let game = newGame();

const log = (msg) => {
  game.log.push({ t: Date.now(), msg });
  if (game.log.length > 40) game.log.shift();
};

const getPlayer = (id) => players.find((p) => p.id === id) || fail('Spieler nicht gefunden.');
const colOf = (p) => players.indexOf(p);
const hasSlot = (p) => !!(game.grid[game.round] && game.grid[game.round][colOf(p)]);
const needIds = () => players.filter((p) => !hasSlot(p)).map((p) => p.id);
const votersFor = (c) => needIds().filter((id) => !c.blocked.includes(id));

function requireAuction() {
  if (game.phase !== 'auction' || !game.current) fail('Gerade läuft keine Auktion.');
  return game.current;
}

function nextCharacter() {
  if (!game.queue.length) {
    if (game.skipped.length) {
      game.queue = shuffle(game.skipped);
      game.skipped = [];
      log('Übersprungene Charakter kommen wieder dran');
    } else {
      // Neu mischen, aber nichts, was in dieser Runde schon vergeben wurde
      const inRound = new Set((game.grid[game.round] || []).filter(Boolean).map((cell) => cell.charId));
      const pool = roundPool();
      const rest = pool.filter((id) => !inRound.has(id));
      game.queue = shuffle(rest.length ? rest : pool);
      log('Alle Charakter dieser Kategorie vergeben – der Pool wird neu gemischt');
    }
  }
  // Neuer Charakter startet verdeckt: nur Startwert und Kategorie sind sichtbar
  game.current = { seq: ++auctionSeq, charId: game.queue.shift(), revealed: false, highest: null, withdrawn: [], blocked: [], skips: [] };
}

// ---------------------------------------------------------------------------
// Kategorie-Plan: jede Runde hat eine vorab festgelegte Kategorie (null = gemischt).
// Wird automatisch vorbelegt, der Gamemaster kann ihn vor und während des Spiels umstellen.
// ---------------------------------------------------------------------------
const MIXED = 'Gemischt';

const categoryNames = () => [...new Set(characters.map((c) => c.category))];

function categoryList() {
  const counts = new Map();
  for (const c of characters) counts.set(c.category, (counts.get(c.category) || 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count }));
}

// Kategorien der Reihe nach, bei mehr Runden als Kategorien wieder von vorne
function defaultPlan(rows) {
  const cats = categoryNames();
  return Array.from({ length: rows }, (_, i) => (cats.length ? cats[i % cats.length] : null));
}

// Passt einen Plan an die Rundenzahl und an die vorhandenen Kategorien an
function normalizePlan(plan, rows) {
  const names = new Set(categoryNames());
  return defaultPlan(rows).map((fallback, i) => {
    const v = Array.isArray(plan) ? plan[i] : undefined;
    if (v === null) return null;
    return names.has(v) ? v : fallback;
  });
}

function validatePlan(plan, rows) {
  if (!Array.isArray(plan) || plan.length !== rows) fail(`Der Plan braucht genau ${rows} Runden.`);
  const names = new Set(categoryNames());
  return plan.map((v) => {
    if (v === null || v === '' || v === undefined) return null;
    if (!names.has(v)) fail(`Unbekannte Kategorie: ${v}`);
    return v;
  });
}

function roundPool() {
  const cat = game.roundCats[game.round];
  return characters.filter((c) => !cat || c.category === cat).map((c) => c.id);
}

// Bereitet die aktuelle Runde vor: Stapel aus ihrer Kategorie mischen. Der Gamemaster kann ihn jetzt
// noch umsortieren, die Auktion beginnt erst mit "Runde starten" (beginRound).
function prepareRound() {
  const cat = game.roundCats[game.round] ?? null;
  // Schon ersteigerte Charakter erst einmal draußen lassen, solange die Kategorie genug hergibt
  const owned = new Set(game.grid.flat().filter(Boolean).map((cell) => cell.charId));
  const pool = roundPool();
  const fresh = pool.filter((id) => !owned.has(id));
  game.queue = shuffle(fresh.length ? fresh : pool);
  game.skipped = [];
  game.current = null;
  game.phase = 'prepare';
  log(`Runde ${game.round + 1}: Kategorie ${cat || MIXED} – der Gamemaster ordnet den Stapel`);
}

function beginRound() {
  if (game.phase !== 'prepare') fail('Die Runde läuft schon.');
  game.phase = 'auction';
  log(`Runde ${game.round + 1} beginnt`);
  if (needIds().length === 0) return startPayout();   // der Gamemaster hat die Runde schon komplett befüllt
  nextCharacter();
}

// Spicken: Positionen der Runde = aktueller (noch verdeckter) Charakter, dann der Stapel in Reihenfolge
function peekList() {
  if (!['prepare', 'auction'].includes(game.phase)) return [];
  const c = game.current;
  return [...(c && !c.revealed ? [c.charId] : []), ...game.queue];
}

// Nach Änderungen am Raster: ist die laufende Runde jetzt voll, geht's zum Rundengeld
function afterGridEdit(rounds) {
  if (game.phase !== 'auction' || !rounds.includes(game.round)) return;
  if (needIds().length === 0) {
    if (game.current) game.queue.unshift(game.current.charId);
    startPayout();
  } else resolveIfDone();
}

const charName = (cell) => (cell ? charMap.get(cell.charId)?.name ?? '?' : 'leer');

const currentLabel = (c) => (c.revealed ? charMap.get(c.charId)?.name ?? '?' : 'Verdeckter Charakter');

function requireRevealed(c) {
  if (!c.revealed) fail('Der Charakter ist noch verdeckt – erst nach dem Aufdecken.');
}

function skipCurrent(reason) {
  const c = game.current;
  game.skipped.push(c.charId);
  log(`${currentLabel(c)} übersprungen (${reason})`);
  nextCharacter();
}

function assign(p, price, how) {
  const c = game.current;
  const ch = charMap.get(c.charId);
  p.money -= price;
  game.grid[game.round][colOf(p)] = { charId: c.charId, price };
  log(`${p.name} ${how} ${ch.name} für ${fmt(price)}`);
  game.lastAward = { playerId: p.id, charId: c.charId, price, t: Date.now() };
  game.current = null;
  if (needIds().length === 0) startPayout();
  else nextCharacter();
}

function award() {
  const { playerId, amount } = game.current.highest;
  assign(getPlayer(playerId), amount, 'ersteigert');
}

// Prüft nach jeder Aktion, ob die Auktion entschieden ist
function resolveIfDone() {
  const c = game.current;
  if (!c || game.phase !== 'auction') return;

  const active = votersFor(c).filter((id) => !c.withdrawn.includes(id));
  // Alle ausgestiegen, niemand hat geboten: gleich weiter – auch wenn er noch verdeckt ist
  if (!c.highest && active.length === 0) return skipCurrent(c.revealed ? 'niemand hat geboten' : 'alle sind ausgestiegen');

  // Zugeschlagen wird erst nach dem Aufdecken
  if (c.revealed && c.highest) {
    // Wer nicht mehr überbieten kann, zählt nicht mehr als Gegner
    const rivals = active.filter((id) => id !== c.highest.playerId && getPlayer(id).money > c.highest.amount);
    if (rivals.length === 0) return award();
  }

  // Skippen geht jederzeit, auch solange der Charakter noch verdeckt ist
  if (c.skips.length > votersFor(c).length / 2) skipCurrent('Mehrheit hat geskippt');
}

// Rundenende: jeder bekommt einen zufälligen Betrag (ganze Mio zwischen min und max) – nach der letzten Runde nicht
function startPayout() {
  game.current = null;
  if (game.round + 1 >= game.grid.length) return finishGame();
  game.phase = 'payout';
  const { payoutMin: lo, payoutMax: hi } = config;
  const results = players.map((p) => {
    const amount = crypto.randomInt(lo, hi + 1) * MIO;
    const before = p.money;
    p.money += amount;
    return { playerId: p.id, amount, before };
  });
  game.payout = { round: game.round, results, t: Date.now() };
  log(`Runde ${game.round + 1} ist voll – Rundengeld: ${results.map((r) => `${getPlayer(r.playerId).name} ${r.amount > 0 ? '+' : ''}${fmt(r.amount)}`).join(', ')}`);
}

function finishGame() {
  game.phase = 'finished';
  game.current = null;
  game.payout = null;
  log('Raster voll – Spiel vorbei!');
}

function nextRound() {
  if (game.phase !== 'payout') fail('Erst muss die Runde fertig sein.');
  game.payout = null;
  if (game.round + 1 >= game.grid.length) finishGame();
  else {
    game.round++;
    prepareRound();
  }
}

// ---------------------------------------------------------------------------
// Eigene Glücksräder (wheels/wheels.json), jederzeit vom Gamemaster auslösbar
//   { "wheels": [ { "name": "Strafrad", "segments": ["…", "…"], "sound": "spin.mp3", "endSound": "tada.mp3", "durationMs": 6000 } ] }
//   "segments": "players" = ein Feld pro Spieler. Sounds liegen im Ordner wheels/.
// ---------------------------------------------------------------------------
let wheels = [];
let wheelSounds = [];
let activeWheel = null;
let wheelTimer = null;

function scanAudio(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

function normalizeWheel(w, i) {
  if (!w || typeof w !== 'object') fail(`Rad ${i + 1}: ungültig.`);
  const name = String(w.name || '').trim().slice(0, 60) || fail(`Rad ${i + 1}: Name fehlt.`);
  let segments = w.segments;
  if (segments !== 'players') {
    if (typeof segments === 'string') segments = segments.split('\n');
    if (!Array.isArray(segments)) fail(`Rad "${name}": "segments" muss eine Liste oder "players" sein.`);
    segments = segments.map((x) => String(x).trim().slice(0, 40)).filter(Boolean);
    if (segments.length < 2) fail(`Rad "${name}": mindestens 2 Felder.`);
    if (segments.length > 30) fail(`Rad "${name}": maximal 30 Felder.`);
  }
  const sound = (v) => {
    if (!v) return null;
    const f = String(v);
    if (!wheelSounds.includes(f)) fail(`Rad "${name}": Sound "${f}" nicht im Ordner wheels/ gefunden.`);
    return f;
  };
  const durationMs = w.durationMs === undefined || w.durationMs === '' ? 5000 : Math.round(Number(w.durationMs));
  if (!(durationMs >= 1000 && durationMs <= 30000)) fail(`Rad "${name}": Dauer 1000–30000 ms.`);
  const id = String(w.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || rid();
  return { id, name, segments, sound: sound(w.sound), endSound: sound(w.endSound), durationMs };
}

function uniqueIds(list) {
  const seen = new Set();
  for (const w of list) { while (seen.has(w.id)) w.id = rid(); seen.add(w.id); }
  return list;
}

function loadWheels() {
  wheelSounds = scanAudio(WHEEL_DIR);
  wheels = [];
  if (!fs.existsSync(WHEEL_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(WHEEL_FILE, 'utf8'));
    (Array.isArray(raw) ? raw : raw.wheels || []).forEach((w, i) => {
      try { wheels.push(normalizeWheel(w, i)); } catch (err) { console.warn(`  ! wheels.json: ${err.message}`); }
    });
    uniqueIds(wheels);
  } catch (err) {
    console.warn(`  ! wheels.json fehlerhaft: ${err.message}`);
  }
  console.log(`  ${wheels.length} Glücksräder aus ${WHEEL_FILE} geladen`);
}

function saveWheels() {
  fs.mkdirSync(WHEEL_DIR, { recursive: true });
  const data = wheels.map(({ id, name, segments, durationMs, sound, endSound }) =>
    ({ id, name, segments, durationMs, ...(sound ? { sound } : {}), ...(endSound ? { endSound } : {}) }));
  fs.writeFileSync(WHEEL_FILE, JSON.stringify({ wheels: data }, null, 2) + '\n');
}

const soundUrl = (f) => (f ? '/wheels/' + f.split('/').map(encodeURIComponent).join('/') : null);

const wheelLabels = (w) => (w.segments === 'players' ? players.map((p) => p.name) : [...w.segments]);

// Schritt 1: Rad für alle anzeigen (TV + Handys), noch ohne zu drehen
function showWheel(id) {
  const w = wheels.find((x) => x.id === id) || fail('Rad nicht gefunden.');
  if (activeWheel?.state === 'spinning') fail('Gerade dreht sich ein Rad.');
  const labels = wheelLabels(w);
  if (labels.length < 2) fail('Zu wenige Felder – ein Spieler-Rad braucht mindestens 2 Spieler.');
  clearTimeout(wheelTimer);
  activeWheel = {
    id: w.id, name: w.name, labels, state: 'ready', target: null, nonce: null, endsAt: 0, durationMs: 0,
    result: null, sound: soundUrl(w.sound), endSound: soundUrl(w.endSound),
  };
  log(`Rad „${w.name}“ wird gezeigt`);
}

// Schritt 2: das angezeigte Rad drehen (auch erneut, wenn das Ergebnis schon steht)
function spinWheel() {
  const aw = activeWheel || fail('Erst ein Rad anzeigen.');
  if (aw.state === 'spinning') fail('Das Rad dreht sich schon.');
  const w = wheels.find((x) => x.id === aw.id);
  if (w?.segments === 'players') aw.labels = wheelLabels(w);   // aktuelle Spieler
  if (aw.labels.length < 2) fail('Zu wenige Felder.');
  const durationMs = process.env.SPIN_MS ? RULES.spinMs : w?.durationMs || 5000;
  Object.assign(aw, {
    state: 'spinning', target: crypto.randomInt(aw.labels.length), nonce: ++spinNonce,
    endsAt: Date.now() + durationMs, durationMs, result: null,
  });
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => {
    if (activeWheel !== aw) return;
    aw.result = aw.labels[aw.target];
    aw.state = 'done';
    log(`Rad „${aw.name}“: ${aw.result}`);
    broadcast();
  }, durationMs);
}

function closeWheel() {
  clearTimeout(wheelTimer);
  activeWheel = null;
}

// ---------------------------------------------------------------------------
// Öffentlicher Zustand (ohne Tokens)
// ---------------------------------------------------------------------------
function publicState() {
  const c = game.current;
  const ch = c && charMap.get(c.charId);
  return {
    build: BUILD,
    phase: game.phase,
    rules: RULES,
    config,
    joinUrl: joinUrl(),
    lanJoinUrl: LAN_JOIN_URL,
    tunnel: { status: tunnel.status, url: tunnel.url, error: tunnel.error },
    musicTracks: musicTracks(),
    musicStatus,
    characterCount: characters.length,
    players: players.map((p, i) => ({
      id: p.id,
      name: p.name,
      money: p.money,
      jokers: p.jokers,
      connected: p.sockets > 0,
      avatar: p.avatarVersion ? `/avatar/${p.id}?v=${p.avatarVersion}` : null,
      column: i,
    })),
    grid: game.grid.map((row) => row.map((cell) => cell && { ...cell, char: charMap.get(cell.charId) || null })),
    round: game.round,
    current: c && {
      seq: c.seq,
      revealed: c.revealed,
      // Verdeckt: Name und Bild gehen gar nicht erst an die Clients
      char: c.revealed ? ch : { id: null, name: null, image: null, value: ch.value, category: ch.category },
      highest: c.highest,
      withdrawn: c.withdrawn,
      blocked: c.blocked,
      skips: c.skips,
      need: needIds(),
      skipNeeded: Math.floor(votersFor(c).length / 2) + 1,
    },
    payout: game.payout,
    trades: game.trades,
    peek: { count: peekList().length, currentHidden: !!(game.current && !game.current.revealed && game.phase === 'auction') },
    customWheel: activeWheel && {
      ...activeWheel,
      target: activeWheel.state === 'ready' ? null : activeWheel.target,
      remainingMs: activeWheel.state === 'spinning' ? Math.max(0, activeWheel.endsAt - Date.now()) : 0,
    },
    categories: categoryList(),
    roundCategories: game.phase === 'lobby' ? config.categoryPlan : game.roundCats,
    roundCategory: game.phase === 'lobby' ? null : game.roundCats[game.round] ?? null,
    queueLeft: game.queue.length,
    skippedCount: game.skipped.length,
    lastAward: game.lastAward || null,
    background: background ? `/background?v=${bgVersion}` : null,
    log: game.log.slice(-8),
  };
}

// Nur für das Gamemaster-Einstellungsfenster: enthält die verdeckten Charakter
const charInfo = (id) => {
  const c = charMap.get(id);
  return c ? { id, name: c.name, category: c.category, value: c.value, image: c.image } : { id, name: '?', category: '', value: 0, image: '' };
};

function adminState() {
  const c = game.current;
  return {
    current: c && { ...charInfo(c.charId), revealed: c.revealed },
    queue: game.queue.map(charInfo),
    skipped: game.skipped.map(charInfo),
    characters: characters.map((x) => charInfo(x.id)),
    wheels,
    wheelSounds,
    wheelFile: WHEEL_FILE,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
const pub = path.join(__dirname, 'public');
// Fingerabdruck der Oberfläche: ändert er sich (Update + Server-Neustart), laden offene Seiten neu,
// statt mit altem JavaScript weiterzulaufen (socket.io verbindet sonst still wieder).
const BUILD = (() => {
  const h = crypto.createHash('sha1');
  for (const f of fs.readdirSync(pub).sort()) h.update(f).update(fs.readFileSync(path.join(pub, f)));
  return h.digest('hex').slice(0, 12);
})();
app.get('/', (req, res) => res.redirect('/host'));
app.get('/host', (req, res) => res.sendFile(path.join(pub, 'host.html')));
app.get('/play', (req, res) => res.sendFile(path.join(pub, 'play.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.use(express.static(pub, { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
app.use('/characters', express.static(CHAR_DIR, { fallthrough: false }));
app.use('/music', express.static(MUSIC_DIR, { fallthrough: false }));
app.use('/wheels', (req, res, next) => (AUDIO_EXT.has(path.extname(req.path).toLowerCase()) ? next() : res.sendStatus(404)),
  express.static(WHEEL_DIR, { fallthrough: false }));

app.get('/avatar/:id', (req, res) => {
  const a = avatars.get(req.params.id);
  if (!a) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type(a.mime).send(a.buf);
});
app.get('/background', (req, res) => {
  if (!background) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type(background.mime).send(background.buf);
});
app.get('/api/qr', async (req, res) => {
  // Mit ?u=<Adresse> cachebar (die Adresse steckt in der URL), sonst immer frisch
  res.set('Cache-Control', req.query.u === joinUrl() ? 'public, max-age=3600' : 'no-store');
  res.type('image/svg+xml').send(await QRCode.toString(joinUrl(), { type: 'svg', margin: 1, color: { dark: '#000', light: '#fff' } }));
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 12e6 });
const broadcast = () => {
  io.emit('state', publicState());
  io.to('admin').emit('admin', adminState());
};

// ---------------------------------------------------------------------------
// Socket-Events
// ---------------------------------------------------------------------------
const isLoopback = (addr) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
// Über ngrok kommen fremde Verbindungen ebenfalls von 127.0.0.1 an, tragen aber X-Forwarded-For.
// Nur echte lokale Verbindungen ohne Proxy-Header gelten als Gamemaster ohne Key.
const isLocalClient = (socket) => isLoopback(socket.handshake.address) &&
  !socket.handshake.headers['x-forwarded-for'] && !socket.handshake.headers['x-forwarded-host'];

io.on('connection', (socket) => {
  socket.emit('state', publicState());

  const on = (event, handler) => {
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const res = handler(payload && typeof payload === 'object' ? payload : {});
        broadcast();                      // Zustand zuerst, damit Clients beim Ack schon aktuell sind
        reply({ ok: true, ...(res || {}) });
      } catch (err) {
        if (err instanceof GameError) reply({ ok: false, error: err.message });
        else { console.error(err); reply({ ok: false, error: 'Interner Fehler – siehe Server-Konsole.' }); }
      }
    });
  };

  const me = () => players.find((p) => p.id === socket.data.playerId) || fail('Du bist nicht im Spiel.');
  const host = () => { if (!socket.data.host) fail('Nur der Gamemaster darf das.'); };

  const bind = (p) => {
    if (socket.data.playerId) return;
    socket.data.playerId = p.id;
    p.sockets++;
  };

  const setAvatar = (p, dataUrl) => {
    if (!dataUrl) return;
    avatars.set(p.id, parseDataUrl(dataUrl, 3e6));
    p.avatarVersion++;
  };

  socket.on('disconnect', () => {
    if (socket.data.musicReporter) { musicStatus = { state: 'off', error: null }; broadcast(); }
    const p = players.find((x) => x.id === socket.data.playerId);
    if (p) { p.sockets = Math.max(0, p.sockets - 1); broadcast(); }
  });

  // ----- Spieler -----------------------------------------------------------
  on('player:join', ({ name, avatar }) => {
    if (socket.data.playerId) fail('Du bist schon beigetreten.');
    if (game.phase !== 'lobby') fail('Das Spiel läuft schon – beitreten geht nur in der Lobby.');
    if (players.length >= config.maxPlayers) fail('Die Lobby ist voll.');
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name) fail('Bitte gib einen Namen ein.');
    if (players.some((p) => p.name.toLowerCase() === name.toLowerCase())) fail('Der Name ist schon vergeben.');

    const p = {
      id: rid(),
      token: crypto.randomBytes(16).toString('hex'),
      name,
      money: RULES.startMoney,
      jokers: freshJokers(),
      avatarVersion: 0,
      sockets: 0,
    };
    setAvatar(p, avatar);
    players.push(p);
    bind(p);
    log(`${name} ist beigetreten`);
    return { token: p.token, playerId: p.id };
  });

  on('player:resume', ({ token }) => {
    const p = players.find((x) => x.token === token) || fail('Sitzung nicht mehr gültig.');
    bind(p);
    return { playerId: p.id };
  });

  on('player:leave', () => {
    const p = me();
    if (game.phase !== 'lobby') fail('Verlassen geht nur in der Lobby.');
    players = players.filter((x) => x !== p);
    avatars.delete(p.id);
    socket.data.playerId = null;
    log(`${p.name} hat die Lobby verlassen`);
  });

  on('bid', ({ amount }) => {
    const p = me();
    const c = requireAuction();
    const ch = charMap.get(c.charId);
    amount = Math.round(Number(amount));
    if (!Number.isFinite(amount) || amount <= 0) fail('Ungültiger Betrag.');
    if (hasSlot(p)) fail('Du hast in dieser Runde schon einen Charakter.');
    if (c.blocked.includes(p.id)) fail('Du bist für diesen Charakter gesperrt.');
    if (c.withdrawn.includes(p.id)) fail('Du bist bei diesem Charakter schon ausgestiegen.');
    if (c.highest?.playerId === p.id) fail('Du bist schon Höchstbietender.');
    if (amount < ch.value) fail(`Mindestens ${fmt(ch.value)} (Startwert).`);
    if (c.highest && amount <= c.highest.amount) fail(`Du musst mehr als ${fmt(c.highest.amount)} bieten.`);
    if (amount > p.money) fail('So viel Kohle hast du nicht.');
    c.highest = { playerId: p.id, amount };
    c.skips = c.skips.filter((id) => id !== p.id);
    resolveIfDone();
  });

  on('withdraw', () => {
    const p = me();
    const c = requireAuction();
    if (hasSlot(p)) fail('Du bietest in dieser Runde nicht mehr mit.');
    if (c.withdrawn.includes(p.id)) fail('Du bist schon ausgestiegen.');
    if (c.highest?.playerId === p.id) fail('Als Höchstbietender kannst du nicht aussteigen.');
    c.withdrawn.push(p.id);
    resolveIfDone();
  });

  on('skip', () => {
    const p = me();
    const c = requireAuction();
    if (hasSlot(p) || c.blocked.includes(p.id)) fail('Du kannst hier nicht abstimmen.');
    if (c.skips.includes(p.id)) c.skips = c.skips.filter((id) => id !== p.id);
    else c.skips.push(p.id);
    resolveIfDone();
  });

  on('joker', ({ type, targetId, row, position }) => {
    const p = me();
    if (!['prepare', 'auction', 'payout'].includes(game.phase)) fail('Joker gehen nur während des Spiels.');
    if (!JOKER_TYPES.includes(type)) fail('Unbekannter Joker.');
    if (!(p.jokers[type] > 0)) fail(`Du hast keinen ${JOKER_NAMES[type]}-Joker mehr.`);

    if (type === 'monster') {
      // Vorab-Joker: nur solange der aktuelle Charakter noch verdeckt ist
      const c = requireAuction();
      if (c.revealed) fail('Das weiße Monster geht nur, solange der Charakter noch verdeckt ist.');
      p.money += RULES.monsterBonus;
      log(`${p.name} trinkt ein weißes Monster: +${fmt(RULES.monsterBonus)}`);
    } else if (type === 'block') {
      const c = requireAuction();
      const t = getPlayer(targetId);
      if (t.id === p.id) fail('Du kannst dich nicht selbst sperren.');
      if (hasSlot(t)) fail(`${t.name} bietet in dieser Runde eh nicht mehr mit.`);
      if (c.blocked.includes(t.id)) fail(`${t.name} ist schon gesperrt.`);
      if (c.highest) fail('Sperren geht nur, solange noch niemand geboten hat.');
      c.blocked.push(t.id);
      c.skips = c.skips.filter((id) => id !== t.id);
      log(`${p.name} sperrt ${t.name} für ${currentLabel(c)}`);
    } else if (type === 'swap') {
      // Tausch ist nur ein Angebot – der andere muss annehmen, erst dann ist der Joker weg
      const r = Number(row);
      if (!Number.isInteger(r) || r < 0 || r >= game.grid.length) fail('Ungültige Runde.');
      const t = getPlayer(targetId);
      if (t.id === p.id) fail('Wähle einen anderen Spieler.');
      if (!game.grid[r][colOf(p)] || !game.grid[r][colOf(t)]) fail('In dieser Runde braucht ihr beide einen Charakter.');
      if (game.trades.some((x) => x.fromId === p.id)) fail('Du hast schon ein offenes Tauschangebot.');
      game.trades.push({ id: rid(), fromId: p.id, toId: t.id, row: r, t: Date.now() });
      log(`${p.name} bietet ${t.name} einen Tausch in Runde ${r + 1} an`);
      return { pending: true };
    } else {
      // Spicken: Position im Stapel dieser Runde wählen, nur dieser Spieler sieht das Ergebnis
      const list = peekList();
      if (!list.length) fail('Gerade gibt es nichts zum Spicken.');
      const pos = Math.round(Number(position));
      if (!(pos >= 1 && pos <= list.length)) fail(`Wähle eine Position von 1 bis ${list.length}.`);
      p.jokers.peek--;
      log(`${p.name} spickt auf Position ${pos}`);
      return { peek: { position: pos, round: game.round, ...charInfo(list[pos - 1]) } };
    }
    p.jokers[type]--;
    if (type === 'block') resolveIfDone();
  });

  const tradeById = (id) => game.trades.find((x) => x.id === id) || fail('Das Tauschangebot gibt es nicht mehr.');

  on('trade:respond', ({ id, accept }) => {
    const p = me();
    const t = tradeById(id);
    if (t.toId !== p.id) fail('Das Angebot ist nicht für dich.');
    const from = getPlayer(t.fromId);
    if (accept) {
      const a = game.grid[t.row][colOf(from)];
      const b = game.grid[t.row][colOf(p)];
      if (!a || !b || !(from.jokers.swap > 0)) {
        game.trades = game.trades.filter((x) => x !== t);
        log(`Tausch zwischen ${from.name} und ${p.name} geht nicht mehr`);
        return { stale: true };
      }
      game.grid[t.row][colOf(from)] = b;
      game.grid[t.row][colOf(p)] = a;
      from.jokers.swap--;
      log(`${p.name} nimmt an: Runde ${t.row + 1}, ${from.name} bekommt ${charName(b)}, ${p.name} bekommt ${charName(a)}`);
    } else {
      log(`${p.name} lehnt den Tausch von ${from.name} ab`);
    }
    game.trades = game.trades.filter((x) => x !== t);
  });

  on('trade:cancel', ({ id }) => {
    const p = me();
    const t = tradeById(id);
    if (t.fromId !== p.id) fail('Das ist nicht dein Angebot.');
    game.trades = game.trades.filter((x) => x !== t);
    log(`${p.name} zieht das Tauschangebot zurück`);
  });

  // ----- Gamemaster --------------------------------------------------------
  on('host:hello', ({ key }) => {
    if (!isLocalClient(socket) && key !== HOST_KEY) {
      fail('Kein Gamemaster-Zugang. Öffne /host am Spiel-Rechner oder nutze den Link mit ?key= aus der Server-Konsole.');
    }
    socket.data.host = true;
  });

  on('host:config', ({ maxPlayers, rows, payoutMin, payoutMax, bgColor, music, jokerUses }) => {
    host();
    if (jokerUses !== undefined) {
      if (game.phase !== 'lobby') fail('Joker-Einsätze nur in der Lobby einstellbar (im Spiel: Einstellungen → Spieler).');
      for (const [k, v] of Object.entries(jokerUses || {})) {
        if (!JOKER_TYPES.includes(k)) fail('Unbekannter Joker.');
        const n = Math.round(Number(v));
        if (!(n >= 0 && n <= 9)) fail('Joker-Einsätze: 0–9.');
        config.jokerUses[k] = n;
      }
      for (const p of players) p.jokers = freshJokers();
    }
    if (music !== undefined) {
      const { track, volume, playing } = music || {};
      if (track !== undefined) {
        if (track !== 'none' && !musicTracks().some((t) => t.id === track)) fail('Unbekannter Musiktitel.');
        config.music.track = track;
        config.music.playing = true;   // neuer Titel startet sofort
      }
      if (playing !== undefined) config.music.playing = !!playing;
      if (volume !== undefined) {
        const v = Number(volume);
        if (!(v >= 0 && v <= 1)) fail('Lautstärke: 0–1.');
        config.music.volume = Math.round(v * 100) / 100;
      }
    }
    if (maxPlayers !== undefined || rows !== undefined) {
      if (game.phase !== 'lobby') fail('Spieler und Raster nur in der Lobby änderbar.');
      if (maxPlayers !== undefined) {
        const n = Math.round(Number(maxPlayers));
        if (!(n >= RULES.minPlayers && n <= RULES.maxPlayers)) fail(`Spieler: ${RULES.minPlayers}–${RULES.maxPlayers}.`);
        if (n < players.length) fail(`Es sind schon ${players.length} Spieler beigetreten.`);
        config.maxPlayers = n;
      }
      if (rows !== undefined) {
        const n = Math.round(Number(rows));
        if (!(n >= RULES.minRows && n <= RULES.maxRows)) fail(`Runden: ${RULES.minRows}–${RULES.maxRows}.`);
        config.rows = n;
        config.categoryPlan = normalizePlan(config.categoryPlan, n);
      }
    }
    if (payoutMin !== undefined || payoutMax !== undefined) {
      const lo = payoutMin !== undefined ? Number(payoutMin) : config.payoutMin;
      const hi = payoutMax !== undefined ? Number(payoutMax) : config.payoutMax;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) fail('Rundengeld: nur ganze Zahlen (in Mio).');
      if (lo < -10000 || hi > 10000) fail('Rundengeld: zwischen -10000 und 10000 Mio.');
      if (lo > hi) fail('Rundengeld: Minimum darf nicht größer als das Maximum sein.');
      config.payoutMin = lo;
      config.payoutMax = hi;
    }
    if (bgColor !== undefined) {
      if (!/^#[0-9a-f]{6}$/i.test(bgColor)) fail('Ungültige Farbe.');
      config.bgColor = bgColor;
    }
  });

  on('host:background', ({ dataUrl }) => {
    host();
    background = dataUrl ? parseDataUrl(dataUrl, 10e6) : null;
    bgVersion++;
  });

  on('host:kick', ({ playerId }) => {
    host();
    if (game.phase !== 'lobby') fail('Entfernen geht nur in der Lobby.');
    const p = getPlayer(playerId);
    players = players.filter((x) => x !== p);
    avatars.delete(p.id);
    for (const s of io.sockets.sockets.values()) {
      if (s.data.playerId === p.id) { s.data.playerId = null; s.emit('kicked'); }
    }
    log(`${p.name} wurde entfernt`);
  });

  on('host:rescan', () => {
    host();
    if (game.phase !== 'lobby') fail('Neu einlesen geht nur in der Lobby.');
    loadCharacters();
    loadMusic();
    loadWheels();
  });

  // Der TV meldet, ob die Musik wirklich läuft (Browser blockiert Ton, Format nicht unterstützt …)
  on('host:musicStatus', ({ state, error }) => {
    host();
    if (!['off', 'playing', 'stopped', 'blocked', 'error'].includes(state)) fail('Ungültiger Status.');
    musicStatus = { state, error: error ? String(error).slice(0, 200) : null };
    socket.data.musicReporter = true;
  });

  on('host:tunnel', ({ enabled }) => {
    host();
    if (enabled) startTunnel();   // läuft asynchron weiter und broadcastet selbst
    else stopTunnel();
  });

  on('host:reveal', () => {
    host();
    const c = requireAuction();
    if (c.revealed) fail('Schon aufgedeckt.');
    c.revealed = true;
    log(`Aufgedeckt: ${currentLabel(c)}`);
    resolveIfDone();
  });

  on('host:start', () => {
    host();
    if (game.phase !== 'lobby') fail('Das Spiel läuft schon.');
    if (players.length < RULES.minPlayers) fail(`Mindestens ${RULES.minPlayers} Spieler nötig.`);
    loadCharacters();
    if (!characters.length) fail('Keine Charakter gefunden – Ordner "characters" prüfen.');
    for (const p of players) {
      p.money = RULES.startMoney;
      p.jokers = freshJokers();
    }
    game = newGame();
    game.grid = Array.from({ length: config.rows }, () => players.map(() => null));
    game.roundCats = [...config.categoryPlan];
    log(`Spiel gestartet: ${players.length} Spieler, ${config.rows} Runden`);
    prepareRound();
  });

  on('host:beginRound', () => {
    host();
    beginRound();
  });

  on('host:hammer', () => {
    host();
    const c = requireAuction();
    if (!c.highest) fail('Noch kein Gebot.');
    requireRevealed(c);
    award();
  });

  on('host:skipChar', () => {
    host();
    requireAuction();
    skipCurrent('Gamemaster');
  });

  on('host:giveChar', ({ playerId }) => {
    host();
    requireAuction();
    const p = getPlayer(playerId);
    if (hasSlot(p)) fail(`${p.name} hat in dieser Runde schon einen Charakter.`);
    assign(p, 0, 'bekommt geschenkt:');
  });

  on('host:nextRound', () => {
    host();
    nextRound();
  });

  // ----- Gamemaster-Einstellungsfenster -------------------------------------
  on('admin:hello', ({ key }) => {
    if (!isLocalClient(socket) && key !== HOST_KEY) fail('Kein Gamemaster-Zugang. Link mit ?key= aus der Server-Konsole nutzen.');
    socket.data.host = true;
    socket.join('admin');
  });

  on('admin:queue', ({ order }) => {
    host();
    if (!Array.isArray(order) || order.length > 1000) fail('Ungültige Reihenfolge.');
    for (const id of order) if (!charMap.has(id)) fail('Unbekannter Charakter in der Liste.');
    game.queue = [...order];
  });

  on('admin:skipped', ({ order }) => {
    host();
    if (!Array.isArray(order) || order.some((id) => !charMap.has(id))) fail('Ungültige Liste.');
    game.skipped = [...order];
  });

  on('admin:money', ({ playerId, money, delta }) => {
    host();
    const p = getPlayer(playerId);
    if (money !== undefined) {
      const v = parseAmount(money);
      if (!Number.isFinite(v)) fail('Ungültiger Betrag.');
      p.money = v;
    } else {
      const d = parseAmount(delta);
      if (!Number.isFinite(d)) fail('Ungültiger Betrag.');
      p.money += d;
    }
    log(`Gamemaster: ${p.name} hat jetzt ${fmt(p.money)}`);
    resolveIfDone();
  });

  on('admin:joker', ({ playerId, type, delta, uses }) => {
    host();
    const p = getPlayer(playerId);
    if (!JOKER_TYPES.includes(type)) fail('Unbekannter Joker.');
    const n = uses !== undefined ? Math.round(Number(uses)) : (p.jokers[type] || 0) + Math.round(Number(delta));
    if (!Number.isFinite(n)) fail('Ungültige Anzahl.');
    p.jokers[type] = Math.max(0, Math.min(99, n));
    log(`Gamemaster: ${p.name} hat jetzt ${p.jokers[type]}× ${JOKER_NAMES[type]}`);
  });

  // Zwei beliebige Raster-Felder tauschen – ohne dass die Spieler zustimmen müssen
  on('admin:swapCells', ({ a, b }) => {
    host();
    const cell = (x) => {
      const r = Number(x?.round);
      if (!Number.isInteger(r) || r < 0 || r >= game.grid.length) fail('Ungültige Runde.');
      const p = getPlayer(x.playerId);
      return { r, col: colOf(p), p };
    };
    const A = cell(a), B = cell(b);
    if (A.r === B.r && A.col === B.col) fail('Zweimal dasselbe Feld.');
    const ca = game.grid[A.r][A.col], cb = game.grid[B.r][B.col];
    if (!ca && !cb) fail('Beide Felder sind leer.');
    game.grid[A.r][A.col] = cb;
    game.grid[B.r][B.col] = ca;
    log(`Gamemaster tauscht: ${A.p.name} (Runde ${A.r + 1}) bekommt ${charName(cb)}, ${B.p.name} (Runde ${B.r + 1}) bekommt ${charName(ca)}`);
    afterGridEdit([A.r, B.r]);
  });

  on('admin:rename', ({ playerId, name }) => {
    host();
    const p = getPlayer(playerId);
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name) fail('Name fehlt.');
    if (players.some((x) => x !== p && x.name.toLowerCase() === name.toLowerCase())) fail('Der Name ist schon vergeben.');
    p.name = name;
  });

  on('admin:setCell', ({ round, playerId, charId, price, refund }) => {
    host();
    const r = Number(round);
    if (!Number.isInteger(r) || r < 0 || r >= game.grid.length) fail('Ungültige Runde.');
    const p = getPlayer(playerId);
    const col = colOf(p);
    const old = game.grid[r][col];
    if (old && refund) p.money += old.price;
    if (!charId) {
      if (!old) fail('Das Feld ist schon leer.');
      game.grid[r][col] = null;
      log(`Gamemaster: ${charMap.get(old.charId)?.name ?? '?'} aus Runde ${r + 1} von ${p.name} entfernt${refund ? ' (Geld zurück)' : ''}`);
      return;
    }
    if (!charMap.has(charId)) fail('Unbekannter Charakter.');
    const cost = price === undefined || price === '' ? 0 : parseAmount(price);
    if (!Number.isFinite(cost) || cost < 0) fail('Ungültiger Preis.');
    p.money -= cost;
    game.grid[r][col] = { charId, price: cost };
    // Vergebene Charakter nicht noch einmal versteigern
    game.queue = game.queue.filter((id) => id !== charId);
    game.skipped = game.skipped.filter((id) => id !== charId);
    log(`Gamemaster: ${p.name} bekommt ${charMap.get(charId).name} in Runde ${r + 1}${cost ? ` für ${fmt(cost)}` : ''}`);
    // Ist die laufende Runde dadurch voll, geht der aktuelle Charakter zurück auf den Stapel
    afterGridEdit([r]);
  });

  on('admin:resetAuction', () => {
    host();
    const c = requireAuction();
    Object.assign(c, { highest: null, withdrawn: [], blocked: [], skips: [] });
    log('Gamemaster: Gebote für den aktuellen Charakter zurückgesetzt');
  });

  // Kategorie-Plan umstellen: in der Lobby frei, im Spiel nur die noch offenen Runden.
  // Ändert sich die Kategorie der laufenden Runde, wird ihr Stapel neu gemischt.
  on('admin:categoryPlan', ({ plan }) => {
    host();
    if (game.phase === 'lobby') {
      config.categoryPlan = validatePlan(plan, config.rows);
      return;
    }
    const next = validatePlan(plan, game.grid.length);
    const locked = game.phase === 'finished' ? game.grid.length : game.phase === 'payout' ? game.round + 1 : game.round;
    for (let r = 0; r < locked; r++) {
      if (next[r] !== game.roundCats[r]) fail(`Runde ${r + 1} ist schon gespielt und kann nicht mehr geändert werden.`);
    }
    const currentChanged = ['prepare', 'auction'].includes(game.phase) && next[game.round] !== game.roundCats[game.round];
    game.roundCats = next;
    config.categoryPlan = [...next];   // bleibt auch fürs nächste Spiel erhalten
    if (currentChanged) prepareRound();   // neue Kategorie: Stapel neu, Runde startet wieder mit der Vorbereitung
    else log('Gamemaster: Kategorie-Plan geändert');
  });

  on('admin:wheelsSave', ({ wheels: list }) => {
    host();
    if (!Array.isArray(list) || list.length > 50) fail('Ungültige Räder.');
    wheelSounds = scanAudio(WHEEL_DIR);
    wheels = uniqueIds(list.map(normalizeWheel));
    saveWheels();
  });

  on('admin:wheelShow', ({ id }) => {
    host();
    showWheel(id);
  });

  on('admin:wheelSpin', () => {
    host();
    spinWheel();
  });

  on('admin:wheelClose', () => {
    host();
    closeWheel();
  });

  on('admin:rescanFiles', () => {
    host();
    loadMusic();
    loadWheels();
  });

  on('host:reset', ({ keepPlayers }) => {
    host();
    game = newGame();
    closeWheel();
    if (keepPlayers) {
      for (const p of players) { p.money = RULES.startMoney; p.jokers = freshJokers(); }
      log('Neues Spiel mit denselben Spielern');
    } else {
      for (const s of io.sockets.sockets.values()) {
        if (s.data.playerId) { s.data.playerId = null; s.emit('kicked'); }
      }
      players = [];
      avatars.clear();
    }
  });
});

// ---------------------------------------------------------------------------
loadCharacters();
loadMusic();
loadWheels();
server.listen(PORT, () => {
  console.log('\n  Charakter-Auktion läuft');
  console.log(`  TV / Gamemaster (an diesem Rechner):  http://localhost:${PORT}/host`);
  console.log(`  TV auf anderem Gerät:                 ${PUBLIC_BASE}/host?key=${HOST_KEY}`);
  console.log(`  Spieler im WLAN (QR-Code am TV):      ${LAN_JOIN_URL}`);
  console.log(`  Gamemaster-Einstellungen:             http://localhost:${PORT}/admin   (anderes Gerät: ${PUBLIC_BASE}/admin?key=${HOST_KEY})`);
  console.log(`  Internet-Zugang: ${WANT_TUNNEL ? 'wird gestartet …' : 'in der Lobby einschalten oder npm run online'}\n`);
  if (WANT_TUNNEL) startTunnel();
});

const shutdown = () => { stopTunnel().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { parseAmount };
