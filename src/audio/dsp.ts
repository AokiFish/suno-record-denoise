/**
 * v2 测量与辅助 DSP：本文件不再含降噪引擎。
 *
 * 降噪引擎 = FFmpeg afftdn（ffmpeg.wasm 单线程版，见 src/audio/ffmpegEngine.ts）。
 * v1 的手写谱减法（spectralSubtractChannel / learnNoiseProfile / processAudio）
 * 已删除，不留作备选。
 *
 * 本文件只剩纯函数（可在 Node/vitest 里数值测试，不依赖浏览器 API）：
 * - 测量：bandLevels / rmsDb / noiseFloorDb / countClipped / truePeakDbTp /
 *   checkSilence / computeMetrics（前后指标对比用）。
 * - 辅助：findQuietestWindow（自动噪声段）、silenceGateEnvelope + applySilenceGate
 *   （静音门，默认关；开时只在全频段 RMS < −60 dBFS 的段动作，淡入淡出 50 ms）、
 *   resampleLinear（wav.ts 用）。
 */
import { fftForward, hannWindow } from './fft';
import type { DenoiseMetrics } from './types';

const BAND_EDGES_HZ = [20, 60, 250, 500, 2000, 5000, 10000, 20000];

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

/**
 * 静音门（silence gate）包络：处理链的最后一级，可选。
 * 输入中 RMS < −60 dBFS 的静音段（连续 ≥200 ms），在段首留 100 ms
 *（滤波器衰减尾，G8 同款口径）后把输出压到 0，段尾用 50 ms 淡入恢复。
 * 50 ms 的淡入淡出长于 50 Hz 一个周期（20 ms），不会把低频首波切出咔哒声；
 * v1 的 10 ms 太短，已改掉。门只按输入的静音图动作，不碰任何有声段。
 */
export function silenceGateEnvelope(channels: Float32Array[], sampleRate: number): Float32Array {
  const n = channels[0].length;
  const env = new Float32Array(n).fill(1);
  const blockLen = Math.max(1, Math.floor(0.01 * sampleRate)); // 10 ms 检测块
  const fadeLen = Math.max(1, Math.floor(0.05 * sampleRate)); // 50 ms 淡入淡出
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
      const downEnd = Math.min(n, downStart + fadeLen);
      const upStart = e * blockLen;
      const upEnd = Math.min(n, upStart + fadeLen);
      for (let i = downStart; i < downEnd; i++) {
        env[i] = 1 - (i - downStart) / fadeLen;
      }
      for (let i = downEnd; i < upStart && i < n; i++) env[i] = 0;
      for (let i = upStart; i < upEnd; i++) {
        env[i] = (i - upStart) / fadeLen;
      }
    }
    b = e;
  }
  return env;
}

/** 对全部声道应用静音门包络（按输入信号的静音图；输出一份新数组）。 */
export function applySilenceGate(channels: Float32Array[], sampleRate: number): Float32Array[] {
  const env = silenceGateEnvelope(channels, sampleRate);
  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i] * env[i];
    return out;
  });
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
