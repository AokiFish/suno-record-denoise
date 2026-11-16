import type {
  DenoiseMetrics,
  DenoiseReport,
  DenoiseSettings,
  DropoutReport,
  RecordingMeta,
} from './types';

export function buildReport(
  meta: RecordingMeta,
  settings: DenoiseSettings,
  metrics: DenoiseMetrics,
  ab: { gainOriginalDb: number; gainProcessedDb: number; loudnessDiffLu: number },
  dropouts?: DropoutReport,
): DenoiseReport {
  const warnings: string[] = [];
  if (metrics.clippedAfter > metrics.clippedBefore) {
    warnings.push('处理后削波点增多，请降低强度后重试。');
  }
  if (!metrics.silenceOk) {
    warnings.push('静音段被放大超过 −50 dBFS，请降低强度后重试。');
  }
  if (metrics.spectralDistanceDb > 3) {
    warnings.push('处理后频谱变化较大（>3 dB），可能已伤音色，请降低强度后重试。');
  }
  if (metrics.noiseFloorAfterDb > -50) {
    warnings.push('降噪后噪声底仍高于 −50 dBFS，杂音可能未除干净。');
  }
  if (dropouts && dropouts.unrepaired > 0) {
    warnings.push(
      `有 ${dropouts.unrepaired} 个长断点（>50 ms）未修复，缺失的音乐找不回来，建议重录。`,
    );
  }
  if (dropouts && dropouts.recordingDropouts !== undefined && dropouts.recordingDropouts > 0) {
    warnings.push(`录制时中断 ${dropouts.recordingDropouts} 次，录音里可能有断点。`);
  }
  return {
    app: 'suno-record-denoise',
    version: 1,
    recordingId: meta.id,
    title: meta.title,
    createdAt: new Date(meta.createdAt).toISOString(),
    source: meta.source,
    input: {
      durationSec: meta.durationSec,
      sampleRate: meta.sampleRate,
      channels: meta.channels,
    },
    denoise: {
      method: 'FFmpeg afftdn',
      strength: settings.strength,
      highpassHz: settings.highpassHz,
      silenceGate: settings.silenceGate,
    },
    metrics,
    ab,
    dropouts,
    warnings,
    export: { format: 'wav', sampleRate: 44100, bits: 16 },
    nextStep: '把导出的 WAV 上传到 Audio Lab，选想要的声音做增效。',
  };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadJson(data: unknown, filename: string): void {
  downloadBlob(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    filename,
  );
}
