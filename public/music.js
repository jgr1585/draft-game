'use strict';
// Hintergrundmusik für den TV (Dateien aus music/) und Sounds für die Glücksräder.
// Browser erlauben Ton oft erst nach einem Klick auf die Seite. Blockiert der Browser,
// erscheint "Musik starten"; jeder Klick auf den TV holt die Wiedergabe nach.

const Music = {
  audio: null, track: 'none', volume: 0.4, playing: true,
  blocked: false, pending: false, status: null,
  onBlocked: null,   // (blockiert: bool) => void
  onStatus: null,    // ({ state, error }) => void  state: off | playing | stopped | blocked | error

  // Mit dem gewünschten Zustand aufrufen (bei jedem Render) – macht nur etwas, wenn sich was geändert hat
  apply(track, volume, playing, tracks) {
    if (volume !== this.volume) {
      this.volume = volume;
      if (this.audio) this.audio.volume = this.ducked ? volume * 0.35 : volume;
    }
    if (track !== this.track) {
      this.stop();
      this.track = track;
      const t = (tracks || []).find((x) => x.id === track);
      if (t) {
        const a = new Audio(t.url);
        a.loop = true;
        a.volume = volume;
        a.addEventListener('error', () => {
          if (this.audio !== a) return;
          const unsupported = a.error && a.error.code === 4;
          this.report('error', unsupported
            ? 'Dieser Browser kann das Dateiformat nicht abspielen (mp3 geht überall).'
            : 'Die Musikdatei konnte nicht geladen werden.');
        });
        this.audio = a;
      }
    }
    this.playing = playing;
    if (!this.audio) return this.report(track === 'none' ? 'off' : 'error', track === 'none' ? null : 'Musikdatei nicht gefunden.');
    if (!playing) {
      if (!this.audio.paused) this.audio.pause();
      this.setBlocked(false);
      return this.report('stopped');
    }
    if (this.audio.paused && !this.pending && !this.blocked && this.status?.state !== 'error') this.tryPlay();
  },

  tryPlay() {
    const a = this.audio;
    if (!a) return;
    this.pending = true;
    a.play().then(() => {
      this.pending = false;
      if (this.audio !== a) return;
      this.setBlocked(false);
      this.report('playing');
    }, (err) => {
      this.pending = false;
      if (this.audio !== a) return;
      if (err && err.name === 'NotAllowedError') {
        this.setBlocked(true);
        this.report('blocked');
      } else if (err && err.name !== 'AbortError') {
        this.report('error', err.name === 'NotSupportedError'
          ? 'Dieser Browser kann das Dateiformat nicht abspielen (mp3 geht überall).'
          : `Wiedergabe fehlgeschlagen: ${err.message}`);
      }
    });
  },

  // Nach einem Klick auf die Seite: blockierte Wiedergabe nachholen
  unlock() {
    if (!this.blocked) return;
    this.setBlocked(false);
    if (this.audio && this.playing && this.audio.paused) this.tryPlay();
  },

  stop() {
    if (this.audio) { this.audio.pause(); this.audio.src = ''; this.audio = null; }
    this.pending = false;
    this.status = null;
    this.setBlocked(false);
  },

  setBlocked(b) {
    if (b === this.blocked) return;
    this.blocked = b;
    if (this.onBlocked) this.onBlocked(b);
  },

  report(state, error = null) {
    if (this.status && this.status.state === state && this.status.error === error) return;
    this.status = { state, error };
    if (this.onStatus) this.onStatus(this.status);
  },

  // Während ein Rad-Sound läuft, Musik leiser
  duck(on) {
    this.ducked = on;
    if (this.audio) this.audio.volume = on ? this.volume * 0.35 : this.volume;
  },
};

// Einmal-Sounds (Rad-Drehgeräusch, Ergebnis-Sound)
const Sfx = {
  current: null,
  play(url, { maxMs } = {}) {
    this.stop();
    if (!url) return;
    const a = new Audio(url);
    a.volume = 1;
    a.play().catch(() => {});
    this.current = a;
    Music.duck(true);
    a.addEventListener('ended', () => Music.duck(false));
    if (maxMs) this.timer = setTimeout(() => this.stop(), maxMs);
  },
  stop() {
    clearTimeout(this.timer);
    if (this.current) { this.current.pause(); this.current = null; }
    Music.duck(false);
  },
};
