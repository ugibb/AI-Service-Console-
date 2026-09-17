import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// jsdom 不实现滚动；LogViewer 的「跟随末尾」逻辑需要一个可写属性。
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo(options) {
    const top = typeof options === 'object' ? options.top : arguments[1];
    if (typeof top === 'number') this.scrollTop = top;
  };
}
