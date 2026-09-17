/**
 * 全应用共享的秒级时钟（外部可变源）。
 *
 * 为什么不用 `useState` + `setInterval` 直接在组件里读 `Date.now()`：
 * render 期间读时钟是不纯的——同一份 props 可能渲染出不同结果，React 19 的
 * `react-hooks/purity` 规则会直接报错。把时钟当成「外部数据源」用
 * `useSyncExternalStore` 订阅，是官方认可的读法；顺带让所有计时组件共用同一个
 * interval，不会每张卡片各起一个定时器。
 */
const listeners = new Set();
let timer = null;

export function subscribe(listener) {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(() => {
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** 秒级时间戳：每秒最多变一次，因此不会造成 useSyncExternalStore 的无限重渲染 */
export function getSnapshot() {
  return Math.floor(Date.now() / 1000);
}
