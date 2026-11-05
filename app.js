// Shard Burst host page: loads the signed .riv, owns the file drop and playback,
// and writes audio analysis into the view model (BRIEF sections 2 and 9).
// Rive owns everything you see, including the drop-zone states.
import { AudioAnalyser, HOST_DEFAULTS, SPECTRUM_BANDS } from './audio.js';
import { makeTestTrack } from './test_track.js';
import { Playlist, SLOTS } from './playlist.js';

const canvas = document.getElementById('stage');
const audio = new AudioAnalyser();
const playlist = new Playlist();
let r = null;
let vm = null;
const props = {};

// ---------------------------------------------------------------- view model

function bindViewModel(instance) {
  vm = instance;
  for (const n of ['energy', 'bass', 'mid', 'high', 'level', 'progress', 'rotationSpeed']) props[n] = vm.number(n);
  for (const n of ['form', 'theme', 'qualityTier', 'audioState']) props[n] = vm.enum(n);
  props.trackName = vm.string('trackName');
  props.accent = vm.color('accent');
  props.showDebug = vm.boolean('showDebug');
  props.transient = vm.trigger('transient');
  props.drop = vm.trigger('drop');
  props.playToggle = vm.trigger('playToggle');
  props.playToggle?.on(togglePlay);
  // playlist: the Hud's TRACK buttons write playlist/slot
  props.slot = vm.number('playlist/slot');
  for (let n = 1; n <= SLOTS; n++) {
    props['name' + n] = vm.string('playlist/name' + n);
    props['has' + n] = vm.boolean('playlist/has' + n);
  }
  // equalizer bands, and the Timeline's scrub (seekTo, then seek fires)
  props.bands = [];
  for (let b = 1; b <= SPECTRUM_BANDS; b++) props.bands.push(vm.number('spectrum/b' + b));
  props.seekTo = vm.number('seekTo');
  vm.trigger('seek')?.on(() => { if (props.seekTo) audio.seek(props.seekTo.value); write('progress', audio.progress, 0); });
  props.custom = vm.boolean('playlist/custom');
  props.dropHint = vm.string('playlist/dropHint');
  vm.trigger('playlist/restore')?.on(() => restoreSlot(playlist.active));
  playlist.open().then(() => { if (playlist.active) selectSlot(playlist.active, false); });
  if (props.showDebug) props.showDebug.value = new URLSearchParams(location.search).has('debug');
  syncBackground();
  for (const f of readyListeners) f(vm);
}
const readyListeners = [];

// Skip writes that would not change anything visibly (BRIEF section 6).
const last = {};
function write(name, value, eps = 0.003) {
  const p = props[name];
  if (!p || (last[name] !== undefined && Math.abs(last[name] - value) < eps)) return;
  p.value = value;
  last[name] = value;
}

function setEnum(name, value) {
  if (props[name] && props[name].value !== value) props[name].value = value;
}

// The page behind the canvas matches the backdrop's base colour (tuning > Backdrop) so
// resizes never flash.
function baseColor() {
  const light = props.theme?.value === 'light';
  const p = vm?.color(light ? 'tuning/bgLightBase' : 'tuning/bgDarkBase');
  if (!p) return light ? '#e9e7e2' : '#060608';
  return '#' + (p.value >>> 0).toString(16).padStart(8, '0').slice(2);
}
let lastBase = '';
function syncBackground() {
  const c = baseColor();
  if (c !== lastBase) { lastBase = c; document.documentElement.style.background = c; }
}

// ---------------------------------------------------------------- audio

async function togglePlay() {
  if (!audio.loaded) return;
  const playing = await audio.toggle();
  setEnum('audioState', playing ? 'playing' : 'paused');
}

// Play slot n (1-4). Keeps playing if something was playing, unless play says otherwise.
// An empty slot is ignored and the buttons go back to the playing slot.
async function selectSlot(n, play = audio.playing) {
  if (!playlist.has(n)) { writePlaylist(); return; }
  const file = await playlist.file(n);
  if (!file) { writePlaylist(); return; }
  audio.load(file);
  playlist.setActive(n);
  if (props.trackName) props.trackName.value = playlist.name(n);
  setEnum('audioState', 'loaded');
  if (play) await togglePlay();
}

// Put slot n's default track back (the Hud's RESTORE DEFAULT, the previewer's ↺).
async function restoreSlot(n) {
  if (!playlist.isCustom(n)) return;
  const wasPlaying = audio.playing;
  await playlist.restore(n);
  if (n === playlist.active) await selectSlot(n, wasPlaying);
}

// Mirror the playlist into the view model (names, which slots hold a track, the active one).
function writePlaylist() {
  for (let n = 1; n <= SLOTS; n++) {
    if (props['name' + n]) props['name' + n].value = playlist.name(n);
    if (props['has' + n]) props['has' + n].value = playlist.has(n);
  }
  if (props.custom) props.custom.value = playlist.isCustom(playlist.active);
  if (props.slot && Math.round(props.slot.value) !== playlist.active) props.slot.value = playlist.active;
}
playlist.onChange(writePlaylist);

