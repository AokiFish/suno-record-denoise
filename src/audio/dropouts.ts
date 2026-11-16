/**
 * 断点检测与短缺口修复（v4，纯函数，可在 Node/vitest 里数值测试）。
 *
 * 背景：标签页播放一卡，录音里就出现断点——时间轴上的缺口，那段音乐
 * 直接没了。降噪（频谱上去杂音）不管这个；断点要单独检测 + 修复。
 *
 * 断点定义（常量见下，拿合成 fixture + 真歌 fixture 校准后定死）：
 * 一段采样绝对值持续低于阈值，且持续够久，且前后 0.5 s 都是有声的音乐，
 * 且进入缺口的能量跌落陡峭（10 ms 内掉下去）——这样前奏/尾奏/乐句间
 * 自然停顿与自然淡出都不算断点。
 *
 * 修复（缺口在录音里，不在降噪后；解码后、降噪前修一次）：
 * - ≤50 ms 短缺口：用缺口前后音频做线性交叉淡化填满——左源是缺口前
 *   音频的反向拷贝（在缺口起点恰好等于最后一个有声采样），右源是缺口后
 *   音频的反向拷贝（在缺口终点恰好等于第一个有声采样），权重在缺口内
 *   0→1 线性 ramp。边缘采样天然连续，不需要额外重叠淡化（加了反而会把
 *   另一侧的跳变按权重漏进来，见 PROGRESS.md）。
 * - >50 ms 长缺口：不填假内容，只在两边各做 5 ms 淡入/淡出杀掉咔哒声，
 *   其余原样——缺失的音乐找不回来。
 */

export interface Dropout {
  startSec: number;
  endSec: number;
  durationMs: number;
}

/** 断点判定常量（合成 fixture + 真歌 fixture 校准，见 PROGRESS.md v4 节）。 */
export const DROPOUT_THRESHOLD_DB = -60; // 缺口内采样绝对值上限（0.001 振幅）
export const DROPOUT_MIN_MS = 20; // 最短断点：20 ms（4×5 ms 判定窗）
export const DROPOUT_CONTEXT_SEC = 0.5; // 前后音乐上下文窗口
export const DROPOUT_CONTEXT_DB = -40; // 上下文 RMS 必须高于此值才算音乐
export const DROPOUT_FALL_RATIO = 0.5; // 跌落陡峭比：10 ms 内 vs 100–110 ms 前
export const DROPOUT_BRIDGE_MS = 2; // 缺口内低于 −50 dBFS 的毛刺可桥接的最长长度
export const DROPOUT_BRIDGE_DB = -50;
export const REPAIR_MAX_MS = 50; // 可修复的最长缺口
export const REPAIR_FADE_MS = 5; // 长缺口两边淡入/淡出长度

export interface DetectDropoutsOptions {
  thresholdDb?: number;
  minDurationMs?: number;
  contextSec?: number;
  contextDb?: number;
  fallRatio?: number;
  bridgeMs?: number;
  bridgeDb?: number;
}

function maxAbsRange(peak: Float32Array, start: number, end: number): number {
  let m = 0;
  for (let i = Math.max(0, start); i < Math.min(peak.length, end); i++) {
    if (peak[i] > m) m = peak[i];
  }
  return m;
}

function rmsDbRange(channels: Float32Array[], start: number, end: number): number {
  let sum = 0;
  let n = 0;
  for (const ch of channels) {
    for (let i = Math.max(0, start); i < Math.min(ch.length, end); i++) {
      sum += ch[i] * ch[i];
      n++;
    }
  }
  return 10 * Math.log10(Math.max(sum / Math.max(n, 1), 1e-12));
}

/**
 * 检出断点。返回按时间排序的缺口列表。
 * 判定链（缺一不可）：低于阈值持续 ≥minDurationMs；前后 0.5 s 上下文
 * RMS 都高于 contextDb；进入/离开缺口的能量跌落/回升陡峭（10 ms 内
 * 的峰值与 100–110 ms 前/后的峰值之比 > fallRatio）。
 */
