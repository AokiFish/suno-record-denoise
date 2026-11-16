/**
 * 降噪 DSP：FFT 谱减法（功率域）+ 90 Hz 高通。
 * 全部为纯函数，可在 Node（vitest）里数值测试；不依赖浏览器 API。
 *
 * 做法：
 * 1. 时域先过二阶 Butterworth 高通（默认 90 Hz），去掉隆隆声。
 * 2. 强度为 0 时到此为止：只做高通，不碰频谱。
 * 3. 强度 > 0 时做 STFT：Hann 窗、帧长 2048、跳 512（75% 重叠），
 *    每频点功率减去 alpha 倍噪声功率，下限为原功率的 1%（最多压 20 dB），
 *    再 ISTFT 重叠相加。帧首尾各补一帧零，避免归一化分母过小导致的
 *    边缘爆音（分母下限钳制）。
 */
import { fftForward, fftInverse, hannWindow } from './fft';
import type { DenoiseMetrics } from './types';

export const FFT_SIZE = 2048;
export const HOP_SIZE = 512;
export const HIGHPASS_HZ = 90;

const BAND_EDGES_HZ = [20, 60, 250, 500, 2000, 5000, 10000, 20000];

/** RBJ 二阶高通滤波器系数。 */
function highpassCoefficients(freqHz: number, sampleRate: number): { b: number[]; a: number[] } {
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * 0.7071);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b: [((1 + cos) / 2 / a0), (-(1 + cos) / a0), ((1 + cos) / 2 / a0)],
    a: [1, ((-2 * cos) / a0), ((1 - alpha) / a0)],
  };
}

export function applyHighpass(samples: Float32Array, sampleRate: number, freqHz: number): Float32Array {
  const { b, a } = highpassCoefficients(freqHz, sampleRate);
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/**
 * 从 [startSec, endSec) 段学习噪声谱：只用完全落在段内的帧，
 * 每频点取功率中位数（抗音乐漏入）。返回每频点功率（0..fftSize/2）。
 */
export function learnNoiseProfile(
  channels: Float32Array[],
  sampleRate: number,
  startSec: number,
  endSec: number,
  fftSize: number = FFT_SIZE,
): Float32Array {
  const start = Math.floor(startSec * sampleRate);
  const end = Math.floor(endSec * sampleRate);
  const bins = fftSize / 2 + 1;
  const window = hannWindow(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const powers: number[][] = Array.from({ length: bins }, () => []);
  for (let ch = 0; ch < channels.length; ch++) {
    const data = channels[ch];
    for (let pos = start; pos + fftSize <= end; pos += HOP_SIZE) {
      for (let i = 0; i < fftSize; i++) {
        re[i] = data[pos + i] * window[i];
        im[i] = 0;
      }
      fftForward(re, im);
      for (let k = 0; k < bins; k++) {
        powers[k].push(re[k] * re[k] + im[k] * im[k]);
      }
    }
  }
  const profile = new Float32Array(bins);
  // 周期图功率服从指数分布，中位数 = 均值 × ln2；除以 ln2 得到均值噪声功率
  // 的无偏估计（只用中位数会系统性低估，导致谱减法减得不够）。
  const medianToMean = 1 / Math.LN2;
  for (let k = 0; k < bins; k++) {
    const arr = powers[k];
    if (arr.length === 0) {
      profile[k] = 0;
      continue;
    }
    arr.sort((a, b) => a - b);
    profile[k] = arr[Math.floor(arr.length / 2)] * medianToMean;
  }
  return profile;
}

/** 找 RMS 最低的 1 秒窗口（自动噪声段用）。 */
export function findQuietestWindow(
  channels: Float32Array[],
  sampleRate: number,
  windowSec = 1,
): { startSec: number; endSec: number } {
  const data = channels[0];
  const win = Math.floor(windowSec * sampleRate);
  const step = Math.floor(0.1 * sampleRate);
  let bestStart = 0;
  let bestRms = Infinity;
  for (let pos = 0; pos + win <= data.length; pos += step) {
    let sum = 0;
    for (let i = 0; i < win; i += 4) {
      const v = data[pos + i];
      sum += v * v;
    }
    const rms = sum / (win / 4);
    if (rms < bestRms) {
      bestRms = rms;
      bestStart = pos;
    }
  }
  return { startSec: bestStart / sampleRate, endSec: (bestStart + win) / sampleRate };
}

function spectralSubtractChannel(
  input: Float32Array,
  profile: Float32Array,
  alpha: number,
  fftSize: number,
  onProgress?: (p: number) => void,
): Float32Array {
  const hop = fftSize / 4;
  const bins = fftSize / 2 + 1;
  const window = hannWindow(fftSize);
  const paddedLen = input.length + 2 * fftSize;
  const padded = new Float32Array(paddedLen);
  padded.set(input, fftSize);
  const out = new Float32Array(paddedLen);
  const norm = new Float32Array(paddedLen);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const frameCount = Math.max(1, Math.floor((paddedLen - fftSize) / hop) + 1);
  const floorRatio = 0.01; // 每频点最多压 20 dB
  for (let f = 0; f < frameCount; f++) {
    const pos = f * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = padded[pos + i] * window[i];
      im[i] = 0;
    }
    fftForward(re, im);
    // 每频点增益：功率减法，下限为原功率的 1%（最多压 20 dB）。
    // 增益再做 ±2 bins 平滑：抑制“音乐噪声”，同时缩短等效滤波器
    // 的时域拖尾，减少 STFT 预回声（静音段尾部被后面声音污染）。
    const gain = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      const power = re[k] * re[k] + im[k] * im[k];
      const target = Math.max(power - alpha * profile[k], floorRatio * power);
      gain[k] = power > 1e-18 ? Math.sqrt(target / power) : 0;
    }
    const smooth = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, k - 2); j <= Math.min(bins - 1, k + 2); j++) {
        sum += gain[j];
        count++;
      }
      smooth[k] = sum / count;
    }
    for (let k = 0; k < bins; k++) {
      re[k] *= smooth[k];
      im[k] *= smooth[k];
      if (k > 0 && k < fftSize / 2) {
        re[fftSize - k] = re[k];
        im[fftSize - k] = -im[k];
      }
    }
    fftInverse(re, im);
    for (let i = 0; i < fftSize; i++) {
      out[pos + i] += re[i] * window[i];
      norm[pos + i] += window[i] * window[i];
    }
    if (onProgress && f % 64 === 0) onProgress(f / frameCount);
  }
  const result = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const denom = norm[i + fftSize];
    result[i] = denom > 1e-6 ? out[i + fftSize] / denom : 0;
  }
  return result;
}

