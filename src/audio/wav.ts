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
  /** data chunk 的起始字节偏移（遍历 sub-chunk 得到，含 LIST/fact 等）。 */
  dataOffset: number;
}

/**
 * 解析 WAV 头：遍历 sub-chunk，不假设 data 紧跟 fmt。
 * ffmpeg 的 wav muxer 会在 fmt 与 data 之间写 LIST-INFO（含 ISFT 编码器名），
 * 固定偏移 36 的解析会在 ffmpeg 产物上失败（已实测）。
 * 不支持非 PCM 时返回 null。
 */
export function parseWavHeader(bytes: Uint8Array): WavHeader | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (off: number, len: number) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  };
  if (bytes.length < 12 || str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') return null;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataBytes = 0;
  let dataOffset = -1;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = str(pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) return null;
      if (view.getUint16(body, true) !== 1) return null;
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataBytes = size;
      dataOffset = body;
      break;
    }
    pos = body + size + (size % 2); // chunk 按偶数对齐
  }
  if (channels === 0 || sampleRate === 0 || bits === 0 || dataOffset < 0) return null;
  const durationSec = dataBytes / (sampleRate * channels * (bits / 8));
  return { channels, sampleRate, bitsPerSample: bits, dataBytes, durationSec, dataOffset };
}

/**
 * 解码 16-bit PCM WAV（ffmpeg.wasm 的输出格式）为 Float32Array 声道。
 * data 位置以 parseWavHeader 遍历所得 dataOffset 为准（ffmpeg 会在中间写
 * LIST-INFO）；非 16-bit PCM 时抛错，不静默错解。
 */
export function decodePcm16Wav(bytes: Uint8Array): { channels: Float32Array[]; sampleRate: number } {
  const header = parseWavHeader(bytes);
  if (!header) throw new Error('decodePcm16Wav: not a PCM WAV file');
  if (header.bitsPerSample !== 16) {
    throw new Error(`decodePcm16Wav: expected 16-bit PCM, got ${header.bitsPerSample}-bit`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numChannels = header.channels;
  const numSamples = Math.floor(header.dataBytes / (2 * numChannels));
  const channels: Float32Array[] = Array.from({ length: numChannels }, () => new Float32Array(numSamples));
  let offset = header.dataOffset;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      channels[ch][i] = view.getInt16(offset, true) / 32768;
      offset += 2;
    }
  }
  return { channels, sampleRate: header.sampleRate };
}