export function detectDropouts(
  channels: Float32Array[],
  sampleRate: number,
  opts: DetectDropoutsOptions = {},
): Dropout[] {
  const n = channels[0]?.length ?? 0;
  if (n === 0 || channels.length === 0) return [];
  const threshold = Math.pow(10, (opts.thresholdDb ?? DROPOUT_THRESHOLD_DB) / 20);
  const bridgeThreshold = Math.pow(10, (opts.bridgeDb ?? DROPOUT_BRIDGE_DB) / 20);
  const minSamples = Math.floor(((opts.minDurationMs ?? DROPOUT_MIN_MS) / 1000) * sampleRate);
  const contextSamples = Math.floor((opts.contextSec ?? DROPOUT_CONTEXT_SEC) * sampleRate);
  const contextDb = opts.contextDb ?? DROPOUT_CONTEXT_DB;
  const fallRatio = opts.fallRatio ?? DROPOUT_FALL_RATIO;
  const bridgeSamples = Math.floor(((opts.bridgeMs ?? DROPOUT_BRIDGE_MS) / 1000) * sampleRate);
  const fallWin = Math.floor(0.01 * sampleRate); // 10 ms
  const fallBack = Math.floor(0.11 * sampleRate); // 110 ms

  // 各声道逐采样取最大绝对值（断点是全声道同时静默）。
  const peak = new Float32Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const v = Math.abs(ch[i]);
      if (v > peak[i]) peak[i] = v;
    }
  }

  // 采样级静默 run；缺口内低于 bridgeDb 的短毛刺（≤bridgeMs）桥接过去
  //（Opus 解码毛刺不该把一个缺口拆成两个）。
  const runs: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < n) {
    if (peak[i] >= threshold) {
      i++;
      continue;
    }
    const start = i;
    let end = i;
    while (end < n) {
      if (peak[end] < threshold) {
        end++;
        continue;
      }
      // 第一个非静默采样：往前看 bridgeSamples，是否回到静默且毛刺够小。
      let k = end;
      let maxBlip = 0;
      let backToSilent = false;
      while (k < n && k < end + bridgeSamples) {
        if (peak[k] > maxBlip) maxBlip = peak[k];
        if (peak[k] < threshold) {
          backToSilent = true;
          break;
        }
        k++;
      }
      if (backToSilent && maxBlip < bridgeThreshold) {
        end = k;
        continue;
      }
      break;
    }
    if (end - start >= minSamples) runs.push({ start, end });
    i = Math.max(end, start + 1);
  }

  const out: Dropout[] = [];
  for (const r of runs) {
    // 上下文：缺口前后各 0.5 s 必须都是有声的音乐（前奏/尾奏/乐句间停顿排除）。
    if (r.start < contextSamples || r.end + contextSamples > n) continue;
    const beforeDb = rmsDbRange(channels, r.start - contextSamples, r.start);
    const afterDb = rmsDbRange(channels, r.end, r.end + contextSamples);
    if (beforeDb < contextDb || afterDb < contextDb) continue;
    // 跌落陡峭：缺口前 10 ms 的峰值 vs 100–110 ms 前的峰值。
    const justBefore = maxAbsRange(peak, r.start - fallWin, r.start);
    const earlier = maxAbsRange(peak, r.start - fallBack, r.start - fallBack + fallWin);
    if (justBefore < threshold || earlier <= 0 || justBefore / earlier < fallRatio) continue;
    // 回升陡峭：缺口后 10 ms 的峰值 vs 100–110 ms 后的峰值。
    const justAfter = maxAbsRange(peak, r.end, r.end + fallWin);
    const later = maxAbsRange(peak, r.end + fallBack - fallWin, r.end + fallBack);
    if (justAfter < threshold || later <= 0 || justAfter / later < fallRatio) continue;
    out.push({
      startSec: r.start / sampleRate,
      endSec: r.end / sampleRate,
      durationMs: ((r.end - r.start) / sampleRate) * 1000,
    });
  }
  return out;
}