// Dropped or chosen files go into the playlist (see playlist.js for which slots), then the
// first one that changed plays (or waits for a click, if nothing was playing).
async function loadFiles(files, start = 0) {
  const n = await playlist.add(files, start);
  if (!n) { setEnum('audioState', audio.loaded ? (audio.playing ? 'playing' : 'paused') : 'empty'); return; }
  await selectSlot(n);
}
const loadFile = (file, start = 0) => loadFiles([file], start);

// The whole window is the drop target; Rive draws the hover state.
let dragDepth = 0;
// What the drop will do, shown in the drop zone while dragging ("DROP TO REPLACE TRACK 2 ...").
function dropCount(e) {
  const items = e.dataTransfer?.items;
  if (!items) return 1;
  return [...items].filter((i) => i.kind === 'file' && (!i.type || i.type.startsWith('audio'))).length || 1;
}
function showDropHint(e, start = 0) {
  if (props.dropHint) props.dropHint.value = playlist.hint(dropCount(e), start);
}
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (dragDepth++ === 0) { showDropHint(e); setEnum('audioState', 'hover'); }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  if (--dragDepth === 0) setEnum('audioState', audio.loaded ? (audio.playing ? 'playing' : 'paused') : 'empty');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  loadFiles(e.dataTransfer.files);     // a drop on a previewer slot row stops before here
});

// The Hud changes some things itself (TRACK and THEME buttons); follow them once a frame.
let lastTheme = null;
let bgCheck = 0;
let switching = false;
function watchViewModel() {
  const t = props.theme?.value;
  if (t !== lastTheme) { lastTheme = t; syncBackground(); }
  if ((++bgCheck & 15) === 0) syncBackground();     // a base colour edited in the previewer
  if (props.slot && !switching) {
    const n = Math.round(props.slot.value);
    if (n !== playlist.active) {
      switching = true;
      selectSlot(n).finally(() => { switching = false; });
    }
  }
}

// Per frame: analysis -> view model.
const frameListeners = [];
let prev = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  if (vm) {
    const a = audio.analyse(dt);
    write('energy', a.energy);
    write('bass', a.bass);
    write('mid', a.mid);
    write('high', a.high);
    write('level', a.level);
    if (a.onset) props.transient?.trigger();
    if (a.drop) props.drop?.trigger();
    for (const f of frameListeners) f(a, dt);
    watchViewModel();
    write('progress', audio.progress, 0.0005);
    if (props.bands) {
      for (let b = 0; b < props.bands.length; b++) {
        const p = props.bands[b];
        const v = a.spectrum[b];
        if (p && Math.abs(p.value - v) > 0.004) p.value = v;
      }
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------- controls

// Keys: space play/pause, F form, T theme, Q quality tier, D debug panel, 1-4 track slots.
window.addEventListener('keydown', (e) => {
  if (!vm || e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  if (k === 'f') setEnum('form', props.form.value === 'radial' ? 'thrust' : 'radial');
  if (k === 't') { setEnum('theme', props.theme.value === 'dark' ? 'light' : 'dark'); syncBackground(); }
  if (k === 'q') setEnum('qualityTier', props.qualityTier.value === 'low' ? 'high' : 'low');
  if (k === 'd' && props.showDebug) props.showDebug.value = !props.showDebug.value;
  if (k >= '1' && k <= String(SLOTS)) selectSlot(Number(k));
});

// Accent picker (the brief: the accent colour is user-editable).
document.getElementById('accent')?.addEventListener('input', (e) => {
  const hex = e.target.value.replace('#', '');
  props.accent?.rgb(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16));
});

// Throttle: stop rendering while the tab is hidden (BRIEF section 8).
document.addEventListener('visibilitychange', () => {
  if (!r) return;
  if (document.hidden) r.stopRendering(); else r.startRendering();
});

// ---------------------------------------------------------------- Rive

function fit() { r?.resizeDrawingSurfaceToCanvas(); }

r = new rive.Rive({
  // ?riv=<name> loads web/riv/<name>.riv instead (for comparing builds)
  src: 'riv/' + (new URLSearchParams(location.search).get('riv') || 'shard_burst').replace(/[^\w-]/g, '') + '.riv',
  canvas,
  stateMachine: 'State Machine 1',
  autoplay: true,
  autoBind: true,
  enableGPUCanvas: true,
  layout: new rive.Layout({ fit: rive.Fit.Layout }),
  onLoad: () => {
    fit();
    bindViewModel(r.viewModelInstance);
    document.body.classList.add('ready');
    if (new URLSearchParams(location.search).has('testtrack')) makeTestTrack().then(loadFile);
  },
  onLoadError: (e) => { document.getElementById('status').textContent = 'Could not load the .riv: ' + e; },
});
window.addEventListener('resize', fit);
new ResizeObserver(fit).observe(canvas);

// Optional saved analysis settings (written by tools/rive/apply_preset.py from a previewer export).
fetch('host_settings.json').then((res) => res.ok ? res.json() : null)
  .then((s) => { if (s) Object.assign(audio.settings, s); audio.setVolume(audio.settings.volume); })
  .catch(() => {});

// For the previewer, the console and tests.
window.shardBurst = {
  rive: () => r, vm: () => vm, audio, playlist, loadFile, loadFiles, selectSlot, restoreSlot, showDropHint,
  togglePlay, setEnum, syncBackground, HOST_DEFAULTS,
  onReady: (f) => { if (vm) f(vm); else readyListeners.push(f); },
  onFrame: (f) => frameListeners.push(f),
};
