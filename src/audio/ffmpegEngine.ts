/**
 * FFmpeg afftdn 引擎：滤镜串构造 + 强度映射。
 *
 * 算法来源（已核实）：
 * - FFmpeg libavfilter afftdn（2018 年加入，专业人士实际在用的 C 代码）：
 *   nr（0.01–97 dB，默认 12）、nf（−80 至 −20，默认 −50）、sn start/stop
 *   噪声采样（asendcmd 定时触发）。源码读过：FFmpeg 5.1（与 core-st 0.11.1
 *   同代）libavfilter/af_afftdn.c 全文。
 * - Audacity Noise Reduction（audacity/audacity src/effects/NoiseReduction.cpp）：
 *   音乐用了几十年的做法——先过一遍纯噪声统计各频带，再按频带给增益，
 *   超过阈值 0 dB、否则压低，然后时域平滑 + 频域平滑。noisereduce 的
 *   平稳谱门明确写着基于这个做法。
 * - 神经网络方案（RNNoise / DeepFilterNet）是人声模型，会把乐器当噪声吃掉，
 *   不用于音乐；纯神经音乐降噪论文有但无一是能装进浏览器的现成库 + 权重。
 *   所以浏览器里能落地的顶级方案是经典谱门做对，不是神经网络。
 *
 * 注意：只用 afftdn 在 CLI ffmpeg 8.1 与 ffmpeg.wasm core-st 0.11.1
 *（FFmpeg 5.1 系，Lavf 58.45.100）里都存在的选项：nr / nf / nt / bn /
 * rf / tn / tr / om / sn。ffmpeg 8.1 新增的 adaptivity / floor_offset /
 * noise_link / band_multiplier / gain_smooth 在 wasm core 里没有，不许用。
 *
 * 正名（v3，2026-11-16）：v2 用的 @ffmpeg/core@0.11.0 是多线程版，
 * 不是单线程版——它的 JS 里有 4 处 SharedArrayBuffer 引用，core-st 是
 * 0 处。v2 简报里“core 0.11.0 是单线程版”的说法是错的；Node 自带
 * SharedArrayBuffer，所以 v2 的全部 Node 测试都过了，真机（无 COOP/COEP
 * 隔离的页面）一加载就报 "SharedArrayBuffer is not defined"。v3 起出货
 * 核心是官方单线程版 @ffmpeg/core-st@0.11.1（钉死，不许用 ^ 浮动）。
 *
 * 实测结论（真歌 fixture，见 tests/real-song.test.ts 诊断 1–4 与
 * tests/real-song-wasm.test.ts；出货核心是 core-st，CLI 只作交叉对照）：
 * - 出货核心 core-st 0.11.1（FFmpeg 5.1 系）的 afftdn 与 CLI ffmpeg 8.1
 *   源码相同，但 nf 标定差约 20 dB（wasm nf=−30 ≈ CLI nf=−50 的效果），
 *   且采样谱形不同：CLI 采样谱峰 +14 dB@270 Hz，wasm 采样谱
 *   −1/0/0/−2/−4/−8/−12/−17/−22/−24…（高频段被压到 −24 限幅）。
 *   adaptivity/band_multiplier 两个 8.1 新选项已在 CLI 上逐一排除
 *   （ad=0、bm=1 均不改变结果），增益/采样源码 diff 无逻辑差异——
 *   差异在构建层，不在参数层。故 CLI 数字不能直接当出货数，
 *   出货链必须在 wasm 核心上标定。
 * - sn 采样在出货核心上不达标（v2 在 MT core 上测得，core-st 同源同码，
 *   出货链不用采样故 v3 未重测）：采样链最好成绩是 nf=−20/nr=30 的
 *   brill −5.10 dB（nf 已到上限 −20），仍低于验收线 6 dB；
 *   采样还会把低频段推过线（CLI 采样 nf=−30 时低频 −1.30 dB）。
 *   因此出货链不用 sn 采样（噪声段选择 UI 同步去掉，不留摆设控件），
 *   用默认白噪声谱形 + nf 标定。
 * - 不采样 nf=−30 梯子在双核心上都通过验收（绝对带电平 dB），core-st
 *   上重测（tests/ladder-st.tmp.test.ts，临时测试，跑完已删）：
 *   nr 6 → brill −4.58、nr 12 → −7.15、nr 20 → −8.60、
 *   nr 30 → −9.20，低频恒 −0.56、中频约 −0.01；
 *   CLI：nr 12 → brill −11.27、低频 −0.68。
 *   与 v2 在 MT core 上的梯子数逐值相差 ≤0.03 dB（舍入级），映射表不变。
 *   低频/中频变化只由 nf 决定（与 nr 无关），故 nf 锁在 −30。
 * - LR4 分频（250 Hz 以下直通）已实测否决：分频重构本身让低频段动 −2.40 dB
 *   （交叉区相位求和失配），比不分频的 −0.62 dB 更差，故删除。
 *   bn 自定义低频保护亦否决：采样会覆盖 bn（set_noise_profile 直接 memcpy），
 *   且在不采样链上 bn 与默认谱形结果完全相同（冗余）。
 * - wasm core 收尾比 CLI 少吐 1391 采样（31.5 ms），缺的只在尾部：
 *   静音缺口起止采样三线完全一致、5–6 s 互相关滞后 3 采样，
 *   A/B 对齐不受影响。core-st 上输出采样数与 MT core 逐值相同（1850809）。
 * - core-st 实例是单次运行的：main 返回后 Emscripten runtime 退出，
 *   同一实例第二次 run 会报 "Program terminated with exit(0)"（已实测；
 *   全局 Module.noExitRuntime 救不了，@ffmpeg/ffmpeg@0.11.6 也不透传
 *   noExitRuntime）。processWithFfmpeg 每次跑完即丢弃实例，下次调用
 *   重新加载（见 loadFfmpeg 注释）；连续跑两次的回归测试在
 *   tests/real-song-wasm.test.ts。
 * - core-st 必须配 mainName: 'main'：它只导出 `_main`，不导出多线程版
 *   的 `_proxy_main`（见 loadFfmpeg 注释）。
 *
 * wasm 加载与执行见本文件后半部分（loadFfmpeg / processWithFfmpeg）。
 * 引擎失败时如实抛错，不许悄悄切回旧的手写引擎（旧引擎已删除）。
 */

