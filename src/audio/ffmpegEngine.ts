/**
 * FFmpeg afftdn 引擎：滤镜串构造 + 强度映射。
 *
 * 算法来源（已核实）：
 * - FFmpeg libavfilter afftdn（2018 年加入，专业人士实际在用的 C 代码）：
 *   nr（0.01–97 dB，默认 12）、nf（−80 至 −20，默认 −50）、sn start/stop
 *   噪声采样（asendcmd 定时触发）。源码读过：FFmpeg 5.1（与 wasm core
 *   0.11.0 同代）libavfilter/af_afftdn.c 全文。
 * - Audacity Noise Reduction（audacity/audacity src/effects/NoiseReduction.cpp）：
 *   音乐用了几十年的做法——先过一遍纯噪声统计各频带，再按频带给增益，
 *   超过阈值 0 dB、否则压低，然后时域平滑 + 频域平滑。noisereduce 的
 *   平稳谱门明确写着基于这个做法。
 * - 神经网络方案（RNNoise / DeepFilterNet）是人声模型，会把乐器当噪声吃掉，
 *   不用于音乐；纯神经音乐降噪论文有但无一是能装进浏览器的现成库 + 权重。
 *   所以浏览器里能落地的顶级方案是经典谱门做对，不是神经网络。
 *
 * 注意：只用 afftdn 在 CLI ffmpeg 8.1 与 ffmpeg.wasm core 0.11.0（FFmpeg 5.1
 * 系）里都存在的选项：nr / nf / nt / bn / rf / tn / tr / om / sn。
 * ffmpeg 8.1 新增的 adaptivity / floor_offset / noise_link / band_multiplier /
 * gain_smooth 在 wasm core 里没有，不许用。
 *
 * 实测结论（真歌 fixture，见 tests/real-song.test.ts 诊断 1–4 与
 * tests/real-song-wasm.test.ts；出货核心是 wasm，CLI 只作交叉对照）：
 * - 出货核心 wasm core 0.11.0（FFmpeg 5.1 系）的 afftdn 与 CLI ffmpeg 8.1
 *   源码相同，但 nf 标定差约 20 dB（wasm nf=−30 ≈ CLI nf=−50 的效果），
 *   且采样谱形不同：CLI 采样谱峰 +14 dB@270 Hz，wasm 采样谱
 *   −1/0/0/−2/−4/−8/−12/−17/−22/−24…（高频段被压到 −24 限幅）。
 *   adaptivity/band_multiplier 两个 8.1 新选项已在 CLI 上逐一排除
 *   （ad=0、bm=1 均不改变结果），增益/采样源码 diff 无逻辑差异——
 *   差异在构建层，不在参数层。故 CLI 数字不能直接当出货数，
 *   出货链必须在 wasm 核心上标定。
 * - sn 采样在出货核心上不达标：采样链最好成绩是 nf=−20/nr=30 的
 *   brill −5.10 dB（nf 已到上限 −20），仍低于验收线 6 dB；
 *   采样还会把低频段推过线（CLI 采样 nf=−30 时低频 −1.30 dB）。
 *   因此出货链不用 sn 采样（噪声段选择 UI 同步去掉，不留摆设控件），
 *   用默认白噪声谱形 + nf 标定。
 * - 不采样 nf=−30 梯子在双核心上都通过验收（绝对带电平 dB）：
 *   wasm：nr 6 → brill −4.56、nr 12 → −7.13、nr 20 → −8.58、
 *   nr 30 → −9.18，低频恒 −0.59、中频约 0.00；
 *   CLI：nr 12 → brill −11.27、低频 −0.68。
 *   低频/中频变化只由 nf 决定（与 nr 无关），故 nf 锁在 −30。
 * - LR4 分频（250 Hz 以下直通）已实测否决：分频重构本身让低频段动 −2.40 dB
 *   （交叉区相位求和失配），比不分频的 −0.62 dB 更差，故删除。
 *   bn 自定义低频保护亦否决：采样会覆盖 bn（set_noise_profile 直接 memcpy），
 *   且在不采样链上 bn 与默认谱形结果完全相同（冗余）。
 * - wasm core 收尾比 CLI 少吐 1391 采样（31.5 ms），缺的只在尾部：
 *   静音缺口起止采样三线完全一致、5–6 s 互相关滞后 3 采样，
 *   A/B 对齐不受影响。
 *
 * wasm 加载与执行见本文件后半部分（loadFfmpeg / processWithFfmpeg）。
 * 引擎失败时如实抛错，不许悄悄切回旧的手写引擎（旧引擎已删除）。
 */

