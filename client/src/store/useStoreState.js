import { useEffect, useState } from 'react';

/**
 * 把 store 订阅成 React state。
 * 刻意不用 useSyncExternalStore：store.getState() 返回防御性副本（每次新对象），
 * 用它做 snapshot 会导致无限重渲染。订阅回调直接拿到内部不可变状态，天然稳定。
 */
export function useStoreState(store) {
  const [state, setState] = useState(() => store.getState());

  useEffect(() => {
    setState(store.getState());
    return store.subscribe((next) => setState(next));
  }, [store]);

  return state;
}
