import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// jsdom 不实现滚动；LogViewer 的「自动滚动到末尾」逻辑需要一个可写属性。
// 挂在 Element.prototype 上也让测试可以 vi.spyOn 它，从而断言「关掉自动滚动后视口不再跳」。
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo(options) {
    const top = typeof options === 'object' ? options.top : arguments[1];
    if (typeof top === 'number') this.scrollTop = top;
  };
}