/**
 * 静音门（silence gate）：处理链的最后一级。
 * 输入中 RMS < −60 dBFS 的静音段（连续 ≥200 ms），在段首留 100 ms
 *（滤波器衰减尾，G8 同款口径）后把输出压到 0，段尾用 10 ms 淡入
 * 恢复——代价是静音后恢复的声音前 10 ms 有淡入，实际听感可忽略。
 * 作用：STFT 预回声会把恢复的声音向静音尾部拖约一帧（46 ms），
 * 门把它拦住；静音段内部本来就该是静音，门只按输入的静音图动作，
 * 不碰任何有声段。没有这级门，1 秒静音段的尾部 100 ms 块会测到
 * 约 −45 dBFS；有门则为数字静音。
 */
export function silenceGateEnvelope(channels: Float32Array[], sampleRate: number): Float32Array {
  const n = channels[0].length;
  const env = new Float32Array(n).fill(1);
  const blockLen = Math.max(1, Math.floor(0.01 * sampleRate)); // 10 ms
  const nBlocks = Math.ceil(n / blockLen);
  const silent: boolean[] = [];
  for (let b = 0; b < nBlocks; b++) {
    let sum = 0;
    let cnt = 0;
    for (const ch of channels) {
      const end = Math.min(n, (b + 1) * blockLen);
      for (let i = b * blockLen; i < end; i += 2) {
        sum += ch[i] * ch[i];
        cnt++;
      }
    }
    silent.push(10 * Math.log10(Math.max(sum / Math.max(cnt, 1), 1e-12)) < -60);
  }
  let b = 0;
  while (b < nBlocks) {
    if (!silent[b]) {
      b++;
      continue;
    }
    let e = b;
    while (e < nBlocks && silent[e]) e++;
    if (e - b >= 20) {
      const downStart = (b + 10) * blockLen;
      const downEnd = downStart + blockLen;
      const upStart = e * blockLen;
      const upEnd = Math.min(n, upStart + blockLen);
      for (let i = downStart; i < downEnd && i < n; i++) {
        env[i] = 1 - (i - downStart) / blockLen;
      }
      for (let i = downEnd; i < upStart && i < n; i++) env[i] = 0;
      for (let i = upStart; i < upEnd; i++) {
        env[i] = (i - upStart) / blockLen;
      }
    }
    b = e;
  }
  return env;
}

