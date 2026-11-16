export interface DenoiseSettings {
  /** 0..1，0.5 为默认。0 = 只做高通，不做谱减法。 */
  strength: number;
  /** 噪声学习段（秒），左闭右开。 */
  noiseStartSec: number;
  noiseEndSec: number;
  /** 高通截止频率 Hz，固定 90。 */
  highpassHz: number;
  /** 噪声段是否由“最安静帧”自动选出。 */
  autoNoise: boolean;
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
    method: 'spectral-subtraction + highpass';
    strength: number;
    highpassHz: number;
    noiseSegmentSec: [number, number];
    autoNoise: boolean;
  };
  metrics: DenoiseMetrics;
  ab: { gainOriginalDb: number; gainProcessedDb: number; loudnessDiffLu: number };
  warnings: string[];
  export: { format: 'wav'; sampleRate: number; bits: number };
  nextStep: string;
}
