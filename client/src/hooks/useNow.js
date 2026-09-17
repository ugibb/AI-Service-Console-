import { useSyncExternalStore } from 'react';
import { getSnapshot, subscribe } from '../lib/clock.js';

/**
 * 每秒重渲染一次的「当前秒级时间戳」。
 *
 * 用于「已启动 12s」这类需要走秒的相对时间显示；组件不需要自己挂定时器。
 */
export function useNow() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
