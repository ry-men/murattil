// Caractéristiques audio de Wav2Vec2-BERT (SeamlessM4TFeatureExtractor), recalculées à l'identique
// dans le navigateur : fbank 80 mel (Kaldi), normalisation par bande, empilement par 2 -> 160.
import MEL from "./mel.json";

const FRAME = 400, HOP = 160, NFFT = 512, NBIN = 257, NMEL = 80;
const WINDOW = Float32Array.from((MEL as { window: number[] }).window);
const FILTERS = (MEL as { filters: { start: number; w: number[] }[] }).filters.map((f) => ({ start: f.start, w: Float32Array.from(f.w) }));

// FFT radix-2 en place (taille 512), tables précalculées.
const COS = new Float64Array(NFFT / 2), SIN = new Float64Array(NFFT / 2);
for (let i = 0; i < NFFT / 2; i++) { COS[i] = Math.cos((2 * Math.PI * i) / NFFT); SIN[i] = -Math.sin((2 * Math.PI * i) / NFFT); }
const REV = new Uint16Array(NFFT);
for (let i = 0, bits = Math.log2(NFFT); i < NFFT; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); REV[i] = r; }

function fft(re: Float64Array, im: Float64Array) {
  for (let i = 0; i < NFFT; i++) { const j = REV[i]; if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1, step = NFFT / size;
    for (let i = 0; i < NFFT; i += size) {
      for (let j = 0; j < half; j++) {
        const k = j * step, a = i + j, b = a + half;
        const tr = re[b] * COS[k] - im[b] * SIN[k];
        const ti = re[b] * SIN[k] + im[b] * COS[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

/** Audio 16 kHz mono (-1..1) -> { data: T x 160 (ligne par ligne), frames: T }. */
export function extractFeatures(pcm: Float32Array): { data: Float32Array; frames: number } {
  const n = 1 + Math.floor((pcm.length - FRAME) / HOP);
  if (n < 2) return { data: new Float32Array(0), frames: 0 };
  const logmel = new Float64Array(n * NMEL);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT), buf = new Float64Array(FRAME);
  for (let f = 0; f < n; f++) {
    const off = f * HOP;
    let mean = 0;
    for (let i = 0; i < FRAME; i++) { buf[i] = pcm[off + i] * 32768; mean += buf[i]; }
    mean /= FRAME;
    for (let i = 0; i < FRAME; i++) buf[i] -= mean;
    for (let i = FRAME - 1; i >= 1; i--) buf[i] -= 0.97 * buf[i - 1];
    buf[0] *= 1 - 0.97;
    re.fill(0); im.fill(0);
    for (let i = 0; i < FRAME; i++) re[i] = buf[i] * WINDOW[i];
    fft(re, im);
    for (let m = 0; m < NMEL; m++) {
      const { start, w } = FILTERS[m];
      let s = 0;
      for (let k = 0; k < w.length; k++) { const b = start + k; s += w[k] * (re[b] * re[b] + im[b] * im[b]); }
      logmel[f * NMEL + m] = Math.log(Math.max(1.192092955078125e-07, s));
    }
  }
  // Normalisation par bande mel (moyenne nulle, variance unitaire, ddof = 1).
  for (let m = 0; m < NMEL; m++) {
    let mean = 0;
    for (let f = 0; f < n; f++) mean += logmel[f * NMEL + m];
    mean /= n;
    let v = 0;
    for (let f = 0; f < n; f++) { const d = logmel[f * NMEL + m] - mean; v += d * d; }
    const sd = Math.sqrt(v / (n - 1) + 1e-7);
    for (let f = 0; f < n; f++) logmel[f * NMEL + m] = (logmel[f * NMEL + m] - mean) / sd;
  }
  // Empilement par 2 : [trame 2k | trame 2k+1] -> 160 valeurs.
  const frames = Math.floor(n / 2);
  const data = new Float32Array(frames * NMEL * 2);
  for (let i = 0; i < frames * NMEL * 2; i++) data[i] = logmel[i];
  return { data, frames };
}
void NBIN;
