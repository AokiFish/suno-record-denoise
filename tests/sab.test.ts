/**
 * v3 SAB 回归测试：无 SharedArrayBuffer 的浏览器（无 COOP/COEP 跨域隔离，
 * 如 Cloudflare Pages 默认配置）里，旧多线程 core 必须加载失败、
 * core-st 必须加载成功并跑通出货链。
 *
 * 背景（真机 bug，Luca 2026-11-16 14:49 亲眼看到）：
 * v2 用的 @ffmpeg/core@0.11.0 是多线程版，要 SharedArrayBuffer；无隔离的
 * 页面里根本没有这个对象，引擎一加载就报 "SharedArrayBuffer is not defined"，
 * 降噪恒失败。Node 自带 SharedArrayBuffer，所以 v2 的全部 Node 测试都过了、
 * 真机才炸——本文件就是补这个漏验。
 *
 * 做法：在 Node 里把 globalThis.SharedArrayBuffer 置 undefined（模拟无隔离
 * 浏览器），先加载旧 MT core（断言它失败，不对报错文案做断言——Node 里
 * 的报错文案与浏览器里不同，只断言失败本身），再加载 core-st 并在真歌
 * fixture 上跑出货链（默认强度 0.5 → nr 12 / nf −30，不采样），断言
 * 与 wasm 线同一套验收线。
 *
 * 模块隔离：两次加载用 vi.resetModules() + 动态 import 拿全新
 * ffmpegEngine 模块（loadFfmpeg 是模块级单例，不隔离会互相串）。
 * 旧 core 只在 devDependencies 里留作本测试的反例，永不打包进应用。
 *
 * Node 环境说明：core 在 Node 里仍用 fetch 取 .wasm，但传的是裸文件路径
 * （不是 URL），Node 原生 fetch 会报 Invalid URL。下面的 fetch 垫片只拦截
 * 裸路径输入、用 fs 读盘并包成 application/wasm 的 Response，其余 fetch
 * 原样透传；它只解决 Node 取文件的问题，不改变任何 afftdn/滤镜/wasm 代码，
 * 浏览器里的真实路径不受影响。
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

import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bandLevels, checkSilence, computeMetrics, rmsDb } from '../src/audio/dsp';
import { readWav } from './wav-io';

const DIR = dirname(fileURLToPath(import.meta.url));
const FIX = join(DIR, 'fixtures', 'fixture42.wav');
const SR = 44100;

describe('无 SharedArrayBuffer（模拟无隔离浏览器）', () => {
  it('旧 MT core 加载失败，core-st 加载成功并跑通真歌链', async () => {
    expect(existsSync(FIX)).toBe(true);
    const fixture = readWav(FIX);
    expect(fixture.sampleRate).toBe(SR);

    const sab = (globalThis as unknown as { SharedArrayBuffer: unknown }).SharedArrayBuffer;
    try {
      (globalThis as unknown as { SharedArrayBuffer: unknown }).SharedArrayBuffer = undefined;
      expect(typeof (globalThis as unknown as { SharedArrayBuffer: unknown }).SharedArrayBuffer).toBe('undefined');

      // 1. 旧多线程 core 必须失败（只断言失败，不对报错文案做断言）。
      const engMT = await import('../src/audio/ffmpegEngine');
      await expect(engMT.loadFfmpeg('@ffmpeg/core')).rejects.toThrow();

      // 2. core-st 必须加载成功，并跑通出货链。
      vi.resetModules();
      const engST = await import('../src/audio/ffmpegEngine');
      const t0 = Date.now();
      const { channels: outChannels, sampleRate: outRate } = await engST.processWithFfmpeg(
        fixture.data,
        SR,
        { strength: 0.5, corePath: '@ffmpeg/core-st' },
      );
      const elapsedSec = (Date.now() - t0) / 1000;
      expect(outRate).toBe(44100);
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

      console.log(
        `无 SAB 的 core-st 出货链（${elapsedSec.toFixed(1)} s）：abs band delta dB: ${absDelta.join(', ')} low 20–250 absΔ ${lowDelta} dB`,
      );
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
    } finally {
      (globalThis as unknown as { SharedArrayBuffer: unknown }).SharedArrayBuffer = sab;
    }
  }, 300000);
});
