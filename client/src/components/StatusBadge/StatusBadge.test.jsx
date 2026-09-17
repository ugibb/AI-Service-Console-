import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { STATUS_META, StatusBadge } from './StatusBadge.jsx';

describe('StatusBadge', () => {
  it.each([
    ['running', '运行中'],
    ['stopped', '已停止'],
    ['starting', '启动中'],
    ['stopping', '停止中'],
    ['error', '异常'],
    ['start_failed', '启动失败'],
  ])('状态 %s → 中文标签「%s」', (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it('未知状态不崩，回退「未知」并标记为中性色', () => {
    render(<StatusBadge status="wat" />);
    expect(screen.getByText('未知')).toBeTruthy();
    expect(STATUS_META.wat).toBeUndefined();
  });

  it('用语义化的 tone 类名承载颜色（不是靠内联色值）', () => {
    const { container, rerender } = render(<StatusBadge status="running" />);
    expect(container.firstChild.className).toContain('status-badge--ok');

    rerender(<StatusBadge status="error" />);
    expect(container.firstChild.className).toContain('status-badge--danger');
  });

  it('异常 / 启动失败时把退出码与原因一并透出（用户要看得出为什么）', () => {
    render(<StatusBadge status="error" exitCode={3} />);
    expect(screen.getByText(/退出码 3/)).toBeTruthy();
  });

  it('运行中带脉冲点；开启中/停止中也是活动态', () => {
    const { container } = render(<StatusBadge status="starting" />);
    expect(container.querySelector('.status-badge__dot')).toBeTruthy();
    expect(container.firstChild.className).toContain('status-badge--active');
  });
});
