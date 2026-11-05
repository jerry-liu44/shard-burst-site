// Audio analysis for Shard Burst (BRIEF section 9). Runs on the page, locally:
// a dropped file is decoded by the browser and never uploaded.
//
// Every frame, `analyse(dt)` returns smoothed 0-1 values:
//   bass (30-150 Hz), mid (150-2000 Hz), high (2-10 kHz), level (RMS loudness),
//   centroid (spectral centroid, 0-1 over 0-10 kHz), energy (overall drive)
// and `onset` (true on a detected transient: spectral flux below 2 kHz over an adaptive threshold)
// and `drop` (true when the bass slams back in after a quieter stretch).
//
// Each band is normalized by its own slowly decaying peak (auto gain), so quiet
// and loud tracks both use the full range. Fast attack, slower release.

const BANDS = { bass: [30, 150], mid: [150, 2000], high: [2000, 10000] };
// The equalizer: 48 bands, log-spaced from 40 Hz to 14 kHz (out.spectrum, 0-1 each).
export const SPECTRUM_BANDS = 48;
const SPEC_LO = 40, SPEC_HI = 14000;

// Host-side analysis settings (the previewer edits these; web/host_settings.json can override).
export const HOST_DEFAULTS = {
  onsetSensitivity: 1.6,   // standard deviations above the recent mean for a beat
  autoGain: 8,             // seconds for each band's auto gain to forget a loud peak
  bandCurve: 1.4,          // >1 keeps quiet parts quiet, <1 lifts them
  dropQuiet: 1.5,          // seconds of low bass before a big bass hit counts as a drop
  dropThreshold: 0.65,     // bass level (0-1) that ends the quiet stretch as a drop
  volume: 1.0,
};

