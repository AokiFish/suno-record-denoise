import { readFileSync } from 'node:fs';

/** 只读 16-bit PCM WAV（ffmpeg / 本项目写盘的格式）。 */
export function readWav(path: string): {
  sampleRate: number;
  channels: number;
  data: Float32Array[];
} {
  const buf = readFileSync(path);
  const riff = buf.toString('ascii', 0, 4);
  if (riff !== 'RIFF') throw new Error(`not a WAV file: ${path}`);
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataStart = -1;
  let dataLen = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      const fmt = buf.readUInt16LE(offset + 8);
      if (fmt !== 1 && fmt !== 3) throw new Error(`unsupported WAV format ${fmt}: ${path}`);
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bits = buf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataStart = offset + 8;
      dataLen = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataStart < 0) throw new Error(`no data chunk: ${path}`);
  if (bits !== 16) throw new Error(`only 16-bit PCM supported, got ${bits}: ${path}`);
  const frames = Math.floor(dataLen / 2 / channels);
  const out: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let ch = 0; ch < channels; ch++) {
      out[ch][f] = buf.readInt16LE(dataStart + (f * channels + ch) * 2) / 32768;
    }
  }
  return { sampleRate, channels, data: out };
}
