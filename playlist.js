// Four track slots. Each has a default track (tracks/tracks.json: a real file, or a
// synthesized placeholder), and a visitor can drop their own over any slot:
//   - drop one file anywhere: it replaces the slot that's playing,
//   - drop several: they fill slots 1, 2, 3, 4 in order,
//   - drop onto a slot row (previewer): that slot.
// A visitor's own tracks are kept in their browser (IndexedDB), never uploaded, and never
// change the site for anyone else; "restore default" puts the slot's default back.
import { makeTestTrack } from './test_track.js';

export const SLOTS = 4;
const DB_NAME = 'shardburst';
const STORE = 'tracks';
const ACTIVE_KEY = 'shardburst.playlist.active';

// Browser storage can stall (a pending delete, some private modes): give up after 2 s so the
// default tracks still show; dropped tracks just aren't kept for that visit.
function idb() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('browser storage did not open')), 2000);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
    req.onerror = () => { clearTimeout(timer); reject(req.error); };
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const trackName = (file) => (file.name || 'TRACK').replace(/\.[^.]+$/, '').toUpperCase();

export class Playlist {
  constructor() {
    this.defaults = new Array(SLOTS).fill(null);   // { name, file?, synth? } from tracks.json
    this.custom = new Array(SLOTS).fill(null);     // { name, file } a visitor dropped
    this.cache = new Array(SLOTS).fill(null);      // default tracks once loaded (File)
    this.active = 1;
    this.db = null;
    this.listeners = [];
  }

  onChange(f) { this.listeners.push(f); }
  changed() { for (const f of this.listeners) f(this); }

  async open(configUrl = 'tracks/tracks.json') {
    try {
      // no-cache: check for a newer list every visit (GitHub Pages lets browsers reuse files for 10 min)
      const cfg = await fetch(configUrl, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null));
      (cfg?.slots || []).slice(0, SLOTS).forEach((d, i) => { this.defaults[i] = d; });
    } catch (e) {
      console.warn('playlist: no default tracks (tracks/tracks.json)', e);
    }
    try {
      this.db = await idb();
      for (let n = 1; n <= SLOTS; n++) {
        const rec = await tx(this.db, 'readonly', (s) => s.get(n));
        if (rec && rec.file) this.custom[n - 1] = { name: rec.name, file: rec.file };
      }
    } catch (e) {
      console.warn('playlist: browser storage unavailable, dropped tracks will not be kept', e);
    }
    let a = 1;
    try { a = Number(localStorage.getItem(ACTIVE_KEY) || 1); } catch (e) {}
    this.active = this.has(a) ? a : (this.firstFilled() || 1);
    this.changed();
    return this;
  }

  has(n) { return n >= 1 && n <= SLOTS && !!(this.custom[n - 1] || this.defaults[n - 1]); }
  isCustom(n) { return n >= 1 && n <= SLOTS && !!this.custom[n - 1]; }
  name(n) {
    if (!this.has(n)) return '';
    return this.custom[n - 1] ? this.custom[n - 1].name : (this.defaults[n - 1].name || 'TRACK ' + n);
  }
  defaultName(n) { return this.defaults[n - 1]?.name || ''; }
  firstFilled() { for (let n = 1; n <= SLOTS; n++) if (this.has(n)) return n; return 0; }

  // The audio for slot n: the visitor's own track, else the default (fetched or synthesized once).
  async file(n) {
    if (!this.has(n)) return null;
    if (this.custom[n - 1]) return this.custom[n - 1].file;
    if (this.cache[n - 1]) return this.cache[n - 1];
    const d = this.defaults[n - 1];
    let f = null;
    if (d.file) {
      try {
        const res = await fetch(d.file);
        if (res.ok) {
          const blob = await res.blob();
          f = new File([blob], d.file.split('/').pop(), { type: blob.type || 'audio/mpeg' });
        }
      } catch (e) { console.warn('playlist: could not load', d.file, e); }
    }
    if (!f) f = await makeTestTrack({ ...(d.synth || {}), name: (d.name || 'track') + '.wav' });
    this.cache[n - 1] = f;
    return f;
  }

  async put(n, file) {
    this.custom[n - 1] = { name: trackName(file), file };
    if (this.db) {
      try { await tx(this.db, 'readwrite', (s) => s.put({ name: trackName(file), file }, n)); }
      catch (e) { console.warn('playlist: could not save slot', n, e); }
    }
  }

  // Back to the slot's default track (or empty, for a slot with no default).
  async restore(n) {
    if (!this.isCustom(n)) return;
    this.custom[n - 1] = null;
    if (this.db) { try { await tx(this.db, 'readwrite', (s) => s.delete(n)); } catch (e) {} }
    if (this.active === n && !this.has(n)) this.active = this.firstFilled();
    this.changed();
  }

  setActive(n) {
    this.active = this.has(n) ? n : this.active;
    try { localStorage.setItem(ACTIVE_KEY, String(this.active)); } catch (e) {}
    this.changed();
  }

  // Which slots a drop of `count` files would fill (onto `start`, or the default rule).
  target(count, start = 0) {
    if (count <= 0) return [];
    if (count === 1) return [start || this.active || 1];
    const first = start || 1;
    const out = [];
    for (let k = 0; k < count && first + k <= SLOTS; k++) out.push(first + k);
    return out;
  }

  // Put dropped files into slots (see target). Returns the first slot that changed.
  async add(files, start = 0) {
    const audio = [...files].filter((f) => f && f.type && f.type.startsWith('audio')).slice(0, SLOTS);
    const slots = this.target(audio.length, start);
    for (let k = 0; k < slots.length; k++) await this.put(slots[k], audio[k]);
    if (slots.length) this.changed();
    return slots[0] || 0;
  }

  // What dropping `count` files would do, for the drop zone's hint.
  hint(count, start = 0) {
    const slots = this.target(count, start);
    if (!slots.length) return 'DROP AN AUDIO FILE';
    if (slots.length === 1) {
      const n = slots[0];
      return this.has(n) ? `DROP TO REPLACE TRACK ${n}  (${this.name(n)})` : `DROP TO ADD AS TRACK ${n}`;
    }
    return `DROP TO FILL TRACKS ${slots[0]}-${slots[slots.length - 1]}`;
  }
}
