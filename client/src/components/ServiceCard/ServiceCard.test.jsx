import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServiceCard } from './ServiceCard.jsx';

const service = (over = {}) => ({
  id: 's1',
  name: '订单服务',
  workDir: 'C:\\services\\order',
  startScript: 'C:\\services\\order\\start.bat',
  logFile: 'C:\\services\\order\\app.log',
  port: 8081,
  status: 'stopped',
  pid: null,
  exitCode: null,
  statusMessage: null,
  ...over,
});

const noop = () => {};

describe('ServiceCard', () => {
  it('展示名称、状态、端口与工作目录（省掉「找目录」）', () => {
    render(
      <ServiceCard
        service={service({ status: 'running', pid: 4242 })}
        onStart={noop}
        onStop={noop}
        onRestart={noop}
        onEdit={noop}
        onDelete={noop}
        onOpenLogs={noop}
      />,
    );
    expect(screen.getByText('订单服务')).toBeTruthy();
    expect(screen.getByText('运行中')).toBeTruthy();
    expect(screen.getByText(/8081/)).toBeTruthy();
    expect(screen.getByText(/C:\\services\\order/)).toBeTruthy();
    expect(screen.getByText(/4242/)).toBeTruthy();
  });

  it('端口未填时不渲染空的端口字段（不留「端口：-」的噪声）', () => {
    render(
      <ServiceCard
        service={service({ port: null })}
        onStart={noop}
        onStop={noop}
        onRestart={noop}
        onEdit={noop}
        onDelete={noop}
        onOpenLogs={noop}
      />,
    );
    expect(screen.queryByText(/端口/)).toBeNull();
  });

  it('已停止：只能「启动」，停止/重启禁用', () => {
    render(
      <ServiceCard service={service()} onStart={noop} onStop={noop} onRestart={noop} onEdit={noop} onDelete={noop} onOpenLogs={noop} />,
    );
    expect(screen.getByRole('button', { name: '启动' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: '停止' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: '重启' }).disabled).toBe(true);
  });

  it('运行中：可以停止与重启，启动禁用', () => {
    render(
      <ServiceCard
        service={service({ status: 'running', pid: 1 })}
        onStart={noop}
        onStop={noop}
        onRestart={noop}
        onEdit={noop}
        onDelete={noop}
        onOpenLogs={noop}
      />,
    );
    expect(screen.getByRole('button', { name: '启动' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: '停止' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: '重启' }).disabled).toBe(false);
  });

  it('操作进行中：三个按钮全禁用并给出「启动中…」反馈，避免重复点击', () => {
    render(
      <ServiceCard
        service={service()}
        busy="start"
        onStart={noop}
        onStop={noop}
        onRestart={noop}
        onEdit={noop}
        onDelete={noop}
        onOpenLogs={noop}
      />,
    );
    expect(screen.getByRole('button', { name: '启动中…' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: '停止' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: '重启' }).disabled).toBe(true);
  });

  it('启动失败：把状态原因与启动诊断一并展示（§8.5 起不来要看得到原因）', () => {
    render(
      <ServiceCard
        service={service({
          status: 'start_failed',
          exitCode: 1,
          statusMessage: '启动后立即退出（退出码 1）',
          startupDiagnostics: ['Error: cannot find module server.js'],
        })}
        onStart={noop}
        onStop={noop}
        onRestart={noop}
        onEdit={noop}
        onDelete={noop}
        onOpenLogs={noop}
      />,
    );
    expect(screen.getByText('启动失败')).toBeTruthy();
    expect(screen.getByText(/启动后立即退出/)).toBeTruthy();
    expect(screen.getByText(/cannot find module/)).toBeTruthy();
  });

  it('回调：启动 / 停止 / 重启 / 编辑 / 删除 / 看日志都带上服务 id', async () => {
    const user = userEvent.setup();
    const handlers = {
      onStart: vi.fn(),
      onStop: vi.fn(),
      onRestart: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onOpenLogs: vi.fn(),
    };
    render(<ServiceCard service={service({ status: 'running', pid: 9 })} {...handlers} />);

    await user.click(screen.getByRole('button', { name: '停止' }));
    await user.click(screen.getByRole('button', { name: '重启' }));
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.click(screen.getByRole('button', { name: '看日志' }));

    expect(handlers.onStop).toHaveBeenCalledWith('s1');
    expect(handlers.onRestart).toHaveBeenCalledWith('s1');
    expect(handlers.onEdit).toHaveBeenCalledWith('s1');
    expect(handlers.onOpenLogs).toHaveBeenCalledWith('s1');
    expect(handlers.onStart).not.toHaveBeenCalled();
  });

  it('删除需要二次确认（防误删配置）', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <ServiceCard service={service()} onStart={noop} onStop={noop} onRestart={noop} onEdit={noop} onDelete={onDelete} onOpenLogs={noop} />,
    );

    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(onDelete).toHaveBeenCalledWith('s1');
  });

  it('被选中的卡片有 aria-current 标记（详情面板与列表的对应关系）', () => {
    render(
      <ServiceCard
        service={service()}
        active
        onStart={noop}
        onStop={noop}
        onRestart={noop}
        onEdit={noop}
        onDelete={noop}
        onOpenLogs={noop}
      />,
    );
    expect(screen.getByRole('article').getAttribute('aria-current')).toBe('true');
  });
});