export interface GapRepairResult {
  gap: Dropout;
  repaired: boolean;
}

/**
 * 修短缺口。输入原声声道（不修改输入，返回新数组）。
 * - ≤maxMs：反向拷贝交叉淡化填满（见文件头），边缘采样天然连续。
 * - >maxMs：两边各 REPAIR_FADE_MS 淡入/淡出杀咔哒声，缺口内原样不动。
 */
export function repairShortGaps(
  channels: Float32Array[],
  sampleRate: number,
  gaps: Dropout[],
  maxMs: number = REPAIR_MAX_MS,
): {
  channels: Float32Array[];
  repaired: number;
  unrepaired: number;
  results: GapRepairResult[];
} {
  const out = channels.map((ch) => ch.slice());
  const n = channels[0]?.length ?? 0;
  let repaired = 0;
  let unrepaired = 0;
  const results: GapRepairResult[] = [];
  const fadeLen = Math.max(1, Math.floor((REPAIR_FADE_MS / 1000) * sampleRate));
  for (const gap of gaps) {
    const s = Math.round(gap.startSec * sampleRate);
    const e = Math.round(gap.endSec * sampleRate);
    const g = e - s;
    if (g <= 0 || s >= n || e <= 0) {
      results.push({ gap, repaired: false });
      unrepaired++;
      continue;
    }
    if (gap.durationMs <= maxMs) {
      for (let ch = 0; ch < out.length; ch++) {
        const src = channels[ch];
        const dst = out[ch];
        for (let t = 0; t < g; t++) {
          const w = g === 1 ? 1 : t / (g - 1);
          // 左源：缺口前音频反向拷贝，t=0 时恰好是最后一个有声采样；
          // 右源：缺口后音频反向拷贝，t=g-1 时恰好是第一个有声采样。
          const li = Math.max(0, s - 1 - t);
          const ri = Math.min(n - 1, e + (g - 1) - t);
          dst[s + t] = src[li] * (1 - w) + src[ri] * w;
        }
      }
      repaired++;
      results.push({ gap, repaired: true });
    } else {
      for (let ch = 0; ch < out.length; ch++) {
        const src = channels[ch];
        const dst = out[ch];
        for (let k = 0; k < fadeLen; k++) {
          const iBefore = s - fadeLen + k;
          if (iBefore >= 0) dst[iBefore] = src[iBefore] * (1 - k / fadeLen);
          const iAfter = e + k;
          if (iAfter < n) dst[iAfter] = src[iAfter] * ((k + 1) / fadeLen);
        }
      }
      unrepaired++;
      results.push({ gap, repaired: false });
    }
  }
  return { channels: out, repaired, unrepaired, results };
}

export interface ChunkDropoutStats {
  count: number;
  /** 每次断点的时刻（秒，相对录制开始）。 */
  timesSec: number[];
}

/**
 * 录制 chunk 到达时间戳分析（纯函数）：相邻 chunk 到达间隔超过
 * thresholdMs（默认 500 ms，期望节拍 250 ms 的 2 倍）即记一次断点，
 * 时刻取该间隔的中点（相对第一个时间戳）。
 */
export function analyzeChunkTimestamps(
  timestampsMs: number[],
  expectedIntervalMs = 250,
  thresholdMs = 500,
): ChunkDropoutStats {
  void expectedIntervalMs;
  const timesSec: number[] = [];
  if (timestampsMs.length === 0) return { count: 0, timesSec };
  const t0 = timestampsMs[0];
  for (let i = 1; i < timestampsMs.length; i++) {
    if (timestampsMs[i] - timestampsMs[i - 1] > thresholdMs) {
      timesSec.push((timestampsMs[i - 1] + timestampsMs[i]) / 2 / 1000 - t0 / 1000);
    }
  }
  return { count: timesSec.length, timesSec };
}
