/**
 * GET /api/health —— 前后端联调探针（T0.4）。
 * 同时把前端轮询间隔下发给前端，便于统一调整节奏。
 *
 * adapter 字段报告的是**实际生效的**适配器平台（`procManager.platform`），不是配置里写的值：
 * 配置默认 win32，但在 macOS 上 selectAdapter 会降级成 unsupported 占位适配器，
 * 若这里仍回 config.adapter，就会在同一份响应里出现
 * `platform:"darwin"` + `adapter:"win32"` 这种自相矛盾、会误导排障的信息。
 * 配置值保留在 adapterConfigured，两者口径分开。
 */
import { Router } from 'express';
import { sendOk } from './respond.js';

export function createHealthRouter({ config, procManager, startedAt = Date.now() }) {
  const router = Router();

  router.get('/', (req, res) => {
    sendOk(res, {
      status: 'ok',
      version: '1.0.0',
      nodeEnv: config.nodeEnv,
      platform: process.platform,
      adapter: procManager?.platform ?? config.adapter,
      adapterConfigured: config.adapter,
      adapterSupported: procManager ? procManager.isSupported() : true,
      uptimeMs: Date.now() - startedAt,
      now: new Date().toISOString(),
      poll: { logsMs: config.poll.logsMs, servicesMs: config.poll.servicesMs },
      log: { defaultTailLines: config.log.defaultTailLines, maxTailLines: config.log.maxTailLines },
    });
  });

  return router;
}