export const FFMPEG_ENGINE_LABEL = 'FFmpeg afftdn';
export const HIGHPASS_HZ = 90;

/**
 * 强度 → nr/nf 锚点表（分段线性插值；强度 0 = 只做高通，不进 afftdn）。
 * 在出货核心（core-st 0.11.1）上实测标定（真歌 fixture，绝对带电平 dB）：
 *   0.25 (nr 6, nf −30)：brill −4.58、air −5.85、低频 −0.56、中频 −0.01
 *   0.50 (nr 12, nf −30)：brill −7.15、air −11.11、低频 −0.56、中频 −0.01
 *   0.75 (nr 20, nf −30)：brill −8.60、air −15.59、低频 −0.56、中频 −0.01
 *   1.00 (nr 30, nf −30)：brill −9.20、air −17.52、低频 −0.56、中频 −0.01
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
 * 不用 sn 采样的原因见文件头：出货核心（core-st 5.1 系）上采样链最好成绩
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
// wasm 加载与执行（ffmpeg.wasm 0.11.6 + 官方单线程 core @ffmpeg/core-st@0.11.1，
// 钉死 0.11.1，不许用 ^ 浮动）。
// core 三件套（ffmpeg-core.js / .wasm / .worker.js，其中 worker.js 是 0 字节
// 占位文件）由 postinstall 从已装的 @ffmpeg/core-st 包拷到 public/ffmpeg/
//（scripts/fetch-ffmpeg-core.mjs），不入库；与 corePath 同目录、原名不动
//（loader 会按同名推导 wasm/worker 路径）。
// core-st 不用 SharedArrayBuffer，不用 COOP/COEP，纯静态托管就能跑。
// 正名（v3）：v2 用的 @ffmpeg/core@0.11.0 是多线程版，不是单线程版——
// 它的 JS 里有 4 处 SharedArrayBuffer 引用，core-st 是 0 处；v2 简报里
// “core 0.11.0 是单线程版”的说法是错的，正是这次真机报错的根源。
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
 * '@ffmpeg/core-st' 走 Node 的 require 加载（同一份 core-st 0.11.1 代码）。
 *
 * mainName 必须是 'main'：core-st 的 Emscripten 构建只导出 `_main`，
 * 不导出多线程版的 `_proxy_main`（已实地核对 core-st 的 JS：`_main` 3 处、
 * `_proxy_main` 0 处；多线程版反之）。不传它会报
 * "Cannot call unknown function proxy_main"。
 *
 * 注意：core-st 实例是单次运行的——main 返回后 Emscripten runtime 退出，
 * 同一实例第二次 run 会报 "Program terminated with exit(0)"（已实测，
 * 全局 Module.noExitRuntime 也救不了；@ffmpeg/ffmpeg@0.11.6 不透传
 * noExitRuntime）。所以 processWithFfmpeg 每次跑完都会丢弃实例
 * （见其 finally），下次调用重新加载；文件已缓存，只重建实例。
 */
export async function loadFfmpeg(corePath: string = FFMPEG_CORE_PATH): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  if (!loadPromise) {
    loadPromise = (async () => {
      const ffmpeg = createFFmpeg({ corePath, mainName: 'main', log: false });
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
  /** 覆盖 core 路径（默认 public/ffmpeg/ 本地 core；Node 测试传 '@ffmpeg/core-st'）。 */
  corePath?: string;
}

/**
 * 用 wasm 版 afftdn 跑完整处理链。单线程 core-st 跑在调用线程上（不起
 * pthread worker），长歌处理期间主线程会被占住，进度条可能跳变而非平滑
 * 推进——已知限制，见 PROGRESS.md。输入先编成 16-bit PCM WAV（统一 44.1 kHz）
 * 写进 MEMFS，输出同样是 16-bit PCM WAV，解回 Float32Array 声道（采样率
 * 以输出头为准）。失败时抛错（ffmpeg.run 非零退出、FS 读写失败、解码失败
 * 皆如此）。
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
    // core-st 单次运行：跑完必须丢弃实例（见 loadFfmpeg 注释），
    // 否则下一次 run 会报 Program terminated with exit(0)。
    // 本地 ffmpeg 句柄在丢弃后仍可用于清理 MEMFS。
    ffmpegInstance = null;
    loadPromise = null;
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
