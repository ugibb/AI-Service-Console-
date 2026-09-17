/**
 * 启停操作 API（T1.7）。
 *
 * POST /api/services/:id/start
 * POST /api/services/:id/stop
 * POST /api/services/:id/restart
 *
 * 返回体固定为 { action, service }：service 是操作后的最新状态（含启动诊断输出），
 * 前端据此立刻更新 UI，无需等下一次轮询。
 */
import { Router } from 'express';
import { AppError, ERROR_CODES, serviceNotFound } from '../lib/errors.js';
import { UNSUPPORTED_MESSAGE } from '../proc/adapter.js';
import { serializeService } from '../services/serialize.js';
import { sendOk } from './respond.js';

export function createActionsRouter({ store, procManager }) {
  const router = Router();

  function requireServiceId(rawId) {
    const service = store.get(rawId);
    if (!service) throw serviceNotFound(rawId);
    return service.id;
  }

  /**
   * 平台能力检查：非 Windows 上适配器是占位实现。
   * 这里显式返回 501，而不是让「平台不支持」混进服务的 start_failed 状态里
   * ——前者是环境限制（前端该出横幅），后者是服务自身的问题（前端该出诊断）。
   */
  function requireSupportedPlatform() {
    if (procManager.isSupported()) return;
    throw new AppError(ERROR_CODES.ADAPTER_UNSUPPORTED, UNSUPPORTED_MESSAGE, {
      status: 501,
      details: { platform: procManager.platform },
    });
  }

  function payload(actionName, id, extra = {}) {
    return {
      action: { name: actionName, ...extra },
      service: serializeService(store.get(id), procManager.getState(id), { includeDiagnostics: true }),
    };
  }

  router.post('/:id/start', async (req, res) => {
    const id = requireServiceId(req.params.id);
    requireSupportedPlatform();
    await procManager.start(id);
    sendOk(res, payload('start', id));
  });

  router.post('/:id/stop', async (req, res) => {
    const id = requireServiceId(req.params.id);
    requireSupportedPlatform();
    const result = await procManager.stop(id);
    sendOk(
      res,
      payload('stop', id, {
        forced: Boolean(result.forced),
        alreadyStopped: Boolean(result.alreadyStopped),
        killFailed: Boolean(result.killFailed),
      }),
    );
  });

  router.post('/:id/restart', async (req, res) => {
    const id = requireServiceId(req.params.id);
    requireSupportedPlatform();
    await procManager.restart(id);
    sendOk(res, payload('restart', id));
  });

  return router;
}
