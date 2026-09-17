import { describe, expect, it } from 'vitest';
import { formatElapsed } from './duration.js';

describe('formatElapsed', () => {
  it('1 分钟以内按秒显示（宽限期最常见区间，也是用户盯着看的区间）', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(1000)).toBe('1s');
    expect(formatElapsed(59_999)).toBe('59s');
  });

  it('超过 1 分钟按 m ss 显示（AI 服务加载模型动辄几分钟）', () => {
    expect(formatElapsed(60_000)).toBe('1m00s');
    expect(formatElapsed(65_000)).toBe('1m05s');
    expect(formatElapsed(3_599_000)).toBe('59m59s');
  });

  it('超过 1 小时按 h mm 显示（避免出现 3 位数分钟）', () => {
    expect(formatElapsed(3_600_000)).toBe('1h00m');
    expect(formatElapsed(3_600_000 + 25 * 60_000)).toBe('1h25m');
  });

  it('负数 / 非法输入不崩，退化为 0s（时钟漂移或后端字段缺失时不能白屏）', () => {
    expect(formatElapsed(-5)).toBe('0s');
    expect(formatElapsed(Number.NaN)).toBe('0s');
    expect(formatElapsed(undefined)).toBe('0s');
    expect(formatElapsed(null)).toBe('0s');
  });
});
