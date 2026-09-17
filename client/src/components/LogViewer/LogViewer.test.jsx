import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogViewer } from './LogViewer.jsx';

const service = { id: 's1', name: '订单服务', logFile: 'C:\\svc\\app.log' };

const payload = (over = {}) => ({
  serviceId: 's1',
  path: 'C:\\svc\\app.log',
  tail: 500,
  available: true,
  kind: null,
  message: null,
  lines: ['2026-09-17 10:00:01 INFO 启动成功', '2026-09-17 10:00:02 ERROR 数据库连接超时'],
  lineCount: 2,
  hasMore: false,
  truncatedLines: 0,
  encoding: 'utf8',
  fileSize: 128,
  mtime: Date.now(),
  ...over,
});

const makeApi = (result) => ({ getLogs: vi.fn(async () => result) });

describe('LogViewer', () => {
  it('渲染日志行、编码与读取路径（用户要知道读的是哪个文件）', async () => {
    render(<LogViewer service={service} api={makeApi(payload())} intervalMs={1000} />);
    await waitFor(() => expect(screen.getByText(/启动成功/)).toBeTruthy());
    expect(screen.getByText(/数据库连接超时/)).toBeTruthy();
    expect(screen.getByText(/C:\\svc\\app\.log/)).toBeTruthy();
    expect(screen.getByText(/utf-8/i)).toBeTruthy();
  });

  it('1s 轮询：间隔到达后会再次拉取尾部（PRD §8.4 实时性靠轮询）', async () => {
    vi.useFakeTimers();
    const api = makeApi(payload());
    render(<LogViewer service={service} api={api} intervalMs={1000} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.getLogs).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(api.getLogs).toHaveBeenCalledTimes(2);
    expect(api.getLogs).toHaveBeenCalledWith('s1', { tail: 500 });
  });

  it('关键字过滤：只保留命中的行，并显示命中数（US-5）', async () => {
    const user = userEvent.setup();
    render(<LogViewer service={service} api={makeApi(payload())} intervalMs={1000} />);
    await waitFor(() => expect(screen.getByText(/启动成功/)).toBeTruthy());

    await user.type(screen.getByLabelText('关键字过滤'), 'ERROR');
    expect(screen.getByText(/数据库连接超时/)).toBeTruthy();
    expect(screen.queryByText(/启动成功/)).toBeNull();
    expect(screen.getByText(/命中 1 \/ 2 行/)).toBeTruthy();
  });

  it('过滤无命中：给出明确空结果文案，而不是一片空白', async () => {
    const user = userEvent.setup();
    render(<LogViewer service={service} api={makeApi(payload())} intervalMs={1000} />);
    await waitFor(() => expect(screen.getByText(/启动成功/)).toBeTruthy());
    await user.type(screen.getByLabelText('关键字过滤'), '不存在的关键字');
    expect(screen.getByText(/没有匹配/)).toBeTruthy();
  });

  it('日志文件不存在 → 显示后端降级文案，不报错、不显示空日志壳', async () => {
    render(
      <LogViewer
        service={service}
        api={makeApi(payload({ available: false, kind: 'missing', message: '日志文件尚未生成（服务可能未启动，或尚未产生输出）', lines: [], lineCount: 0 }))}
        intervalMs={1000}
      />,
    );
    await waitFor(() => expect(screen.getByText(/日志文件尚未生成/)).toBeTruthy());
  });

  it('日志文件为空 → 提示「已存在但内容为空」', async () => {
    render(
      <LogViewer
        service={service}
        api={makeApi(payload({ message: '日志文件已存在，但当前内容为空', lines: [], lineCount: 0 }))}
        intervalMs={1000}
      />,
    );
    await waitFor(() => expect(screen.getByText(/内容为空/)).toBeTruthy());
  });

  it('接口失败 → 展示错误且不中断轮询', async () => {
    vi.useFakeTimers();
    const api = { getLogs: vi.fn().mockRejectedValueOnce(new Error('接口挂了')).mockResolvedValue(payload()) };
    render(<LogViewer service={service} api={api} intervalMs={1000} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('alert').textContent).toContain('接口挂了');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(api.getLogs).toHaveBeenCalledTimes(2);
  });

  it('GBK 解码后的中文按原样显示（前端不做二次猜测）', async () => {
    render(
      <LogViewer
        service={service}
        api={makeApi(payload({ encoding: 'gbk', lines: ['服务启动成功', '连接数据库失败：超时'] }))}
        intervalMs={1000}
      />,
    );
    await waitFor(() => expect(screen.getByText('连接数据库失败：超时')).toBeTruthy());
    expect(screen.getByText(/gbk/i)).toBeTruthy();
  });

  it('超长行被后端截断时给出提示', async () => {
    render(<LogViewer service={service} api={makeApi(payload({ truncatedLines: 2 }))} intervalMs={1000} />);
    await waitFor(() => expect(screen.getByText(/2 行过长已截断/)).toBeTruthy());
  });

  it('关闭按钮回调 onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<LogViewer service={service} api={makeApi(payload())} intervalMs={1000} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: '关闭日志' }));
    expect(onClose).toHaveBeenCalled();
  });
});