export interface ProcessOptions {
  strength: number; // 0..1
  highpassHz: number;
  noiseProfile: Float32Array | null;
  fftSize?: number;
  onProgress?: (p: number) => void;
}

/**
 * 完整处理链：高通 →（强度 > 0 时）谱减法。
 * 同步跑完一个声道约几毫秒到几十毫秒；多声道分片跑，onProgress 回调进度。
 * 强度 0 时只做高通，原样返回频谱（测试断言 <0.3 dB 的依据）。
 */
export async function processAudio(
  channels: Float32Array[],
  sampleRate: number,
  opts: ProcessOptions,
): Promise<Float32Array[]> {
  const fftSize = opts.fftSize ?? FFT_SIZE;
  const alpha = opts.strength * 2;
  const gate = silenceGateEnvelope(channels, sampleRate);
  const out: Float32Array[] = [];
  for (let ch = 0; ch < channels.length; ch++) {
    const hp = applyHighpass(channels[ch], sampleRate, opts.highpassHz);
    let result: Float32Array;
    if (opts.strength <= 0 || !opts.noiseProfile) {
      result = hp;
    } else {
      result = spectralSubtractChannel(hp, opts.noiseProfile, alpha, fftSize, (p) =>
        opts.onProgress?.((ch + p) / channels.length),
      );
    }
    for (let i = 0; i < result.length; i++) result[i] *= gate[i];
    out.push(result);
    // 让出主线程，保持进度条与播放不卡死
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return out;
}

/** 7 个频段的平均能量（dB，相对整体 RMS），频段同 Audio Lab docs/02。 */
export function bandLevels(channels: Float32Array[], sampleRate: number): number[] {
  const fftSize = 4096;
  const window = hannWindow(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const bins = fftSize / 2 + 1;
  const power = new Float64Array(bins);
  let frames = 0;
  let totalPower = 0;
  for (const data of channels) {
    for (let pos = 0; pos + fftSize <= data.length; pos += fftSize) {
      for (let i = 0; i < fftSize; i++) {
        re[i] = data[pos + i] * window[i];
        im[i] = 0;
      }
      fftForward(re, im);
      for (let k = 0; k < bins; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        power[k] += p;
        totalPower += p;
      }
      frames++;
    }
  }
  if (frames === 0) return BAND_EDGES_HZ.slice(0, -1).map(() => -120);
  const levels: number[] = [];
  for (let b = 0; b < BAND_EDGES_HZ.length - 1; b++) {
    const lo = Math.floor((BAND_EDGES_HZ[b] / sampleRate) * fftSize);
    const hi = Math.min(bins, Math.ceil((BAND_EDGES_HZ[b + 1] / sampleRate) * fftSize));
    let sum = 0;
    for (let k = lo; k < hi; k++) sum += power[k];
    const rel = sum / Math.max(totalPower, 1e-18);
    levels.push(10 * Math.log10(Math.max(rel, 1e-12)));
  }
  return levels;
}

/** 100 ms 块 RMS（dBFS）序列。 */
export function blockRmsDb(channels: Float32Array[], sampleRate: number, blockSec = 0.1): number[] {
  const data = channels[0];
  const block = Math.floor(blockSec * sampleRate);
  const out: number[] = [];
  for (let pos = 0; pos + block <= data.length; pos += block) {
    let sum = 0;
    for (let ch = 0; ch < channels.length; ch++) {
      const d = channels[ch];
      for (let i = 0; i < block; i += 2) {
        const v = d[pos + i];
        sum += v * v;
      }
    }
    const mean = sum / (channels.length * (block / 2));
    out.push(10 * Math.log10(Math.max(mean, 1e-12)));
  }
  return out;
}

/** 噪声底：取 100 ms 块 RMS 的第 10 百分位。 */
export function noiseFloorDb(channels: Float32Array[], sampleRate: number): number {
  const blocks = blockRmsDb(channels, sampleRate);
  if (blocks.length === 0) return -120;
  const sorted = [...blocks].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.1)];
}

