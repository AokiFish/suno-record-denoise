import { resampleLinear } from './dsp';

/** 44.1 kHz、16-bit PCM WAV 编码（浏览器内完成，无需服务端）。 */
export function encodeWav16(channels: Float32Array[], sampleRate: number): Blob {
  const targetRate = 44100;
  const resampled = channels.map((ch) => resampleLinear(ch, sampleRate, targetRate));
  const numChannels = resampled.length;
  const numSamples = resampled[0].length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = targetRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const v = Math.max(-1, Math.min(1, resampled[ch][i]));
      view.setInt16(offset, Math.round(v * 32767), true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export interface WavHeader {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  durationSec: number;
}

/** 解析 WAV 头（测试用；不支持非 PCM 时返回 null）。 */
export function parseWavHeader(bytes: Uint8Array): WavHeader | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (off: number, len: number) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  };
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE' || str(12, 4) !== 'fmt ') return null;
  if (view.getUint16(20, true) !== 1) return null;
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  if (str(36, 4) !== 'data') return null;
  const dataBytes = view.getUint32(40, true);
  const durationSec = dataBytes / (sampleRate * channels * (bits / 8));
  return { channels, sampleRate, bitsPerSample: bits, dataBytes, durationSec };
}
