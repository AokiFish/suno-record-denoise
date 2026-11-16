/**
 * v2 真歌验收：CLI ffmpeg（与 wasm 同款 libavfilter 代码）先跑 afftdn 滤镜串，
 * 在真歌 fixture 上测数，数达标了再接进网页。
 *
 * fixture（见 tests/eval/build-fixture.py）：
 * 贝多芬《月光奏鸣曲》第一乐章钢琴演奏（Wikimedia Commons，CC BY-SA 4.0），
 * 10–50 s 选段 + 粉红噪声至 −20 dB SNR，42 s：[0–1 s 纯噪声][1–21 s 歌+噪]
 * [21–22 s 数字静音][22–42 s 歌+噪]。
 *
 * 本文件只测 CLI 线；wasm 线见 tests/real-song-wasm.test.ts。
 * 验收阈值（写死在下面的 it 里，跑的是 app 实际要用的滤镜串）：
 * 噪声频段降 ≥6 dB、低频段（20–250 Hz）变化 <1 dB、中频段（500–2000 Hz）变化
 * <1 dB、无新增削波、静音段 <−50 dBFS。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bandLevels, checkSilence, computeMetrics, rmsDb } from '../src/audio/dsp';
import { buildFilterChain } from '../src/audio/ffmpegEngine';
import { readWav } from './wav-io';

const DIR = dirname(fileURLToPath(import.meta.url));
const FIX = join(DIR, 'fixtures', 'fixture42.wav');
const CLEAN = join(DIR, 'fixtures', 'clean42.wav');
const OUT = join(DIR, 'out');
const SR = 44100;

const BAND_NAMES = ['sub 20–60', 'bass 60–250', 'low-mid 250–500', 'mid 500–2000', 'presence 2–5k', 'brilliance 5–10k', 'air 10–20k'];

function runFfmpeg(args: string[]): void {
  try {
    execFileSync('ffmpeg', args, { stdio: 'pipe', timeout: 120000 });
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string };
    throw new Error(`ffmpeg failed: ${err.stderr?.toString().slice(-2000) ?? err.message}`);
  }
}

function slice(ch: Float32Array[], startSec: number, endSec: number): Float32Array[] {
  return ch.map((c) => c.slice(Math.floor(startSec * SR), Math.floor(endSec * SR)));
}

describe('真歌 afftdn（CLI ffmpeg 线）', () => {
  it('诊断：afftdn 采样是否生效（变体对照）', () => {
    const fixture = readWav(FIX);
    const before = bandLevels(fixture.data, SR);
    const variants: Array<{ key: string; chain: string }> = [
      { key: 'v-nosample', chain: 'afftdn=nr=12:nf=-50' },
      { key: 'v-nosample-hp', chain: 'highpass=f=90,afftdn=nr=12:nf=-50' },
      { key: 'v-initstart', chain: 'highpass=f=90,asendcmd=1 afftdn sn stop,afftdn=nr=12:nf=-50:sn=start' },
      { key: 'v-nr30', chain: 'highpass=f=90,asendcmd=0 afftdn sn start,asendcmd=1 afftdn sn stop,afftdn=nr=30:nf=-50' },
      { key: 'v-track', chain: 'highpass=f=90,afftdn=nr=12:nf=-50:tn=1' },
      { key: 'v-nr12-nf80', chain: 'highpass=f=90,asendcmd=0 afftdn sn start,asendcmd=1 afftdn sn stop,afftdn=nr=12:nf=-80' },
    ];
    for (const v of variants) {
      const outPath = join(OUT, `diag-${v.key}.wav`);
      runFfmpeg(['-v', 'error', '-y', '-i', FIX, '-af', v.chain, '-c:a', 'pcm_s16le', outPath]);
      const out = readWav(outPath);
      const after = bandLevels(out.data, SR);
      const met = computeMetrics(fixture.data, out.data, SR);
      console.log(
        `${v.key}: bandDelta [${before.map((b, i) => (after[i] - b).toFixed(2)).join(', ')}] ` +
          `floor ${met.noiseFloorBeforeDb.toFixed(1)}->${met.noiseFloorAfterDb.toFixed(1)}`,
      );
    }
    // om=noise：看 B 链到底去掉了什么
    const noisePath = join(OUT, 'diag-removed-noise.wav');
    runFfmpeg([
      '-v', 'error', '-y', '-i', FIX, '-af',
      'highpass=f=90,asendcmd=0 afftdn sn start,asendcmd=1 afftdn sn stop,afftdn=nr=12:nf=-50:om=noise',
      '-c:a', 'pcm_s16le', noisePath,
    ]);
    const removed = readWav(noisePath);
    const removedBands = bandLevels(removed.data, SR);
    console.log('B 链 om=noise（被去掉的部分）bandLevels:', removedBands.map((v) => v.toFixed(2)).join(', '));
    console.log('fixture bandLevels:', before.map((v) => v.toFixed(2)).join(', '));
  }, 180000);

  it('诊断 2：采样能否靠抬 nf 救回（绝对带电平）', () => {
    const fixture = readWav(FIX);
    const beforeRel = bandLevels(fixture.data, SR);
    const beforeRms = rmsDb(fixture.data);
    const absBefore = beforeRel.map((b) => b + beforeRms);
    const lowBefore = 10 * Math.log10(10 ** (absBefore[0] / 10) + 10 ** (absBefore[1] / 10));
    const variants: Array<{ key: string; chain: string }> = [
      { key: 's-nf40', chain: 'highpass=f=90,asendcmd=0 afftdn sn start,asendcmd=1 afftdn sn stop,afftdn=nr=12:nf=-40' },
      { key: 's-nf30', chain: 'highpass=f=90,asendcmd=0 afftdn sn start,asendcmd=1 afftdn sn stop,afftdn=nr=12:nf=-30' },
      { key: 's-nr30-nf30', chain: 'highpass=f=90,asendcmd=0 afftdn sn start,asendcmd=1 afftdn sn stop,afftdn=nr=30:nf=-30' },
      { key: 'nosample-nr12-nf50', chain: 'highpass=f=90,afftdn=nr=12:nf=-50' },
    ];
    for (const v of variants) {
      const outPath = join(OUT, `diag2-${v.key}.wav`);
      runFfmpeg(['-v', 'error', '-y', '-i', FIX, '-af', v.chain, '-c:a', 'pcm_s16le', outPath]);
      const out = readWav(outPath);
      const afterRel = bandLevels(out.data, SR);
      const afterRms = rmsDb(out.data);
      const absAfter = afterRel.map((b) => b + afterRms);
      const lowAfter = 10 * Math.log10(10 ** (absAfter[0] / 10) + 10 ** (absAfter[1] / 10));
      console.log(
        `${v.key}: relDelta [${beforeRel.map((b, i) => (afterRel[i] - b).toFixed(2)).join(', ')}] ` +
          `absΔ low20-250 ${(lowAfter - lowBefore).toFixed(2)} mid500-2k ${(absAfter[3] - absBefore[3]).toFixed(2)} ` +
          `brill ${(absAfter[5] - absBefore[5]).toFixed(2)} air ${(absAfter[6] - absBefore[6]).toFixed(2)}`,
      );
    }
  }, 180000);

  it('诊断 3：决赛链（绝对电平 + 全部验收项）', () => {
    const fixture = readWav(FIX);
    const beforeRel = bandLevels(fixture.data, SR);
    const beforeRms = rmsDb(fixture.data);
    const absBefore = beforeRel.map((b) => b + beforeRms);
    const lowBefore = 10 * Math.log10(10 ** (absBefore[0] / 10) + 10 ** (absBefore[1] / 10));
    const variants: Array<{ key: string; chain: string }> = [
      { key: 'F1-nosample-nr12-nf50', chain: 'highpass=f=90,afftdn=nr=12:nf=-50' },
      { key: 'F2-sampled-nf35', chain: 'highpass=f=90,asendcmd=0 afftdn sn start,asendcmd=1 afftdn sn stop,afftdn=nr=12:nf=-35' },
      { key: 'F3-sampled-nf38', chain: 'highpass=f=90,asendcmd=0 afftdn sn start,asendcmd=1 afftdn sn stop,afftdn=nr=12:nf=-38' },
      { key: 'F4-nosample-bn-lowprot', chain: "highpass=f=90,afftdn=nr=12:nf=-50:bn='-24|-24|-24|0|0|0|0|0|0|0|0|0|0|0|0'" },
    ];
    for (const v of variants) {
      const outPath = join(OUT, `diag3-${v.key}.wav`);
      runFfmpeg(['-v', 'error', '-y', '-i', FIX, '-af', v.chain, '-c:a', 'pcm_s16le', outPath]);
      const out = readWav(outPath);
      const afterRel = bandLevels(out.data, SR);
      const afterRms = rmsDb(out.data);
      const absAfter = afterRel.map((b) => b + afterRms);
      const lowAfter = 10 * Math.log10(10 ** (absAfter[0] / 10) + 10 ** (absAfter[1] / 10));
      const met = computeMetrics(fixture.data, out.data, SR);
      const sil = checkSilence(slice(fixture.data, 21, 22), slice(out.data, 21, 22), SR);
      console.log(
        `${v.key}: absΔ low20-250 ${(lowAfter - lowBefore).toFixed(2)} mid ${(absAfter[3] - absBefore[3]).toFixed(2)} ` +
          `brill ${(absAfter[5] - absBefore[5]).toFixed(2)} air ${(absAfter[6] - absBefore[6]).toFixed(2)} ` +
          `| floor ${met.noiseFloorBeforeDb.toFixed(1)}->${met.noiseFloorAfterDb.toFixed(1)} ` +
          `clipped ${met.clippedBefore}->${met.clippedAfter} silenceMax ${sil.maxDb.toFixed(1)} dBFS`,
      );
    }
  }, 180000);

  it('诊断 4：强度梯子（采样链，nr/nf 扫参）', () => {
    const fixture = readWav(FIX);
    const beforeRel = bandLevels(fixture.data, SR);
    const beforeRms = rmsDb(fixture.data);
    const absBefore = beforeRel.map((b) => b + beforeRms);
    const lowBefore = 10 * Math.log10(10 ** (absBefore[0] / 10) + 10 ** (absBefore[1] / 10));
    const variants: Array<{ key: string; nr: number; nf: number }> = [
      { key: 'S025-nr6-nf40', nr: 6, nf: -40 },
      { key: 'S05-nr12-nf35', nr: 12, nf: -35 },
      { key: 'S075-nr20-nf35', nr: 20, nf: -35 },
      { key: 'S10-nr30-nf35', nr: 30, nf: -35 },
      { key: 'S075b-nr20-nf40', nr: 20, nf: -40 },
      { key: 'S10b-nr30-nf40', nr: 30, nf: -40 },
    ];
    for (const v of variants) {
      const chain =
        `highpass=f=90,asendcmd=0 afftdn sn start,asendcmd=1 afftdn sn stop,` +
        `afftdn=nr=${v.nr}:nf=${v.nf}`;
      const outPath = join(OUT, `diag4-${v.key}.wav`);
      runFfmpeg(['-v', 'error', '-y', '-i', FIX, '-af', chain, '-c:a', 'pcm_s16le', outPath]);
      const out = readWav(outPath);
      const afterRel = bandLevels(out.data, SR);
      const afterRms = rmsDb(out.data);
      const absAfter = afterRel.map((b) => b + afterRms);
      const lowAfter = 10 * Math.log10(10 ** (absAfter[0] / 10) + 10 ** (absAfter[1] / 10));
      const met = computeMetrics(fixture.data, out.data, SR);
      console.log(
        `${v.key}: absΔ low ${(lowAfter - lowBefore).toFixed(2)} mid ${(absAfter[3] - absBefore[3]).toFixed(2)} ` +
          `brill ${(absAfter[5] - absBefore[5]).toFixed(2)} air ${(absAfter[6] - absBefore[6]).toFixed(2)} ` +
          `floor ${met.noiseFloorAfterDb.toFixed(1)} clipped ${met.clippedAfter}`,
      );
    }
  }, 180000);

  it('滤镜串实测：指标表齐全', () => {
    expect(existsSync(FIX)).toBe(true);
    expect(existsSync(CLEAN)).toBe(true);
    mkdirSync(OUT, { recursive: true });

    const fixture = readWav(FIX);
    const clean = readWav(CLEAN);
    expect(fixture.sampleRate).toBe(SR);
    expect(fixture.data[0].length).toBe(42 * SR);

    // 诊断：各频段噪声占比（fixture − clean = 纯噪声，采样对齐）。
    const noiseOnly = fixture.data.map((c, i) => {
      const d = clean.data[i];
      const out = new Float32Array(c.length);
      for (let n = 0; n < c.length; n++) out[n] = c[n] - d[n];
      return out;
    });
    const cleanMusic = slice(clean.data, 1, 42);
    const noiseMusic = slice(noiseOnly, 1, 42);
    const cleanBands = bandLevels(cleanMusic, SR);
    const noiseBands = bandLevels(noiseMusic, SR);
    const bandSnr: number[] = cleanBands.map((c, i) => c - noiseBands[i]);

    const chains: Array<{ key: string; label: string; chain: string }> = [
      { key: 'hp', label: 'A 高通 only（基线）', chain: buildFilterChain({ strength: 0 }) },
      {
        key: 'shipped',
        label: '出货链：高通 + afftdn（默认强度 0.5 → nr 12 / nf −30，不采样）',
        chain: buildFilterChain({ strength: 0.5 }),
      },
    ];

    const results: Record<string, unknown> = {
      fixture: 'fixture42.wav',
      clean: 'clean42.wav',
      bandSnrDb: Object.fromEntries(BAND_NAMES.map((n, i) => [n, Number(bandSnr[i].toFixed(2))])),
    };

    for (const c of chains) {
      const outPath = join(OUT, `cli-${c.key}.wav`);
      runFfmpeg(['-v', 'error', '-y', '-i', FIX, '-af', c.chain, '-c:a', 'pcm_s16le', outPath]);
      const out = readWav(outPath);
      expect(out.data[0].length).toBe(42 * SR);
      const before = bandLevels(fixture.data, SR);
      const after = bandLevels(out.data, SR);
      // 绝对带电平（相对份额 × 总功率）：验收用绝对值，相对份额会在总功率
      // 变化时失真（例如高通使 sub 频段份额崩掉，但其绝对功率只占 20–250 Hz
      // 合并带功率的约 2%）。
      const absBefore = before.map((b) => b + rmsDb(fixture.data));
      const absAfter = after.map((b) => b + rmsDb(out.data));
      const absDelta = absBefore.map((b, i) => Number((absAfter[i] - b).toFixed(2)));
      const lowBefore = 10 * Math.log10(10 ** (absBefore[0] / 10) + 10 ** (absBefore[1] / 10));
      const lowAfter = 10 * Math.log10(10 ** (absAfter[0] / 10) + 10 ** (absAfter[1] / 10));
      const lowDelta = Number((lowAfter - lowBefore).toFixed(2));
      const met = computeMetrics(fixture.data, out.data, SR);
      const silence = checkSilence(fixture.data, out.data, SR);
      results[c.key] = {
        label: c.label,
        chain: c.chain,
        bandsBeforeDb: before.map((v) => Number(v.toFixed(2))),
        bandsAfterDb: after.map((v) => Number(v.toFixed(2))),
        bandDeltaDb: before.map((v, i) => Number((after[i] - v).toFixed(2))),
        absBandDeltaDb: absDelta,
        lowBand20_250AbsDeltaDb: lowDelta,
        noiseFloorBeforeDb: Number(met.noiseFloorBeforeDb.toFixed(2)),
        noiseFloorAfterDb: Number(met.noiseFloorAfterDb.toFixed(2)),
        snrChangeDb: Number(met.snrChangeDb.toFixed(2)),
        spectralDistanceDb: Number(met.spectralDistanceDb.toFixed(2)),
        truePeakBeforeDbTp: Number(met.truePeakBeforeDbTp.toFixed(2)),
        truePeakAfterDbTp: Number(met.truePeakAfterDbTp.toFixed(2)),
        clippedBefore: met.clippedBefore,
        clippedAfter: met.clippedAfter,
        silenceOk: silence.ok,
        silenceMaxDb: Number(silence.maxDb.toFixed(2)),
      };
      console.log(`\n== ${c.label} ==\nchain: ${c.chain}`);
      console.log('band delta dB (相对):', (results[c.key] as { bandDeltaDb: number[] }).bandDeltaDb.join(', '));
      console.log('abs band delta dB:', absDelta.join(', '), `low 20–250 absΔ ${lowDelta} dB`);
      console.log(
        `noiseFloor ${met.noiseFloorBeforeDb.toFixed(2)} -> ${met.noiseFloorAfterDb.toFixed(2)} dBFS, ` +
          `SNR change ${met.snrChangeDb >= 0 ? '+' : ''}${met.snrChangeDb.toFixed(2)} dB, ` +
          `clipped ${met.clippedBefore} -> ${met.clippedAfter}, ` +
          `silence max ${silence.maxDb.toFixed(2)} dBFS (ok=${silence.ok})`,
      );
    }
    // 验收断言（出货链，绝对带电平）：噪声频段降 ≥6 dB、低频段（20–250 Hz）
    // 变化 <1 dB、中频段（500–2000 Hz）变化 <1 dB、无新增削波、静音段 <−50 dBFS。
    const shipped = results.shipped as {
      absBandDeltaDb: number[];
      lowBand20_250AbsDeltaDb: number;
      clippedBefore: number;
      clippedAfter: number;
      silenceOk: boolean;
      silenceMaxDb: number;
    };
    expect(shipped.absBandDeltaDb[5]).toBeLessThanOrEqual(-6); // brilliance 5–10k
    expect(shipped.absBandDeltaDb[6]).toBeLessThanOrEqual(-6); // air 10–20k
    expect(Math.abs(shipped.lowBand20_250AbsDeltaDb)).toBeLessThan(1);
    expect(Math.abs(shipped.absBandDeltaDb[3])).toBeLessThan(1); // mid 500–2000
    expect(shipped.clippedAfter).toBe(shipped.clippedBefore);
    expect(shipped.silenceOk).toBe(true);
    expect(shipped.silenceMaxDb).toBeLessThan(-50);
    console.log('\nband SNR (clean music vs added noise, dB):', JSON.stringify(results.bandSnrDb));
    writeFileSync(join(OUT, 'real-song-metrics.json'), JSON.stringify(results, null, 2));
  }, 180000);
});
