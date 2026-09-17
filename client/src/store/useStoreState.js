import { useSyncExternalStore } from 'react';

/**
 * 把 store 订阅成 React state。
 *
 * 用 store 的**稳定快照**（getSnapshot 返回内部 state 引用，仅在 commit 时换新）
 * 交给 useSyncExternalStore —— 这是「订阅外部数据源」的官方 API：
 * 既拿到了 store 变更通知，也在 store 身份变化时自动重新订阅、重新取快照。
 *
 * 注意不能用 store.getState：它每次返回防御性副本（新对象），引用永不相等，
 * 放进 useSyncExternalStore 会触发无限重渲染。
 */
export function useStoreState(store) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
