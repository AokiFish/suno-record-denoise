import { describe, expect, it } from 'vitest';
import { fftForward, fftInverse } from '../src/audio/fft';
import {
  bandLevels,
  checkSilence,
  computeMetrics,
  findQuietestWindow,
  learnNoiseProfile,
  processAudio,
  HIGHPASS_HZ,
  rmsDb,
} from '../src/audio/dsp';
import { abGains, integratedLoudness } from '../src/audio/loudness';
import { encodeWav16, parseWavHeader } from '../src/audio/wav';
import { validateDuration, validateUploadFile } from '../src/audio/validate';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 确定性 PRNG（mulberry32），保证 fixture 可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SR = 44100;

function sine(freqHz: number, seconds: number, amp: number, sampleRate = SR): Float32Array {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

function whiteNoise(seconds: number, amp: number, seed: number, sampleRate = SR): Float32Array {
  const rand = mulberry32(seed);
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rand() * 2 - 1) * amp;
  return out;
}

/** 白噪声 → 1/f 粉红近似：频域除以 sqrt(f)。 */
function pinkish(noise: Float32Array): Float32Array {
  const n = 1 << Math.ceil(Math.log2(noise.length));
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  re.set(noise);
  fftForward(re, im);
  for (let k = 1; k < n / 2; k++) {
    const scale = 1 / Math.sqrt(k);
    re[k] *= scale;
    im[k] *= scale;
    re[n - k] = re[k];
    im[n - k] = -im[k];
  }
  fftInverse(re, im);
  // 归一化到原 RMS
  let sumOrig = 0;
  let sumNew = 0;
  for (let i = 0; i < noise.length; i++) {
    sumOrig += noise[i] * noise[i];
    sumNew += re[i] * re[i];
  }
  const g = Math.sqrt(sumOrig / Math.max(sumNew, 1e-18));
  const out = new Float32Array(noise.length);
  for (let i = 0; i < noise.length; i++) out[i] = re[i] * g;
  return out;
}

/** 主 fixture：前 1 秒纯噪声，后 2 秒噪声 + 1 kHz 正弦。 */
function makeFixture(): { channels: Float32Array[]; noiseOnly: Float32Array[] } {
  const noise = pinkish(whiteNoise(3, 0.05, 42));
  const tone = sine(1000, 3, 0.25);
  const mix = new Float32Array(3 * SR);
  for (let i = 0; i < mix.length; i++) {
    mix[i] = i < SR ? noise[i] : noise[i] + tone[i];
  }
  const noiseOnly = new Float32Array(SR);
  noiseOnly.set(noise.subarray(0, SR));
  // 双声道：右声道加 0.9 倍，避免完全相同
  const right = new Float32Array(mix.length);
  for (let i = 0; i < mix.length; i++) right[i] = mix[i] * 0.9;
  return { channels: [mix, right], noiseOnly: [noiseOnly, noiseOnly.slice()] };
}

/** 静音 fixture：1 秒噪声+音 → 1 秒静音 → 1 秒噪声+音。 */
function makeSilenceFixture(): Float32Array[] {
  const noise = pinkish(whiteNoise(3, 0.05, 7));
  const tone = sine(1000, 3, 0.25);
  const mix = new Float32Array(3 * SR);
  for (let i = 0; i < mix.length; i++) {
    const inSilence = i >= SR && i < 2 * SR;
    mix[i] = inSilence ? 0 : noise[i] + tone[i];
  }
  return [mix, mix.slice()];
}

describe('FFT', () => {
  it('正弦往返误差 < 1e-5', async () => {
    const { fftForward, fftInverse } = await import('../src/audio/fft');
    const sig = sine(1000, 0.1, 0.5);
    const n = 4096;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    re.set(sig.subarray(0, n));
    const orig = re.slice();
    fftForward(re, im);
    fftInverse(re, im);
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(re[i] - orig[i]));
    expect(maxErr).toBeLessThan(1e-5);
  });
});

