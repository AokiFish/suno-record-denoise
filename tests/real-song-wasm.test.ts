/**
 * v2 真歌验收：wasm 线（ffmpeg.wasm 0.11.6 + core 0.11.0，Node 里经
 * require('@ffmpeg/core') 加载同一份 core 代码）。
 *
 * Node 环境说明：0.11.0 的 Emscripten core 在 Node 里仍用 fetch 取 .wasm，
 * 但传的是裸文件路径（不是 URL），Node 原生 fetch 会报 Invalid URL。
 * 下面的 fetch 垫片只拦截裸路径输入、用 fs 读盘并包成 application/wasm
 * 的 Response，其余 fetch 原样透传；它只解决 Node 取文件的问题，
 * 不改变任何 afftdn/滤镜/wasm 代码，浏览器里的真实路径不受影响。
 *
 * 跑的是出货链本身（processWithFfmpeg，默认强度 0.5 → nr 12 / nf −30，
 * 不采样），断言与 CLI 线同一套：
 * 噪声频段降 ≥6 dB、低频段（20–250 Hz）变化 <1 dB、中频段（500–2000 Hz）
 * 变化 <1 dB、无新增削波、静音段 <−50 dBFS。
 *
 * 注意：Node 里 core 从磁盘加载、单线程跑 42 s 立体声，耗时较长
 * （超时 300 s）；浏览器里首次加载约 25 MB、之后缓存。
 */
import { readFileSync } from 'node:fs';

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    const bytes = readFileSync(input);
    return new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } });
  }
  return nativeFetch(input as never, init as never);
}) as typeof fetch;

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bandLevels, checkSilence, computeMetrics, rmsDb } from '../src/audio/dsp';
import { processWithFfmpeg } from '../src/audio/ffmpegEngine';
import { readWav } from './wav-io';

const DIR = dirname(fileURLToPath(import.meta.url));
const FIX = join(DIR, 'fixtures', 'fixture42.wav');
const OUT = join(DIR, 'out');
const SR = 44100;

describe('真歌 afftdn（wasm 线）', () => {
  it('出货链 wasm 实测：指标表齐全', async () => {
    expect(existsSync(FIX)).toBe(true);
    mkdirSync(OUT, { recursive: true });

    const fixture = readWav(FIX);
    expect(fixture.sampleRate).toBe(SR);

    const t0 = Date.now();
    const { channels: outChannels, sampleRate: outRate } = await processWithFfmpeg(
      fixture.data,
      SR,
      { strength: 0.5, corePath: '@ffmpeg/core' },
    );
    const elapsedSec = (Date.now() - t0) / 1000;
    expect(outRate).toBe(44100);
    // 长度：wasm core（FFmpeg 5.1 系）收尾时比 CLI 8.1 少吐 1391 采样
    // （31.5 ms），缺的只在尾部——静音缺口起止采样三线完全一致、
    // 5–6 s 互相关滞后 3 采样，A/B 对齐不受影响。指标对比以前者长度截齐。
    const n = outChannels[0].length;
    expect(n).toBeLessThanOrEqual(42 * SR);
    expect(n).toBeGreaterThan(42 * SR - 4096);
    const fixTrim = fixture.data.map((c) => c.slice(0, n));

    const before = bandLevels(fixTrim, SR);
    const after = bandLevels(outChannels, SR);
    const absBefore = before.map((b) => b + rmsDb(fixTrim));
    const absAfter = after.map((b) => b + rmsDb(outChannels));
    const absDelta = absBefore.map((b, i) => Number((absAfter[i] - b).toFixed(2)));
    const lowBefore = 10 * Math.log10(10 ** (absBefore[0] / 10) + 10 ** (absBefore[1] / 10));
    const lowAfter = 10 * Math.log10(10 ** (absAfter[0] / 10) + 10 ** (absAfter[1] / 10));
    const lowDelta = Number((lowAfter - lowBefore).toFixed(2));
    const met = computeMetrics(fixTrim, outChannels, SR);
    const silence = checkSilence(fixTrim, outChannels, SR);

    console.log(`wasm 出货链（${elapsedSec.toFixed(1)} s）：abs band delta dB: ${absDelta.join(', ')} low 20–250 absΔ ${lowDelta} dB`);
    console.log(
      `noiseFloor ${met.noiseFloorBeforeDb.toFixed(2)} -> ${met.noiseFloorAfterDb.toFixed(2)} dBFS, ` +
        `SNR change ${met.snrChangeDb >= 0 ? '+' : ''}${met.snrChangeDb.toFixed(2)} dB, ` +
        `clipped ${met.clippedBefore} -> ${met.clippedAfter}, ` +
        `silence max ${silence.maxDb.toFixed(2)} dBFS (ok=${silence.ok})`,
    );

    expect(absDelta[5]).toBeLessThanOrEqual(-6); // brilliance 5–10k
    expect(absDelta[6]).toBeLessThanOrEqual(-6); // air 10–20k
    expect(Math.abs(lowDelta)).toBeLessThan(1);
    expect(Math.abs(absDelta[3])).toBeLessThan(1); // mid 500–2000
    expect(met.clippedAfter).toBe(met.clippedBefore);
    expect(silence.ok).toBe(true);
    expect(silence.maxDb).toBeLessThan(-50);

    writeFileSync(
      join(OUT, 'real-song-wasm-metrics.json'),
      JSON.stringify(
        {
          engine: 'ffmpeg.wasm 0.11.6 + @ffmpeg/core 0.11.0 (Node require)',
          chain: 'highpass=f=90,afftdn=nr=12:nf=-30',
          elapsedSec: Number(elapsedSec.toFixed(1)),
          outputSamples: n,
          inputSamples: 42 * SR,
          tailTrimNote: 'wasm core (FFmpeg 5.1) outputs 1391 fewer samples than CLI 8.1, all trimmed from the tail; head/mid sample-aligned (silence gap boundaries identical, 5-6s xcorr lag 3 samples)',
          absBandDeltaDb: absDelta,
          lowBand20_250AbsDeltaDb: lowDelta,
          noiseFloorBeforeDb: Number(met.noiseFloorBeforeDb.toFixed(2)),
          noiseFloorAfterDb: Number(met.noiseFloorAfterDb.toFixed(2)),
          snrChangeDb: Number(met.snrChangeDb.toFixed(2)),
          clippedBefore: met.clippedBefore,
          clippedAfter: met.clippedAfter,
          silenceOk: silence.ok,
          silenceMaxDb: Number(silence.maxDb.toFixed(2)),
        },
        null,
        2,
      ),
    );
  }, 300000);
});
