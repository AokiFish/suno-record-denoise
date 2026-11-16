/**
 * v4 断点检测 / 修复 / chunk 计时测试。
 *
 * 判定常量（校准后定死，见 src/audio/dropouts.ts 与 PROGRESS.md v4 节）：
 * 阈值 −60 dBFS、最短 20 ms、前后 0.5 s 上下文 RMS > −40 dBFS、
 * 跌落/回升陡峭比 > 0.5、缺口内毛刺桥接 ≤2 ms 且 < −50 dBFS。
 *
 * fixture：合成 440 Hz 正弦（振幅 0.4）+ 真歌 fixture42（月光奏鸣曲，
 * 42 s，21–22 s 有一段内置数字静音）。
 */
import { describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeChunkTimestamps,
  detectDropouts,
  repairShortGaps,
  type Dropout,
} from '../src/audio/dropouts';
import { readWav } from './wav-io';

const DIR = dirname(fileURLToPath(import.meta.url));
const SR = 44100;

function sine(sec: number, freq = 440, amp = 0.4): Float32Array {
  const n = Math.floor(sec * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function buryGap(sig: Float32Array, startSec: number, durSec: number): Float32Array {
  const out = sig.slice();
  out.fill(0, Math.floor(startSec * SR), Math.floor((startSec + durSec) * SR));
  return out;
}

function maxJump(ch: Float32Array, startSec: number, endSec: number): number {
  const s = Math.floor(startSec * SR);
  const e = Math.min(ch.length - 1, Math.floor(endSec * SR));
  let m = 0;
  for (let i = s; i < e; i++) {
    const d = Math.abs(ch[i + 1] - ch[i]);
    if (d > m) m = d;
  }
  return m;
}

function rmsRange(ch: Float32Array, startSec: number, endSec: number): number {
  const s = Math.floor(startSec * SR);
  const e = Math.min(ch.length, Math.floor(endSec * SR));
  let sum = 0;
  for (let i = s; i < e; i++) sum += ch[i] * ch[i];
  return Math.sqrt(sum / Math.max(e - s, 1));
}

describe('detectDropouts（合成正弦）', () => {
  it('乐曲中部埋的 20/50/200/1000 ms 缺口全检出，位置误差 ≤10 ms', () => {
    let sig = sine(10);
    sig = buryGap(sig, 3, 0.02);
    sig = buryGap(sig, 4, 0.05);
    sig = buryGap(sig, 5, 0.2);
    sig = buryGap(sig, 7, 1.0);
    const gaps = detectDropouts([sig], SR);
    expect(gaps.length).toBe(4);
    // 时长允许 ±1 采样（0.023 ms）误差：缺口边缘恰好落在正弦过零点时，
    // 边缘第一个采样本身就低于阈值，run 会多算 1 个采样。
    expect(gaps[0].durationMs).toBeCloseTo(20, 1);
    expect(gaps[1].durationMs).toBeCloseTo(50, 1);
    expect(gaps[2].durationMs).toBeCloseTo(200, 1);
    expect(gaps[3].durationMs).toBeCloseTo(1000, 1);
    expect(gaps[0].startSec).toBeCloseTo(3, 2);
    expect(gaps[1].startSec).toBeCloseTo(4, 2);
    expect(gaps[2].startSec).toBeCloseTo(5, 2);
    expect(gaps[3].startSec).toBeCloseTo(7, 2);
  });

  it('前奏静音与尾奏淡出不被检出', () => {
    const sig = sine(10);
    sig.fill(0, 0, SR); // 前奏 1 s 静音
    for (let i = 0; i < SR; i++) sig[9 * SR + i] *= 1 - i / SR; // 尾奏 1 s 淡出
    const withGaps = buryGap(sig, 4, 0.05);
    const gaps = detectDropouts([withGaps], SR);
    expect(gaps.length).toBe(1);
    expect(gaps[0].startSec).toBeCloseTo(4, 2);
  });

  it('乐曲中部自然淡出—停顿—淡入不被检出', () => {
    const sig = sine(6);
    for (let i = 0; i < SR; i++) sig[2 * SR + i] *= 1 - i / SR; // 1 s 淡出
    sig.fill(0, 3 * SR, Math.floor(3.3 * SR)); // 300 ms 停顿
    for (let i = 0; i < SR; i++) sig[Math.floor(3.3 * SR) + i] *= i / SR; // 1 s 淡入
    expect(detectDropouts([sig], SR)).toEqual([]);
  });

  it('缺口内单个 −54 dBFS 毛刺被桥接，仍算一个缺口', () => {
    const sig = buryGap(sine(10), 3, 0.05);
    sig[Math.floor(3.025 * SR)] = 0.002; // 高于静阈值、低于桥接阈值
    const gaps = detectDropouts([sig], SR);
    expect(gaps.length).toBe(1);
    expect(gaps[0].durationMs).toBeCloseTo(50, 0);
  });
});

describe('detectDropouts（真歌 fixture42）', () => {
  it('内置 21–22 s 数字静音被检出为 1000 ms 断点', () => {
    const fix = readWav(join(DIR, 'fixtures', 'fixture42.wav'));
    const gaps = detectDropouts(fix.data, SR);
    expect(gaps.length).toBe(1);
    expect(gaps[0].startSec).toBeCloseTo(21, 2);
    expect(gaps[0].durationMs).toBeCloseTo(1000, 0);
  });

  it('再埋一个 100 ms 缺口 → 检出 2 个', () => {
    const fix = readWav(join(DIR, 'fixtures', 'fixture42.wav'));
    const buried = fix.data.map((ch) => {
      const c = ch.slice();
      c.fill(0, Math.floor(30 * SR), Math.floor(30.1 * SR));
      return c;
    });
    const gaps = detectDropouts(buried, SR);
    expect(gaps.length).toBe(2);
    expect(gaps[1].startSec).toBeCloseTo(30, 2);
    expect(gaps[1].durationMs).toBeCloseTo(100, 0);
  });
});

describe('repairShortGaps', () => {
  it('30 ms 缺口修后连续（最大跳变 < 0.05）、区内非静音、缺口外逐采样不变', () => {
    const orig = sine(10);
    const buried = buryGap(orig, 3, 0.03);
    const gaps: Dropout[] = [{ startSec: 3, endSec: 3.03, durationMs: 30 }];
    const { channels, repaired, unrepaired } = repairShortGaps([buried], SR, gaps);
    expect(repaired).toBe(1);
    expect(unrepaired).toBe(0);
    expect(maxJump(channels[0], 3, 3.03)).toBeLessThan(0.05);
    expect(rmsRange(channels[0], 3, 3.03)).toBeGreaterThan(0.05);
    // 缺口外逐采样不变（整段 toEqual，一次断言，不逐采样 expect）
    expect(channels[0].slice(0, Math.floor(3 * SR))).toEqual(buried.slice(0, Math.floor(3 * SR)));
    expect(channels[0].slice(Math.floor(3.03 * SR))).toEqual(buried.slice(Math.floor(3.03 * SR)));
    // 输入不被修改
    expect(buried[Math.floor(3.015 * SR)]).toBe(0);
  });

  it('200 ms 长缺口不被填充：缺口内原样，边缘 5 ms 淡化、边界跳变 < 0.05', () => {
    const orig = sine(10);
    const buried = buryGap(orig, 3, 0.2);
    const gaps: Dropout[] = [{ startSec: 3, endSec: 3.2, durationMs: 200 }];
    const { channels, repaired, unrepaired } = repairShortGaps([buried], SR, gaps);
    expect(repaired).toBe(0);
    expect(unrepaired).toBe(1);
    // 缺口内（除边缘淡化区外）原样为零（一次聚合断言，不逐采样 expect）
    const interior = channels[0].slice(Math.floor(3.005 * SR), Math.floor(3.195 * SR));
    expect(interior.every((v) => v === 0)).toBe(true);
    // 边缘淡到接近零：缺口前最后一采样与缺口后第一采样都接近 0
    expect(Math.abs(channels[0][Math.floor(3 * SR) - 1])).toBeLessThan(0.01);
    expect(Math.abs(channels[0][Math.floor(3.2 * SR)])).toBeLessThan(0.01);
    expect(maxJump(channels[0], 2.99, 3.21)).toBeLessThan(0.05);
  });

  it('混合缺口：30 ms 修、200 ms 不修，计数正确', () => {
    const orig = sine(10);
    let buried = buryGap(orig, 3, 0.03);
    buried = buryGap(buried, 5, 0.2);
    const gaps: Dropout[] = [
      { startSec: 3, endSec: 3.03, durationMs: 30 },
      { startSec: 5, endSec: 5.2, durationMs: 200 },
    ];
    const { repaired, unrepaired } = repairShortGaps([buried], SR, gaps);
    expect(repaired).toBe(1);
    expect(unrepaired).toBe(1);
  });
});

describe('analyzeChunkTimestamps', () => {
  it('规律 250 ms 到达 → 0 事件', () => {
    const ts = Array.from({ length: 9 }, (_, i) => i * 250);
    expect(analyzeChunkTimestamps(ts)).toEqual({ count: 0, timesSec: [] });
  });

  it('一次 800 ms 间隔 → 1 事件，时刻为间隔中点', () => {
    const ts = [0, 250, 500, 750, 1550, 1800, 2050];
    const r = analyzeChunkTimestamps(ts);
    expect(r.count).toBe(1);
    expect(r.timesSec[0]).toBeCloseTo(1.15, 2);
  });

  it('两次长间隔 → 2 事件', () => {
    const ts = [0, 250, 900, 1150, 2000, 2250];
    expect(analyzeChunkTimestamps(ts).count).toBe(2);
  });
});
