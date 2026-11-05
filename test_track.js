// Synthesized beats: a kick, off-beat hats and a bass drone, for trying the audio path
// without a file (?testtrack, the previewer's Test beat) and as the placeholder default
// tracks (tracks/tracks.json) until real ones are supplied. Options: bpm, bass (Hz),
// kick (Hz), secs, hats (0-1), drop (seconds of quiet then a big hit: exercises drops),
// name (the file name).
export async function makeTestTrack(opts = {}) {
  const { bpm = 120, bass = 55, kick = 120, secs = 8, hats = 0.3, drop = 0, name = 'test-beat.wav' } = opts;
  const sr = 44100;
  const off = new OfflineAudioContext(1, Math.round(sr * secs), sr);
  const beat = 60 / bpm;
  const quietFrom = drop > 0 ? secs - drop - beat * 2 : Infinity, quietTo = drop > 0 ? secs - beat * 2 : -1;
  const quiet = (t) => t >= quietFrom && t < quietTo;
  for (let t = 0; t < secs; t += beat) {
    if (quiet(t)) continue;
    const o = off.createOscillator(), g = off.createGain();
    const hit = drop > 0 && Math.abs(t - quietTo) < beat * 0.5 ? 1.6 : 0.9;
    o.frequency.setValueAtTime(kick, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    g.gain.setValueAtTime(Math.min(1, hit), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(off.destination);
    o.start(t); o.stop(t + 0.32);
  }
  if (hats > 0) {
    const noise = off.createBuffer(1, sr * 0.05, sr);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    for (let t = beat / 2; t < secs; t += beat) {
      if (quiet(t)) continue;
      const s = off.createBufferSource(), f = off.createBiquadFilter(), g = off.createGain();
      s.buffer = noise; f.type = 'highpass'; f.frequency.value = 6000; g.gain.value = hats;
      s.connect(f).connect(g).connect(off.destination);
      s.start(t);
    }
  }
  const b = off.createOscillator(), bg = off.createGain();
  b.type = 'sawtooth'; b.frequency.value = bass; bg.gain.value = 0.12;
  b.connect(bg).connect(off.destination);
  b.start(0);
  const data = (await off.startRendering()).getChannelData(0);
  return new File([encodeWav(data, sr)], name, { type: 'audio/wav' });
}

function encodeWav(data, sr) {
  const n = data.length;
  const v = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 32767, true);
  return v.buffer;
}
