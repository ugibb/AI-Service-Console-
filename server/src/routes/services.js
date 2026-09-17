/**
 * 服务配置 CRUD（T1.6）。
 *
 * GET    /api/services       列表（含运行时 status / pid / exitCode）
 * GET    /api/services/:id   详情（含启动诊断输出）
 * POST   /api/services       新增
 * PUT    /api/services/:id   编辑
 * DELETE /api/services/:id   删除
 */
import { Router } from 'express';
import { AppError, ERROR_CODES, serviceNotFound } from '../lib/errors.js';
import { serializeService, serializeServiceList } from '../services/serialize.js';
import { sendOk } from './respond.js';

export function createServicesRouter({ store, procManager, config }) {
  const router = Router();

  router.get('/', (req, res) => {
    sendOk(res, {
      services: serializeServiceList(store.list(), procManager.snapshot()),
      warnings: store.warnings(),
      poll: { logsMs: config.poll.logsMs, servicesMs: config.poll.servicesMs },
    });
  });

  router.get('/:id', (req, res) => {
    const service = store.get(req.params.id);
    if (!service) throw serviceNotFound(req.params.id);
    sendOk(res, serializeService(service, procManager.getState(service.id), { includeDiagnostics: true }));
  });

  router.post('/', async (req, res) => {
    const service = await store.create(req.body);
    sendOk(res, serializeService(service, procManager.getState(service.id), { includeDiagnostics: true }), 201);
  });

  router.put('/:id', async (req, res) => {
    const existing = store.get(req.params.id);
    if (!existing) throw serviceNotFound(req.params.id);
    if (procManager.isBusy(existing.id)) {
      // 运行中改名/改路径会让「停止」指向错误的目标，先拒绝，让用户显式停止
      throw new AppError(ERROR_CODES.CONFLICT, '服务正在启动/运行/停止中，请先停止服务再修改配置', {
        status: 409,
        details: { id: existing.id },
      });
    }
    const updated = await store.update(existing.id, req.body);
    sendOk(res, serializeService(updated, procManager.getState(updated.id), { includeDiagnostics: true }));
  });

  router.delete('/:id', async (req, res) => {
    const existing = store.get(req.params.id);
    if (!existing) throw serviceNotFound(req.params.id);
    if (procManager.isBusy(existing.id)) {
      // 删掉配置 = 丢掉唯一能停止它的 PID 记录，必然留下孤儿进程 → 显式拒绝
      throw new AppError(ERROR_CODES.CONFLICT, '服务正在启动/运行/停止中，请先停止服务再删除', {
        status: 409,
        details: { id: existing.id },
      });
    }
    await store.remove(existing.id);
    sendOk(res, { id: existing.id, removed: true });
  });

  return router;
}
