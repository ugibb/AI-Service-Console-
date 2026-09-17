import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.jsx';
import { createServicesStore } from './store/servicesStore.js';

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

function makeApi(over = {}) {
  return {
    listServices: vi.fn(async () => ({ services: [service()], warnings: [], poll: { logsMs: 1000, servicesMs: 1500 } })),
    createService: vi.fn(async (input) => service({ id: 'new', ...input })),
    updateService: vi.fn(async (id, input) => service({ id, ...input })),
    deleteService: vi.fn(async () => ({ removed: true })),
    startService: vi.fn(async (id) => ({ action: { name: 'start' }, service: service({ id, status: 'running', pid: 1 }) })),
    stopService: vi.fn(async (id) => ({ action: { name: 'stop' }, service: service({ id }) })),
    restartService: vi.fn(async (id) => ({ action: { name: 'restart' }, service: service({ id, status: 'running', pid: 2 }) })),
    getLogs: vi.fn(async () => ({
      serviceId: 's1',
      path: 'C:\\svc\\app.log',
      available: true,
      lines: ['hello-log-line'],
      lineCount: 1,
      hasMore: false,
      truncatedLines: 0,
      encoding: 'utf8',
      message: null,
    })),
    ...over,
  };
}

function setup(api = makeApi()) {
  const store = createServicesStore({ api });
  render(<App api={api} store={store} servicesPollMs={1_000_000} logsPollMs={1_000_000} />);
  return { api, store };
}

describe('App', () => {
  it('挂载即拉取服务列表并渲染（列表 + 详情两栏布局）', async () => {
    const { api } = setup();
    await waitFor(() => expect(screen.getByText('订单服务')).toBeTruthy());
    expect(api.listServices).toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('AI Service Console');
    expect(screen.getByRole('main')).toBeTruthy();
  });

  it('顶部统计：服务总数与运行中数量', async () => {
    setup(makeApi({
      listServices: vi.fn(async () => ({
        services: [service({ status: 'running' }), service({ id: 's2', name: '推理服务' })],
        warnings: [],
        poll: { logsMs: 1000, servicesMs: 1500 },
      })),
    }));
    await waitFor(() => expect(screen.getByText(/共 2 个服务/)).toBeTruthy());
    expect(screen.getByText(/运行中 1/)).toBeTruthy();
  });

  it('点「新增服务」打开表单，提交后调用 createService 并关闭表单', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await waitFor(() => expect(screen.getByText('订单服务')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '新增服务' }));
    expect(screen.getByRole('heading', { name: '新增服务' })).toBeTruthy();

    await user.type(screen.getByLabelText('名称'), '新服务');
    await user.type(screen.getByLabelText('工作目录'), 'C:\\new');
    await user.type(screen.getByLabelText('启动脚本'), 'C:\\new\\start.bat');
    await user.type(screen.getByLabelText('日志文件'), 'C:\\new\\app.log');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(api.createService).toHaveBeenCalledWith(expect.objectContaining({ name: '新服务' })));
    await waitFor(() => expect(screen.queryByRole('heading', { name: '新增服务' })).toBeNull());
  });

  it('点「启动」调用后端 action（省掉找目录/记命令的核心动作）', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await waitFor(() => expect(screen.getByText('订单服务')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '启动' }));
    await waitFor(() => expect(api.startService).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(screen.getByText('运行中')).toBeTruthy());
  });

  it('点「看日志」切到详情日志视图，并按 1s 节奏拉取（此处用超大间隔只验证首拉）', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await waitFor(() => expect(screen.getByText('订单服务')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '看日志' }));
    await waitFor(() => expect(api.getLogs).toHaveBeenCalledWith('s1', { tail: 500 }));
    await waitFor(() => expect(screen.getByText('hello-log-line')).toBeTruthy());
  });

  it('列表加载失败：顶部展示错误横幅且可关闭', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.listServices = vi.fn().mockRejectedValue(Object.assign(new Error('连接不上后端'), { code: 'NETWORK_ERROR' }));
    setup(api);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('连接不上后端'));
    await user.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('编辑：点「编辑」打开带预填值的表单，保存走 updateService', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await waitFor(() => expect(screen.getByText('订单服务')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '编辑' }));
    expect(screen.getByRole('heading', { name: '编辑服务' })).toBeTruthy();
    expect(screen.getByLabelText('名称').value).toBe('订单服务');

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.updateService).toHaveBeenCalledWith('s1', expect.objectContaining({ name: '订单服务' })));
  });

  it('删除：确认后调用 deleteService 并收起详情视图', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await waitFor(() => expect(screen.getByText('订单服务')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '删除' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(api.deleteService).toHaveBeenCalledWith('s1'));
  });
});
