import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePolling } from './usePolling.js';

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('usePolling', () => {
  it('挂载即拉一次，然后按间隔重复（PRD §8.4：日志 1s）', async () => {
    vi.useFakeTimers();
    const task = vi.fn().mockResolvedValue('payload');
    const { result } = renderHook(() => usePolling(task, { intervalMs: 1000 }));

    await flush(0);
    expect(task).toHaveBeenCalledTimes(1);
    await flush(1000);
    expect(task).toHaveBeenCalledTimes(2);
    await flush(3000);
    expect(task).toHaveBeenCalledTimes(5);
    expect(result.current.data).toBe('payload');
  });

  it('上一次未返回时跳过本次 tick（防重叠，不堆请求）', async () => {
    vi.useFakeTimers();
    let resolveTask;
    const task = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveTask = resolve;
        }),
    );
    renderHook(() => usePolling(task, { intervalMs: 1000 }));

    await flush(0);
    expect(task).toHaveBeenCalledTimes(1);
    await flush(5000);
    expect(task).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveTask('done');
      await Promise.resolve();
    });
    await flush(1000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('失败时记录 error，且后续轮询继续尝试（一次失败不终止轮询）', async () => {
    vi.useFakeTimers();
    const task = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('recovered');
    const { result } = renderHook(() => usePolling(task, { intervalMs: 1000 }));

    await flush(0);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error.message).toBe('boom');

    await flush(1000);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBe('recovered');
  });

  it('卸载后停止轮询（不留定时器）', async () => {
    vi.useFakeTimers();
    const task = vi.fn().mockResolvedValue('x');
    const { unmount } = renderHook(() => usePolling(task, { intervalMs: 1000 }));
    await flush(0);
    unmount();
    await flush(5000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('enabled=false 时完全不请求；重新开启后恢复', async () => {
    vi.useFakeTimers();
    const task = vi.fn().mockResolvedValue('x');
    const { rerender } = renderHook(({ enabled }) => usePolling(task, { intervalMs: 1000, enabled }), {
      initialProps: { enabled: false },
    });
    await flush(3000);
    expect(task).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await flush(0);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('refresh() 可立即触发一次（用户点「刷新」不必等下一秒）', async () => {
    vi.useFakeTimers();
    const task = vi.fn().mockResolvedValue('x');
    const { result } = renderHook(() => usePolling(task, { intervalMs: 1000 }));
    await flush(0);
    expect(task).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('task 身份变化不会重复建定时器（用 ref 持有最新实现）', async () => {
    vi.useFakeTimers();
    const first = vi.fn().mockResolvedValue('a');
    const second = vi.fn().mockResolvedValue('b');
    const { result, rerender } = renderHook(({ task }) => usePolling(task, { intervalMs: 1000 }), {
      initialProps: { task: first },
    });
    await flush(0);
    rerender({ task: second });
    await flush(1000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe('b');
  });

  it('非定时器环境下的基本契约：返回 loading 由 true 变 false', async () => {
    const task = vi.fn().mockResolvedValue('z');
    const { result } = renderHook(() => usePolling(task, { intervalMs: 1_000_000 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe('z');
  });
});
