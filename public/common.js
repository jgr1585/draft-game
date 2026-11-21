'use strict';

function fmt(n) {
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e9) return s + (a / 1e9).toLocaleString('de-AT', { maximumFractionDigits: 2 }) + ' Mrd';
  if (a >= 1e6) return s + (a / 1e6).toLocaleString('de-AT', { maximumFractionDigits: 1 }) + ' Mio';
  return s + a.toLocaleString('de-AT');
}
const fmtSigned = (n) => (n > 0 ? '+' : '') + fmt(n);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const $ = (sel, root = document) => root.querySelector(sel);

// Nach einem Update (neuer Server mit geänderten Dateien) die Seite neu laden
let seenBuild = null;
function checkBuild(state) {
  if (!state || !state.build) return;
  if (seenBuild && state.build !== seenBuild) location.reload();
  seenBuild = state.build;
}

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload || {}, (res) => resolve(res || { ok: false, error: 'Keine Antwort' })));
}

let toastTimer;
function toast(msg, kind = 'error') {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3200);
}

function avatarHtml(p, cls = 'avatar') {
  if (p && p.avatar) return `<img class="${cls}" src="${esc(p.avatar)}" alt="">`;
  const initials = (p?.name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `<div class="${cls} initials">${esc(initials)}</div>`;
}

// Bild verkleinern, optional quadratisch zuschneiden -> JPEG dataURL
function resizeImage(file, max, square) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      if (square) { const s = Math.min(sw, sh); sx = (sw - s) / 2; sy = (sh - s) / 2; sw = sh = s; }
      const scale = Math.min(1, max / Math.max(sw, sh));
      const c = document.createElement('canvas');
      c.width = Math.round(sw * scale);
      c.height = Math.round(sh * scale);
      c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden')); };
    img.src = url;
  });
}