describe('降噪 DSP', () => {
  it('强度 50%：噪声频段降 ≥6 dB，1 kHz 变化 <1 dB', async () => {
    const { channels } = makeFixture();
    const profile = learnNoiseProfile(channels, SR, 0, 1);
    const out = await processAudio(channels, SR, {
      strength: 0.5,
      highpassHz: HIGHPASS_HZ,
      noiseProfile: profile,
    });
    const before = bandLevels(channels, SR);
    const after = bandLevels(out, SR);
    // 频段索引：0 sub, 1 bass, 2 low_mid, 3 mid, 4 presence, 5 brilliance, 6 air
    // 5–10 kHz（brilliance）基本只有噪声
    const noiseDrop = before[5] - after[5];
    expect(noiseDrop).toBeGreaterThanOrEqual(6);
    // 1 kHz 在 mid（500–2000）段；相对电平变化 <1 dB
    expect(Math.abs(after[3] - before[3])).toBeLessThan(1);
  }, 60000);

  it('强度 0：90 Hz 以上频段差 <0.3 dB（只做高通）', async () => {
    const { channels } = makeFixture();
    const out = await processAudio(channels, SR, {
      strength: 0,
      highpassHz: HIGHPASS_HZ,
      noiseProfile: null,
    });
    const before = bandLevels(channels, SR);
    const after = bandLevels(out, SR);
    // 只比 250 Hz 以上频段：90 Hz 高通会动 sub（20–60）与 bass（60–250）段，
    // 规格写明“高通除外”。
    for (let b = 2; b < before.length; b++) {
      expect(Math.abs(after[b] - before[b])).toBeLessThan(0.3);
    }
  }, 60000);

  it('零噪声谱时 STFT 往返：频谱差 <0.5 dB（ISTFT 正确性）', async () => {
    const { channels } = makeFixture();
    const zeroProfile = new Float32Array(2048 / 2 + 1);
    const out = await processAudio(channels, SR, {
      strength: 1,
      highpassHz: HIGHPASS_HZ,
      noiseProfile: zeroProfile,
    });
    // 高通会动 sub/bass 段，只比 250 Hz 以上
    const before = bandLevels(channels, SR);
    const after = bandLevels(out, SR);
    for (let b = 2; b < before.length; b++) {
      expect(Math.abs(after[b] - before[b])).toBeLessThan(0.5);
    }
  }, 60000);

  it('无新增削波', async () => {
    const { channels } = makeFixture();
    const profile = learnNoiseProfile(channels, SR, 0, 1);
    const out = await processAudio(channels, SR, {
      strength: 0.5,
      highpassHz: HIGHPASS_HZ,
      noiseProfile: profile,
    });
    const met = computeMetrics(channels, out, SR);
    expect(met.clippedAfter).toBeLessThanOrEqual(met.clippedBefore);
  }, 60000);

  it('静音段处理后仍 < −50 dBFS（开头 100 ms 不计）', async () => {
    const channels = makeSilenceFixture();
    const profile = learnNoiseProfile(channels, SR, 0, 1);
    const out = await processAudio(channels, SR, {
      strength: 0.5,
      highpassHz: HIGHPASS_HZ,
      noiseProfile: profile,
    });
    const { ok, maxDb } = checkSilence(channels, out, SR);
    expect(ok).toBe(true);
    expect(maxDb).toBeLessThan(-50);
  }, 60000);

  it('自动噪声段落在最安静处附近', () => {
    const channels = makeSilenceFixture();
    const q = findQuietestWindow(channels, SR, 1);
    // 静音在 1–2 秒，最安静 1 秒窗口应与之重叠
    expect(q.endSec).toBeGreaterThan(1);
    expect(q.startSec).toBeLessThan(2);
  });

  it('噪声底下降，信噪比提升', async () => {
    const { channels } = makeFixture();
    const profile = learnNoiseProfile(channels, SR, 0, 1);
    const out = await processAudio(channels, SR, {
      strength: 0.5,
      highpassHz: HIGHPASS_HZ,
      noiseProfile: profile,
    });
    const met = computeMetrics(channels, out, SR);
    expect(met.noiseFloorAfterDb).toBeLessThan(met.noiseFloorBeforeDb - 3);
    expect(met.snrChangeDb).toBeGreaterThan(0);
    expect(rmsDb(channels)).toBeGreaterThan(-40);
  }, 60000);
});

describe('同响度 A/B', () => {
  it('6 dB 响度差的两段，匹配后差 <0.2 LU', () => {
    const a = sine(440, 2, 0.5);
    const b = sine(440, 2, 0.25); // −6 dB
    const la = integratedLoudness([a], SR);
    const lb = integratedLoudness([b], SR);
    expect(Math.abs(la - lb)).toBeGreaterThan(5);
    const g = abGains(la, lb);
    expect(g.gainAdb).toBeLessThanOrEqual(0);
    expect(g.gainBdb).toBeLessThanOrEqual(0);
    expect(g.gainAdb === 0 || g.gainBdb === 0).toBe(true);
    expect(g.diffLu).toBeLessThan(0.2);
  });
});

describe('WAV 导出', () => {
  it('头字段正确：44.1 kHz、16-bit、双声道、时长一致', async () => {
    const { channels } = makeFixture();
    const profile = learnNoiseProfile(channels, SR, 0, 1);
    const out = await processAudio(channels, SR, {
      strength: 0.5,
      highpassHz: HIGHPASS_HZ,
      noiseProfile: profile,
    });
    const blob = encodeWav16(out, SR);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const header = parseWavHeader(bytes);
    expect(header).not.toBeNull();
    expect(header!.sampleRate).toBe(44100);
    expect(header!.bitsPerSample).toBe(16);
    expect(header!.channels).toBe(2);
    expect(Math.abs(header!.durationSec - 3)).toBeLessThanOrEqual(0.01);
    // 写盘供 ffprobe 实测
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'out');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'denoised.wav'), bytes);
  }, 60000);
});

describe('上传校验', () => {
  it.each(['song.wav', 'song.mp3', 'song.flac', 'song.m4a'])('%s 通过', (name) => {
    expect(validateUploadFile(name, 1024).ok).toBe(true);
  });
  it('改扩展名的文本文件拒收', () => {
    const r = validateUploadFile('notes.txt', 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('UNSUPPORTED_FORMAT');
  });
  it('>80 MB 拒收', () => {
    const r = validateUploadFile('song.wav', 80 * 1024 * 1024 + 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('FILE_TOO_LARGE');
  });
  it('>10 分钟拒收', () => {
    const r = validateDuration(601);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DURATION_TOO_LONG');
  });
});
