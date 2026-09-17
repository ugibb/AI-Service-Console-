/**
 * 浏览器 E2E：真实浏览器 → 真实 HTTP 后端 → 真实 logTail。
 *
 * 覆盖 PRD 的关键用户流程（T1.20 的 Mac 可验部分）：
 *   登记服务 → 启动 → 看状态 → 看日志（1s 刷新）→ 停止
 * 以及启动失败诊断（PRD §12 首行）。
 *
 * 注意：进程启停由测试夹具模拟（理由见 console-server.mjs 顶部注释），
 * Windows 上的真实 spawn/taskkill 不在这里验证。
 */
import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { LOG_FILE, MISSING_SCRIPT, SCRIPT, WORK_DIR } from './e2e-env.mjs';

/** 用 UI 登记一个服务（走真实表单 + 真实 POST /api/services） */
async function registerService(page, { name, startScript }) {
  await page.getByRole('button', { name: '新增服务' }).click();
  await expect(page.getByRole('heading', { name: '新增服务' })).toBeVisible();

  await page.getByLabel('名称').fill(name);
  await page.getByLabel('工作目录').fill(WORK_DIR);
  await page.getByLabel('启动脚本').fill(startScript);
  await page.getByLabel('日志文件').fill(LOG_FILE);
  await page.getByLabel('端口').fill('8081');
  await page.getByRole('button', { name: '保存', exact: true }).click();

  await expect(page.getByRole('heading', { name: '新增服务' })).toBeHidden();
  await expect(page.getByRole('heading', { name, level: 3 })).toBeVisible();
}

test('关键流程：登记 → 启动 → 运行中 → 日志 1s 刷新 → 停止', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('AI Service Console');

  // 空状态引导（PRD §12「无任何服务」）
  await expect(page.getByText('还没有登记任何服务')).toBeVisible();

  await registerService(page, { name: '订单服务', startScript: SCRIPT });

  // 登记后是已停止
  const card = page.locator('article.service-card').filter({ hasText: '订单服务' });
  await expect(card.locator('.status-badge')).toHaveAttribute('data-status', 'stopped');

  // 启动 → 运行中
  await card.getByRole('button', { name: '启动', exact: true }).click();
  await expect(card.locator('.status-badge')).toHaveAttribute('data-status', 'running', { timeout: 8000 });
  await expect(card.getByText(/运行中/)).toBeVisible();

  // 看日志：文件还没生成时应给出降级引导，而不是报错
  await card.getByRole('button', { name: '看日志' }).click();
  const viewer = page.getByRole('region', { name: '订单服务 的日志' });
  await expect(viewer.getByText('日志文件尚未生成（服务可能未启动，或尚未产生输出）')).toBeVisible();

  // 服务开始写日志 → 1s 轮询内应自动出现（PRD §8.4 / US-4）
  await fs.writeFile(LOG_FILE, '第一行：服务启动成功\n第二行：连接数据库失败：超时\n');
  await expect(viewer.getByText('第一行：服务启动成功')).toBeVisible({ timeout: 8000 });
  await expect(viewer.getByText('第二行：连接数据库失败：超时')).toBeVisible({ timeout: 8000 });

  // 追加新行 → 再次刷新（验证轮询在持续工作，而不是只拉了一次）
  await fs.appendFile(LOG_FILE, '第三行：重试成功\n');
  await expect(viewer.getByText('第三行：重试成功')).toBeVisible({ timeout: 8000 });

  // 关键字过滤（客户端过滤，US-5）
  await viewer.getByPlaceholder('例如 ERROR / 超时 / 端口').fill('超时');
  await expect(viewer.getByText('第二行：连接数据库失败：超时')).toBeVisible();
  await expect(viewer.getByText('第一行：服务启动成功')).toBeHidden();
  await expect(viewer.getByText(/命中 1 \/ 3 行/)).toBeVisible();
  await viewer.getByPlaceholder('例如 ERROR / 超时 / 端口').fill('');

  // 停止 → 已停止
  await card.getByRole('button', { name: '停止', exact: true }).click();
  await expect(card.locator('.status-badge')).toHaveAttribute('data-status', 'stopped', { timeout: 8000 });
});

test('启动失败诊断：脚本路径不存在 → 启动失败 + 可读原因（PRD §12 首行）', async ({ page }) => {
  await page.goto('/');
  await registerService(page, { name: '缺脚本服务', startScript: MISSING_SCRIPT });

  const card = page.locator('article.service-card').filter({ hasText: '缺脚本服务' });
  await card.getByRole('button', { name: '启动', exact: true }).click();

  await expect(card.locator('.status-badge')).toHaveAttribute('data-status', 'start_failed', { timeout: 8000 });
  await expect(card.getByText(/启动脚本不可用/)).toBeVisible();
});
