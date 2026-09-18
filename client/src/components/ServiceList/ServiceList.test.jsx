import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServiceList } from './ServiceList.jsx';

const service = (over = {}) => ({
  id: 's1',
  name: '订单服务',
  workDir: 'C:\\svc',
  startScript: 'C:\\svc\\start.bat',
  logFile: 'C:\\svc\\app.log',
  port: 8081,
  status: 'stopped',
  pid: null,
  exitCode: null,
  ...over,
});

const baseProps = {
  onStart: () => {},
  onStop: () => {},
  onRestart: () => {},
  onEdit: () => {},
  onDelete: () => {},
  onOpenLogs: () => {},
  onCreate: () => {},
};

describe('ServiceList', () => {
  it('空状态：给出「新增服务」引导（PRD §12 无任何服务）', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<ServiceList services={[]} loaded {...baseProps} onCreate={onCreate} />);

    expect(screen.getByText(/还没有登记任何服务/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '新增服务' }));
    expect(onCreate).toHaveBeenCalled();
  });

  it('非空：渲染出每个服务的卡片', () => {
    render(<ServiceList services={[service(), service({ id: 's2', name: '推理服务' })]} loaded {...baseProps} />);
    expect(screen.getByText('订单服务')).toBeTruthy();
    expect(screen.getByText('推理服务')).toBeTruthy();
  });

  it('统计条算出「运行中」数量（adopted 算在跑，starting 不算）', () => {
    render(
      <ServiceList
        services={[
          service({ status: 'running' }),
          service({ id: 's2', status: 'adopted' }),
          service({ id: 's3', status: 'starting' }),
          service({ id: 's4' }),
        ]}
        loaded
        {...baseProps}
      />,
    );

    // 这里曾经写的是 `services.runningCount`——services 是数组，取字段恒为 undefined，
    // 渲染出来是「运行中 个」，中间那个数字永远是空的。断言整行文字钉住这个回归。
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('共4个服务，运行中2个');
  });

  it('不再显示「状态可能不准确」免责声明（真接管已取代该边界）', () => {
    render(<ServiceList services={[service()]} loaded {...baseProps} />);
    expect(screen.queryByText(/状态可能不准确/)).toBeNull();
    expect(screen.queryByText(/taskkill/)).toBeNull();
  });

  it('配置加载告警会展示给用户（损坏 JSON 降级不能静默）', () => {
    render(<ServiceList services={[]} loaded warnings={['配置文件损坏，已备份并降级为空列表']} {...baseProps} />);
    expect(screen.getByText(/配置文件损坏/)).toBeTruthy();
  });

  it('首次加载中：显示骨架/加载态而不是空白', () => {
    render(<ServiceList services={[]} loaded={false} {...baseProps} />);
    expect(screen.getByText(/正在读取服务配置/)).toBeTruthy();
  });

  it('pending 会透传给对应卡片（只有该服务的按钮进入忙碌态）', () => {
    render(<ServiceList services={[service(), service({ id: 's2', name: '推理服务' })]} loaded pending={{ s1: 'start' }} {...baseProps} />);
    expect(screen.getAllByRole('button', { name: '启动中…' })).toHaveLength(1);
  });
});