export const FFMPEG_ENGINE_LABEL = 'FFmpeg afftdn';
export const HIGHPASS_HZ = 90;

/**
 * 强度 → nr/nf 锚点表（分段线性插值；强度 0 = 只做高通，不进 afftdn）。
 * 在出货核心（wasm core 0.11.0）上实测标定（真歌 fixture，绝对带电平 dB）：
 *   0.25 (nr 6, nf −30)：brill −4.56、air −5.83、低频 −0.59、中频 0.00
 *   0.50 (nr 12, nf −30)：brill −7.13、air −11.09、低频 −0.59、中频 0.00
 *   0.75 (nr 20, nf −30)：brill −8.58、air −15.56、低频 −0.59、中频 −0.00
 *   1.00 (nr 30, nf −30)：brill −9.18、air −17.50、低频 −0.59、中频 −0.00
 * 低频/中频变化只由 nf 决定（与 nr 无关），故 nf 全程锁在 −30，nr 负责深度。
 * 同一梯子在 CLI 8.1 上更强（nr 12：brill −11.27、低频 −0.68），双核心过线。
 */
const NR_NF_ANCHORS: Array<{ strength: number; nr: number; nf: number }> = [
  { strength: 0.25, nr: 6, nf: -30 },
  { strength: 0.5, nr: 12, nf: -30 },
  { strength: 0.75, nr: 20, nf: -30 },
  { strength: 1, nr: 30, nf: -30 },
];

export function strengthToNrNf(strength: number): { nr: number; nf: number } | null {
  if (strength <= 0) return null;
  const s = Math.min(1, strength);
  const pts = NR_NF_ANCHORS;
  if (s <= pts[0].strength) {
    const t = s / pts[0].strength;
    return { nr: pts[0].nr * t, nf: -80 + (pts[0].nf + 80) * t };
  }
  for (let i = 1; i < pts.length; i++) {
    if (s <= pts[i].strength) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = (s - a.strength) / (b.strength - a.strength);
      return { nr: a.nr + (b.nr - a.nr) * t, nf: a.nf + (b.nf - a.nf) * t };
    }
  }
  return { nr: pts[pts.length - 1].nr, nf: pts[pts.length - 1].nf };
}