export class AudioAnalyser {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.element = null;
    this.source = null;
    this.freq = null;
    this.prevMag = null;
    this.time = null;
    this.peaks = { bass: 1e-4, mid: 1e-4, high: 1e-4, level: 1e-4 };
    this.out = { bass: 0, mid: 0, high: 0, level: 0, centroid: 0, energy: 0.35, onset: false,
                 spectrum: new Float32Array(SPECTRUM_BANDS) };
    this.specPeaks = new Float32Array(SPECTRUM_BANDS).fill(1e-4);
    this.specRaw = new Float32Array(SPECTRUM_BANDS);
    this.flux = [];
    this.lastOnset = 0;
    this.clock = 0;
    this.settings = { ...HOST_DEFAULTS };
    this.quiet = 0;
    this.lastDrop = -10;
    this.gain = null;
  }

  // Must run from a user gesture (browser autoplay rules).
  ensureContext() {
    if (this.ctx) return this.ctx;
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.settings.volume;
    this.analyser.connect(this.gain);
    this.gain.connect(this.ctx.destination);
    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    this.prevMag = new Float32Array(this.analyser.frequencyBinCount);
    this.time = new Float32Array(this.analyser.fftSize);
    return this.ctx;
  }

  load(file) {
    if (this.element) { this.element.pause(); URL.revokeObjectURL(this.element.src); }
    this.element = new Audio(URL.createObjectURL(file));
    this.element.loop = true;
    this.source = null;        // connected on first play (needs the context)
    this.peaks = { bass: 1e-4, mid: 1e-4, high: 1e-4, level: 1e-4 };
  }

  setVolume(v) {
    this.settings.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  seek(fraction) {
    const e = this.element;
    if (e && e.duration) e.currentTime = Math.max(0, Math.min(0.999, fraction)) * e.duration;
  }

  get loaded() { return !!this.element; }
  get playing() { return !!this.element && !this.element.paused; }
  get progress() {
    const e = this.element;
    return e && e.duration ? e.currentTime / e.duration : 0;
  }

  async toggle() {
    if (!this.element) return false;
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    if (!this.source) {
      this.source = ctx.createMediaElementSource(this.element);
      this.source.connect(this.analyser);
    }
    if (this.element.paused) await this.element.play(); else this.element.pause();
    return this.playing;
  }

  // Each equalizer band (log-spaced, SPEC_LO..SPEC_HI): the loudest FFT bin inside it. The low
  // bands are narrower than one bin (about 23 Hz at 48 kHz), so a band with no bin of its own
  // reads the spectrum at its centre, between the two nearest bins: no bar sits dead.
  measureSpectrum(mags, hzPerBin) {
    if (this.specHz !== hzPerBin) {
      this.specHz = hzPerBin;
      this.specBins = [];
      const r = SPEC_HI / SPEC_LO;
      for (let b = 0; b < SPECTRUM_BANDS; b++) {
        const lo = SPEC_LO * Math.pow(r, b / SPECTRUM_BANDS) / hzPerBin;
        const hi = SPEC_LO * Math.pow(r, (b + 1) / SPECTRUM_BANDS) / hzPerBin;
        this.specBins.push([Math.ceil(lo), Math.min(mags.length - 1, Math.ceil(hi) - 1), Math.sqrt(lo * hi)]);
      }
    }
    const spec = this.specRaw;
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      const [i0, i1, c] = this.specBins[b];
      let v = 0;
      if (i1 >= i0) {
        for (let i = i0; i <= i1; i++) if (mags[i] > v) v = mags[i];
      } else {
        const i = Math.floor(c), t = c - i;
        v = mags[i] * (1 - t) + mags[Math.min(i + 1, mags.length - 1)] * t;
      }
      spec[b] = v;
    }
  }

  analyse(dt) {
    const o = this.out;
    const S = this.settings;
    o.onset = false;
    o.drop = false;
    this.clock += dt;
    if (!this.playing || !this.analyser) {
      // Idle: settle to a calm, slowly breathing state.
      const idle = 0.35 + 0.05 * Math.sin(this.clock * 0.7);
      for (const k of ['bass', 'mid', 'high', 'level']) o[k] = ease(o[k], 0, dt, 4);
      for (let b = 0; b < SPECTRUM_BANDS; b++) o.spectrum[b] = ease(o.spectrum[b], 0, dt, 4);
      o.energy = ease(o.energy, idle, dt, 2);
      return o;
    }
    const a = this.analyser;
    a.getFloatFrequencyData(this.freq);
    a.getFloatTimeDomainData(this.time);
    const hzPerBin = this.ctx.sampleRate / a.fftSize;

    // magnitudes, band energies, centroid, spectral flux
    let flux = 0, wsum = 0, csum = 0;
    const band = { bass: 0, mid: 0, high: 0 };
    const mags = this.mags || (this.mags = new Float32Array(this.freq.length));
    for (let i = 1; i < this.freq.length; i++) {
      const mag = Math.pow(10, this.freq[i] / 20);   // dBFS -> linear
      mags[i] = mag;
      const hz = i * hzPerBin;
      if (hz > 10000) continue;
      const d = mag - this.prevMag[i];
      if (d > 0 && hz < 2000) flux += d;   // onsets from the body of the mix (kicks, snares), not hats
      this.prevMag[i] = mag;
      wsum += mag; csum += mag * hz;
      for (const k in BANDS) if (hz >= BANDS[k][0] && hz < BANDS[k][1]) band[k] += mag * mag;
    }
    this.measureSpectrum(mags, hzPerBin);
    const spec = this.specRaw;
    let rms = 0;
    for (let i = 0; i < this.time.length; i++) rms += this.time[i] * this.time[i];
    rms = Math.sqrt(rms / this.time.length);

    const raw = { bass: Math.sqrt(band.bass), mid: Math.sqrt(band.mid), high: Math.sqrt(band.high), level: rms };
    for (const k in raw) {
      // auto gain: peak follows quickly up, decays over ~8 s
      this.peaks[k] = Math.max(raw[k], this.peaks[k] * Math.exp(-dt / Math.max(S.autoGain, 0.5)));
      const v = Math.min(1, raw[k] / (this.peaks[k] + 1e-9));
      const target = Math.pow(v, S.bandCurve);
      o[k] = target > o[k] ? ease(o[k], target, dt, 30) : ease(o[k], target, dt, 5);
    }
    // equalizer bands: each with its own auto gain, fast up, slower down
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      this.specPeaks[b] = Math.max(spec[b], this.specPeaks[b] * Math.exp(-dt / Math.max(S.autoGain, 0.5)));
      const v = Math.pow(Math.min(1, spec[b] / (this.specPeaks[b] + 1e-9)), S.bandCurve);
      o.spectrum[b] = v > o.spectrum[b] ? ease(o.spectrum[b], v, dt, 35) : ease(o.spectrum[b], v, dt, 7);
    }
    o.centroid = ease(o.centroid, Math.min(1, wsum > 0 ? csum / wsum / 10000 : 0), dt, 6);
    o.energy = ease(o.energy, Math.min(1, 0.2 + 0.55 * o.level + 0.35 * o.bass), dt, 8);

    // onset: low/mid flux above mean + 1.6 sd of the last ~1 s, at most 4 per second
    this.flux.push(flux);
    if (this.flux.length > 60) this.flux.shift();
    const mean = this.flux.reduce((s, x) => s + x, 0) / this.flux.length;
    const sd = Math.sqrt(this.flux.reduce((s, x) => s + (x - mean) * (x - mean), 0) / this.flux.length);
    if (this.flux.length > 20 && flux > mean + S.onsetSensitivity * sd && flux > mean * 1.3 &&
        this.clock - this.lastOnset > 0.25) {
      this.lastOnset = this.clock;
      o.onset = true;
    }

    // drop: a quieter stretch (low bass), then the bass slams back in
    if (o.bass < 0.3) this.quiet += dt;
    else if (o.bass > S.dropThreshold) {
      if (this.quiet > S.dropQuiet && this.clock - this.lastDrop > 4) {
        this.lastDrop = this.clock;
        o.drop = true;
      }
      this.quiet = 0;
    }
    return o;
  }
}

// Frame-rate independent exponential approach (rate per second).
function ease(from, to, dt, rate) {
  return from + (to - from) * (1 - Math.exp(-rate * dt));
}
