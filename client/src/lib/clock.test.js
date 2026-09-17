import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot, subscribe } from './clock.js';

describe('clock（共享秒级时钟）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('getSnapshot 返回秒级时间戳：1 秒内稳定，跨秒才变', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T00:00:00.000Z'));

    const first = getSnapshot();
    vi.advanceTimersByTime(500);
    expect(getSnapshot()).toBe(first);
    vi.advanceTimersByTime(500);
    expect(getSnapshot()).toBe(first + 1);
  });

  it('订阅后每秒通知一次；多个订阅者共用一个定时器，全部退订后停表', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = subscribe(first);
    const unsubscribeSecond = subscribe(second);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(3000);
    expect(first).toHaveBeenCalledTimes(3);
    expect(second).toHaveBeenCalledTimes(3);

    unsubscribeFirst();
    expect(vi.getTimerCount()).toBe(1, '还有订阅者时不能停表');

    unsubscribeSecond();
    expect(vi.getTimerCount()).toBe(0);
  });
});