function fmtN(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export interface FilterChainOptions {
  /** 0..1；0 = 只做高通，不进 afftdn。 */
  strength: number;
}

/**
 * 构造 afftdn 滤镜串：90 Hz 高通 → afftdn（默认白噪声谱形，不采样）。
 * 不用 sn 采样的原因见文件头：出货核心（wasm 5.1 系）上采样链最好成绩
 * brill −5.10 dB，达不到验收线 6 dB；低频保护由 nf=−30 上限保证，不分频。
 */
export function buildFilterChain(opts: FilterChainOptions): string {
  const hp = `highpass=f=${HIGHPASS_HZ}`;
  const nn = strengthToNrNf(opts.strength);
  if (!nn) return hp;
  const nr = fmtN(nn.nr);
  const nf = fmtN(nn.nf);
  return `${hp},afftdn=nr=${nr}:nf=${nf}`;
}

// ---------------------------------------------------------------------------
// wasm 加载与执行（ffmpeg.wasm 0.11.6 + core 0.11.0，单线程版）。
// core 三件套（ffmpeg-core.js / .wasm / .worker.js）由 postinstall 从已装的
// @ffmpeg/core 包拷到 public/ffmpeg/（scripts/fetch-ffmpeg-core.mjs），
// 不入库；与 corePath 同目录、原名不动（loader 会按同名推导 wasm/worker 路径）。
// 单线程 core 不用 SharedArrayBuffer，不用 COOP/COEP，纯静态托管就能跑。
// 加载失败时如实抛错，调用方展示错误；不许悄悄切回旧引擎（旧引擎已删除）。
// ---------------------------------------------------------------------------

import { createFFmpeg } from '@ffmpeg/ffmpeg';
import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { decodePcm16Wav, encodeWav16 } from './wav';

/** corePath：public/ffmpeg/ffmpeg-core.js（构建后在 dist/ffmpeg/ 同名）。 */
export const FFMPEG_CORE_PATH = '/ffmpeg/ffmpeg-core.js';

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

/**
 * 懒加载 ffmpeg.wasm：只在用户打开降噪工作台时调用（Workbench 里调）。
 * 单例：重复调用返回同一实例。加载失败时抛错并清除缓存的 promise，
 * 下次调用可重试；不吞错、不 fallback。
 * corePath 默认指向 public/ffmpeg/ 下的本地 core；Node 测试可传
 * '@ffmpeg/core' 走 Node 的 require 加载（同一份 core 0.11.0 代码）。
 */
export async function loadFfmpeg(corePath: string = FFMPEG_CORE_PATH): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  if (!loadPromise) {
    loadPromise = (async () => {
      const ffmpeg = createFFmpeg({ corePath, log: false });
      await ffmpeg.load();
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })().catch((err: unknown) => {
      loadPromise = null;
      throw err;
    });
  }
  return loadPromise;
}

export function isFfmpegLoaded(): boolean {
  return ffmpegInstance !== null;
}

export interface ProcessWithFfmpegOptions {
  /** 0..1；0 = 只做高通，不进 afftdn。 */
  strength: number;
  /** 运行进度（ffmpeg 的 time/duration 换算，0..1；加载阶段无进度）。 */
  onProgress?: (ratio: number) => void;
  /** 覆盖 core 路径（默认 public/ffmpeg/ 本地 core；Node 测试传 '@ffmpeg/core'）。 */
  corePath?: string;
}

/**
 * 用 wasm 版 afftdn 跑完整处理链，跑在 ffmpeg.wasm 自带的 Worker 里，
 * 不卡 UI。输入先编成 16-bit PCM WAV（统一 44.1 kHz）写进 MEMFS，
 * 输出同样是 16-bit PCM WAV，解回 Float32Array 声道（采样率以输出头为准）。
 * 失败时抛错（ffmpeg.run 非零退出、FS 读写失败、解码失败皆如此）。
 */
export async function processWithFfmpeg(
  channels: Float32Array[],
  sampleRate: number,
  opts: ProcessWithFfmpegOptions,
): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const ffmpeg = await loadFfmpeg(opts.corePath ?? FFMPEG_CORE_PATH);
  if (opts.onProgress) ffmpeg.setProgress(({ ratio }) => opts.onProgress?.(ratio));
  const chain = buildFilterChain({ strength: opts.strength });
  const inputBytes = new Uint8Array(await encodeWav16(channels, sampleRate).arrayBuffer());
  ffmpeg.FS('writeFile', 'input.wav', inputBytes);
  try {
    await ffmpeg.run('-i', 'input.wav', '-af', chain, '-c:a', 'pcm_s16le', 'output.wav');
    const outBytes = ffmpeg.FS('readFile', 'output.wav');
    return decodePcm16Wav(outBytes);
  } finally {
    try {
      ffmpeg.FS('unlink', 'input.wav');
    } catch {
      // 清理失败不影响结果
    }
    try {
      ffmpeg.FS('unlink', 'output.wav');
    } catch {
      // 清理失败不影响结果
    }
  }
}
