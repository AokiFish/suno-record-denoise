import { describe, expect, it } from 'vitest';
import { fftForward, fftInverse } from '../src/audio/fft';
import {
  applySilenceGate,
  computeMetrics,
  findQuietestWindow,
  rmsDb,
  silenceGateEnvelope,
} from '../src/audio/dsp';
import { buildFilterChain, strengthToNrNf } from '../src/audio/ffmpegEngine';
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

/** 主 fixture：3 秒噪声 + 1 kHz 正弦（全程有声）。 */
function makeFixture(): { channels: Float32Array[] } {
  const noise = pinkish(whiteNoise(3, 0.05, 42));
  const tone = sine(1000, 3, 0.25);
  const mix = new Float32Array(3 * SR);
  for (let i = 0; i < mix.length; i++) {
    mix[i] = noise[i] + tone[i];
  }
  // 双声道：右声道加 0.9 倍，避免完全相同
  const right = new Float32Array(mix.length);
  for (let i = 0; i < mix.length; i++) right[i] = mix[i] * 0.9;
  return { channels: [mix, right] };
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

/** 短静音 fixture：1 秒噪声+音 → 100 ms 静音 → 1 秒噪声+音（门不应动作）。 */
function makeShortSilenceFixture(): Float32Array[] {
  const noise = pinkish(whiteNoise(2.1, 0.05, 11));
  const tone = sine(1000, 2.1, 0.25);
  const n = Math.floor(2.1 * SR);
  const mix = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const inSilence = i >= SR && i < SR + Math.floor(0.1 * SR);
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

describe('静音门（默认关，v2 只剩这一级 JS 处理）', () => {
  it('全程有声：输出与输入逐采样相同（门不动有声段）', () => {
    const { channels } = makeFixture();
    const out = applySilenceGate(channels, SR);
    // 不逐采样 expect（26 万次断言在并行跑时会被 5 s 默认超时杀掉）：
    // 先算最大差，再一次断言。
    let maxDiff = 0;
    for (let c = 0; c < channels.length; c++) {
      for (let i = 0; i < channels[c].length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(out[c][i] - channels[c][i]));
      }
    }
    expect(maxDiff).toBe(0);
  });

  it('1 秒静音段：包络在段中为 0，淡入淡出各 50 ms（中点约 0.5）', () => {
    const channels = makeSilenceFixture();
    const env = silenceGateEnvelope(channels, SR);
    // 检测块 10 ms（441 采样），淡入淡出 50 ms（2205 采样）；
    // 静音块 100–199，下压起点 (100+10)*441=48510，恢复起点 200*441=88200。
    expect(env[0]).toBe(1);
    expect(env[48509]).toBe(1);
    expect(env[48510 + 1102]).toBeCloseTo(0.5, 2);
    expect(env[60000]).toBe(0);
    expect(env[88200]).toBe(0);
    expect(env[88200 + 1102]).toBeCloseTo(0.5, 2);
    expect(env[100000]).toBe(1);
    // 门后静音段中部确实为 0
    const out = applySilenceGate(channels, SR);
    expect(out[0][60000]).toBe(0);
    expect(out[0][1000]).toBe(channels[0][1000]);
  });

  it('100 ms 短静音：门不动作（要连续 ≥200 ms 才压）', () => {
    const channels = makeShortSilenceFixture();
    const env = silenceGateEnvelope(channels, SR);
    for (let i = 0; i < env.length; i += 1000) {
      expect(env[i]).toBe(1);
    }
    const out = applySilenceGate(channels, SR);
    let maxDiff = 0;
    for (let i = 0; i < channels[0].length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(out[0][i] - channels[0][i]));
    }
    expect(maxDiff).toBe(0);
  });
});

describe('滤镜串（FFmpeg afftdn，强度 → nr/nf）', () => {
  it('强度 0：只做 90 Hz 高通，不进 afftdn', () => {
    expect(buildFilterChain({ strength: 0 })).toBe('highpass=f=90');
    expect(strengthToNrNf(0)).toBeNull();
    expect(strengthToNrNf(-0.5)).toBeNull();
  });

  it('锚点与插值：0.25/0.5/0.75/1.0 对应 nr 6/12/20/30，nf 全程 −30', () => {
    expect(strengthToNrNf(0.25)).toEqual({ nr: 6, nf: -30 });
    expect(strengthToNrNf(0.5)).toEqual({ nr: 12, nf: -30 });
    expect(strengthToNrNf(0.75)).toEqual({ nr: 20, nf: -30 });
    expect(strengthToNrNf(1)).toEqual({ nr: 30, nf: -30 });
    expect(strengthToNrNf(1.5)).toEqual({ nr: 30, nf: -30 });
    expect(buildFilterChain({ strength: 0.5 })).toBe('highpass=f=90,afftdn=nr=12:nf=-30');
    expect(buildFilterChain({ strength: 0.25 })).toBe('highpass=f=90,afftdn=nr=6:nf=-30');
    expect(buildFilterChain({ strength: 0.75 })).toBe('highpass=f=90,afftdn=nr=20:nf=-30');
    expect(buildFilterChain({ strength: 1 })).toBe('highpass=f=90,afftdn=nr=30:nf=-30');
    // 0.375 在 0.25–0.5 锚点正中：nr=9，nf=−30
    expect(buildFilterChain({ strength: 0.375 })).toBe('highpass=f=90,afftdn=nr=9:nf=-30');
  });

  it('滤镜串不含 sn 采样（出货链不用采样，见 ffmpegEngine.ts 文件头）', () => {
    for (const s of [0.25, 0.5, 0.75, 1]) {
      const chain = buildFilterChain({ strength: s });
      expect(chain).not.toContain('asendcmd');
      expect(chain).not.toContain('sn start');
      expect(chain).not.toContain('sn stop');
    }
  });
});

describe('测量辅助', () => {
  it('同一信号前后对比：噪声底不变、信噪比变化 0、静音通过', () => {
    const channels = makeSilenceFixture();
    const met = computeMetrics(channels, channels, SR);
    expect(met.noiseFloorAfterDb).toBeCloseTo(met.noiseFloorBeforeDb, 6);
    expect(met.snrChangeDb).toBeCloseTo(0, 6);
    expect(met.spectralDistanceDb).toBeCloseTo(0, 6);
    expect(met.clippedAfter).toBe(met.clippedBefore);
    expect(met.silenceOk).toBe(true);
    expect(met.silenceMaxDb).toBeLessThan(-50);
    expect(rmsDb(channels)).toBeGreaterThan(-40);
  });

  it('自动噪声段落在最安静处附近', () => {
    const channels = makeSilenceFixture();
    const q = findQuietestWindow(channels, SR, 1);
    // 静音在 1–2 秒，最安静 1 秒窗口应与之重叠
    expect(q.endSec).toBeGreaterThan(1);
    expect(q.startSec).toBeLessThan(2);
  });
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
    const blob = encodeWav16(channels, SR);
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
    writeFileSync(join(dir, 'fixture.wav'), bytes);
  });
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
