import type { Dropout } from './dropouts';

export interface DenoiseSettings {
  /** 0..1，0.5 为默认。0 = 只做高通，不进 afftdn。 */
  strength: number;
  /** 高通截止频率 Hz，固定 90。 */
  highpassHz: number;
  /** 静音门开关，默认关。开时只在全频段 RMS < −60 dBFS 的段动作，淡入淡出 50 ms。 */
  silenceGate: boolean;
}

export interface DenoiseMetrics {
  noiseFloorBeforeDb: number;
  noiseFloorAfterDb: number;
  /** 处理后信噪比 − 处理前信噪比。 */
  snrChangeDb: number;
  /** 7 个频段相对电平的平均绝对差。 */
  spectralDistanceDb: number;
  truePeakBeforeDbTp: number;
  truePeakAfterDbTp: number;
  clippedBefore: number;
  clippedAfter: number;
  /** 静音段处理后是否仍 < −50 dBFS（每段开头 100 ms 不计）。 */
  silenceOk: boolean;
  silenceMaxDb: number;
}

export type RecordingSource = 'tab' | 'mic' | 'upload';

export interface DropoutRepairSummary {
  detected: number;
  repaired: number;
  unrepaired: number;
  gaps: Array<Dropout & { repaired: boolean }>;
}

export interface DropoutReport {
  /** 检出断点数 / 修了几个短缺口 / 几个长缺口未修。 */
  detected: number;
  repaired: number;
  unrepaired: number;
  /** 录制时 chunk 到达间隔 > 500 ms 的次数（上传文件没有）。 */
  recordingDropouts?: number;
  gaps: Array<Dropout & { repaired: boolean }>;
}

export interface RecordingMeta {
  id: string;
  title: string;
  createdAt: number;
  source: RecordingSource;
  durationSec: number;
  sampleRate: number;
  channels: number;
  mimeType: string;
  sizeBytes: number;
  /** 录制 chunk 统计（断点定位用；上传文件没有）。 */
  chunkCount?: number;
  totalBytes?: number;
  /** 录制时 chunk 到达间隔 > 500 ms 的次数（v4；上传文件没有）。 */
  dropoutCount?: number;
  /** 断点检出/修复统计（v4；打开工作台检出后写入）。 */
  dropoutRepair?: DropoutRepairSummary;
  settings: DenoiseSettings | null;
  metrics: DenoiseMetrics | null;
}

export interface DenoiseReport {
  app: 'suno-record-denoise';
  version: number;
  recordingId: string;
  title: string;
  createdAt: string;
  source: RecordingSource;
  input: { durationSec: number; sampleRate: number; channels: number };
  denoise: {
    method: 'FFmpeg afftdn';
    strength: number;
    highpassHz: number;
    silenceGate: boolean;
  };
  metrics: DenoiseMetrics;
  ab: { gainOriginalDb: number; gainProcessedDb: number; loudnessDiffLu: number };
  /** 断点检出/修复统计（v4，可选：老报告没有）。 */
  dropouts?: DropoutReport;
  warnings: string[];
  export: { format: 'wav'; sampleRate: number; bits: number };
  nextStep: string;
}
