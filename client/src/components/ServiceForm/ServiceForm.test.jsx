import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServiceForm } from './ServiceForm.jsx';

const fill = async (user, values) => {
  for (const [label, value] of Object.entries(values)) {
    const input = screen.getByLabelText(label);
    await user.clear(input);
    if (value !== '') await user.type(input, value);
  }
};

const validInput = {
  名称: '订单服务',
  工作目录: 'C:\\services\\order',
  启动脚本: 'C:\\services\\order\\start.bat',
  日志文件: 'C:\\services\\order\\app.log',
  端口: '8081',
};

describe('ServiceForm', () => {
  it('新增模式：标题为「新增服务」，五个字段都在', () => {
    render(<ServiceForm onSubmit={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('heading', { name: '新增服务' })).toBeTruthy();
    for (const label of Object.keys(validInput)) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  it('提交合法值：回调收到 trim 后的字段，端口转数字', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ServiceForm onSubmit={onSubmit} onCancel={() => {}} />);

    await fill(user, { ...validInput, 名称: '  订单服务  ' });
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: '订单服务',
      workDir: 'C:\\services\\order',
      startScript: 'C:\\services\\order\\start.bat',
      logFile: 'C:\\services\\order\\app.log',
      port: 8081,
    });
  });

  it('端口留空 → port 为 null（仅记录展示，非必填）', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ServiceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fill(user, { ...validInput, 端口: '' });
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ port: null }));
  });

  it('必填缺失：前端即时拦截，不调用 onSubmit，并逐字段给中文提示', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ServiceForm onSubmit={onSubmit} onCancel={() => {}} />);

    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('名称不能为空')).toBeTruthy();
    expect(screen.getByText('工作目录不能为空')).toBeTruthy();
    expect(screen.getByText('启动脚本不能为空')).toBeTruthy();
    expect(screen.getByText('日志文件不能为空')).toBeTruthy();
  });

  it('端口越界或非数字被拦截', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ServiceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fill(user, validInput);
    await user.clear(screen.getByLabelText('端口'));
    await user.type(screen.getByLabelText('端口'), '70000');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/1-65535/)).toBeTruthy();
  });

  it('路径含 cmd 特殊字符被拦截（与后端同一条规则的镜像提示）', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ServiceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fill(user, { ...validInput, 启动脚本: 'C:\\a&b\\start.bat' });
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/cmd 特殊字符/)).toBeTruthy();
  });

  it('编辑模式：用 initialValue 预填，标题为「编辑服务」', () => {
    render(
      <ServiceForm
        initialValue={{ name: '推理服务', workDir: 'C:\\ai', startScript: 'C:\\ai\\run.bat', logFile: 'C:\\ai\\out.log', port: 9000 }}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { name: '编辑服务' })).toBeTruthy();
    expect(screen.getByLabelText('名称').value).toBe('推理服务');
    expect(screen.getByLabelText('端口').value).toBe('9000');
  });

  it('提交中：按钮禁用且显示「保存中…」，防重复提交', () => {
    render(<ServiceForm onSubmit={() => {}} onCancel={() => {}} submitting />);
    expect(screen.getByRole('button', { name: '保存中…' }).disabled).toBe(true);
  });

  it('服务端返回的错误会展示在表单顶部', () => {
    render(<ServiceForm onSubmit={() => {}} onCancel={() => {}} error={{ message: '启动脚本路径不存在' }} />);
    expect(screen.getByRole('alert').textContent).toContain('启动脚本路径不存在');
  });

  it('取消：回调被调用（不提交）', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ServiceForm onSubmit={() => {}} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