/** 整体 RMS（dBFS）。 */
export function rmsDb(channels: Float32Array[]): number {
  let sum = 0;
  let n = 0;
  for (const d of channels) {
    for (let i = 0; i < d.length; i += 2) {
      sum += d[i] * d[i];
      n++;
    }
  }
  return 10 * Math.log10(Math.max(sum / Math.max(n, 1), 1e-12));
}

export function countClipped(channels: Float32Array[]): number {
  let count = 0;
  for (const d of channels) {
    for (let i = 0; i < d.length; i++) {
      if (Math.abs(d[i]) >= 0.999) count++;
    }
  }
  return count;
}

/**
 * 真峰值（dBTP）：4 倍线性插值过采样后取最大绝对值。
 * 注：线性插值是估计值，不是多相滤波真峰值；页面指标处如实标注“估算”。
 */
export function truePeakDbTp(channels: Float32Array[]): number {
  let peak = 0;
  for (const d of channels) {
    for (let i = 0; i < d.length - 1; i++) {
      const a = d[i];
      const b = d[i + 1];
      for (let s = 0; s < 4; s++) {
        const v = Math.abs(a + ((b - a) * s) / 4);
        if (v > peak) peak = v;
      }
    }
  }
  return 20 * Math.log10(Math.max(peak, 1e-12));
}

/**
 * 静音检查：输入中 RMS < −60 dBFS 的 100 ms 块，在处理后是否仍 < −50 dBFS。
 * 每段静音的开头 100 ms 不计（滤波器衰减尾）。
 */
export function checkSilence(
  original: Float32Array[],
  processed: Float32Array[],
  sampleRate: number,
): { ok: boolean; maxDb: number } {
  const origBlocks = blockRmsDb(original, sampleRate);
  const procBlocks = blockRmsDb(processed, sampleRate);
  let maxDb = -120;
  let inSilence = false;
  let silenceStart = -1;
  for (let i = 0; i < origBlocks.length; i++) {
    if (origBlocks[i] < -60) {
      if (!inSilence) {
        inSilence = true;
        silenceStart = i;
      }
      // 跳过每段静音的第一个块（100 ms）
      if (i > silenceStart && procBlocks[i] !== undefined) {
        maxDb = Math.max(maxDb, procBlocks[i]);
      }
    } else {
      inSilence = false;
    }
  }
  return { ok: maxDb < -50, maxDb };
}

export function computeMetrics(
  original: Float32Array[],
  processed: Float32Array[],
  sampleRate: number,
): DenoiseMetrics {
  const floorBefore = noiseFloorDb(original, sampleRate);
  const floorAfter = noiseFloorDb(processed, sampleRate);
  const snrBefore = rmsDb(original) - floorBefore;
  const snrAfter = rmsDb(processed) - floorAfter;
  const bandsBefore = bandLevels(original, sampleRate);
  const bandsAfter = bandLevels(processed, sampleRate);
  let dist = 0;
  for (let i = 0; i < bandsBefore.length; i++) dist += Math.abs(bandsAfter[i] - bandsBefore[i]);
  dist /= bandsBefore.length;
  const silence = checkSilence(original, processed, sampleRate);
  return {
    noiseFloorBeforeDb: floorBefore,
    noiseFloorAfterDb: floorAfter,
    snrChangeDb: snrAfter - snrBefore,
    spectralDistanceDb: dist,
    truePeakBeforeDbTp: truePeakDbTp(original),
    truePeakAfterDbTp: truePeakDbTp(processed),
    clippedBefore: countClipped(original),
    clippedAfter: countClipped(processed),
    silenceOk: silence.ok,
    silenceMaxDb: silence.maxDb,
  };
}

/** 线性插值重采样（单声道）。 */
export function resampleLinear(channel: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return channel.slice();
  const ratio = fromRate / toRate;
  const outLen = Math.floor(channel.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = channel[idx] ?? 0;
    const b = channel[Math.min(idx + 1, channel.length - 1)] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
