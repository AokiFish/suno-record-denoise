/**
 * 播放门规则测试：哪几侧可播（纯函数 playableSides）。
 *
 * 规则：原声永远可播；降噪后只有 processed 存在时可播。引擎加载失败时
 * processed 恒为 null，原声必须照常播。
 */
import { describe, expect, it } from 'vitest';
import { playableSides } from '../src/audio/playback';

describe('playableSides', () => {
  it('processed 为 null：原声可播，降噪后不可播', () => {
    expect(playableSides(false)).toEqual({ orig: true, proc: false });
  });

  it('processed 存在：两侧都可播', () => {
    expect(playableSides(true)).toEqual({ orig: true, proc: true });
  });
});
