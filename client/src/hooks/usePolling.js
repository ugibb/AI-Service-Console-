import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 轮询 hook（T1.11）。
 *
 * 设计要点（PRD §8.4：实时性由 HTTP 轮询保证，不引入 WebSocket）：
 * - 挂载即拉一次，随后按 intervalMs 重复；组件卸载/依赖变化时清理定时器。
 * - **防重叠**：上一次请求未返回时跳过本次 tick，避免慢后端把请求堆起来。
 * - task 用 ref 持有，task 身份变化不会重建定时器（否则每次渲染都会重置节奏）。
 * - 一次失败不终止轮询，错误挂在 state 上由 UI 决定怎么展示。
 */
export function usePolling(task, { intervalMs = 1000, enabled = true, immediate = true } = {}) {
  const taskRef = useRef(task);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(false);
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(enabled && immediate) });

  useEffect(() => {
    taskRef.current = task;
  }, [task]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (inFlightRef.current) return undefined;
    inFlightRef.current = true;
    try {
      const data = await taskRef.current();
      if (mountedRef.current) setState((prev) => ({ ...prev, data, error: null, loading: false }));
      return data;
    } catch (error) {
      if (mountedRef.current) setState((prev) => ({ ...prev, error, loading: false }));
      return undefined;
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    if (immediate) run();
    const timer = setInterval(run, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, immediate, intervalMs, run]);

  return { ...state, refresh: run };
}
