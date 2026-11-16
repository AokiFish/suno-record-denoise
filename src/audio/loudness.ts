/**
 * 简化版 BS.1770 综合响度（K 计权 + 门控），用于 A/B 同响度匹配。
 * K 计权 = 1500 Hz 高架 +4 dB（RBJ 高架）串联 38 Hz 高通（RBJ，Q=0.5），
 * 与 pyloudnorm 采用的滤波器结构一致。400 ms 块、75% 重叠，
 * 绝对门 −70 LUFS、相对门 −10 LU，−0.691 dB 校准偏移。
 * 这是近似实现，绝对 LUFS 与专业表可能有零点几 LU 偏差；
 * A/B 匹配只依赖两段的相对差，因此足够。
 */

interface Biquad {
  b: number[];
  a: number[];
}

function highshelfCoefficients(freqHz: number, gainDb: number, sampleRate: number): Biquad {
  const a = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const alpha = (Math.sin(w0) / 2) * Math.sqrt((Math.log(2) / 2) * (Math.log(2) / 2));
  const cos = Math.cos(w0);
  const a0 = (a + 1) + (a - 1) * cos + 2 * Math.sqrt(a) * alpha;
  return {
    b: [
      (a * ((a + 1) + (a - 1) * cos + 2 * Math.sqrt(a) * alpha)) / a0,
      (-2 * a * ((a - 1) + (a + 1) * cos)) / a0,
      (a * ((a + 1) + (a - 1) * cos - 2 * Math.sqrt(a) * alpha)) / a0,
    ],
    a: [
      1,
      (2 * ((a - 1) - (a + 1) * cos)) / a0,
      (((a + 1) - (a - 1) * cos - 2 * Math.sqrt(a) * alpha) / a0),
    ],
  };
}

function highpassCoefficients(freqHz: number, sampleRate: number, q: number): Biquad {
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b: [((1 + cos) / 2 / a0), (-(1 + cos) / a0), ((1 + cos) / 2 / a0)],
    a: [1, ((-2 * cos) / a0), ((1 - alpha) / a0)],
  };
}

function applyBiquad(samples: Float32Array, coef: Biquad): Float32Array {
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 =
      coef.b[0] * x0 + coef.b[1] * x1 + coef.b[2] * x2 - coef.a[1] * y1 - coef.a[2] * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/** K 计权滤波（单声道）。 */
export function kWeight(channel: Float32Array, sampleRate: number): Float32Array {
  const shelf = highshelfCoefficients(1500, 4, sampleRate);
  const hp = highpassCoefficients(38, sampleRate, 0.5);
  return applyBiquad(applyBiquad(channel, shelf), hp);
}

/** 门控综合响度（LUFS，简化 BS.1770）。 */
export function integratedLoudness(channels: Float32Array[], sampleRate: number): number {
  const blockLen = Math.floor(0.4 * sampleRate);
  const hop = Math.floor(0.1 * sampleRate);
  const weighted = channels.map((ch) => kWeight(ch, sampleRate));
  const blockPowers: number[] = [];
  const channelWeight = channels.length === 1 ? 1 : 1;
  for (let pos = 0; pos + blockLen <= weighted[0].length; pos += hop) {
    let sum = 0;
    for (const w of weighted) {
      let s = 0;
      for (let i = pos; i < pos + blockLen; i += 2) {
        s += w[i] * w[i];
      }
      sum += (s / (blockLen / 2)) * channelWeight;
    }
    blockPowers.push(sum);
  }
  if (blockPowers.length === 0) return -120;
  const toLufs = (p: number) => -0.691 + 10 * Math.log10(Math.max(p, 1e-12));
  const absGate = -70;
  const gated = blockPowers.filter((p) => toLufs(p) > absGate);
  if (gated.length === 0) return -120;
  const ungatedMean = gated.reduce((a, b) => a + b, 0) / gated.length;
  const relGate = toLufs(ungatedMean) - 10;
  const final = gated.filter((p) => toLufs(p) > relGate);
  if (final.length === 0) return toLufs(ungatedMean);
  const mean = final.reduce((a, b) => a + b, 0) / final.length;
  return toLufs(mean);
}

/**
 * A/B 同响度增益：两段都 ≤ 0 dB，恰一个为 0（更响的那段被衰减）。
 * 返回线性增益与处理后的响度差（LU）。
 */
export function abGains(
  lufsA: number,
  lufsB: number,
): { gainAdb: number; gainBdb: number; gainA: number; gainB: number; diffLu: number } {
  const target = Math.min(lufsA, lufsB);
  const gainAdb = target - lufsA;
  const gainBdb = target - lufsB;
  return {
    gainAdb,
    gainBdb,
    gainA: Math.pow(10, gainAdb / 20),
    gainB: Math.pow(10, gainBdb / 20),
    diffLu: Math.abs(lufsA + gainAdb - (lufsB + gainBdb)),
  };
}
