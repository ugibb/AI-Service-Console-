/**
 * GET /api/health —— 前后端联调探针（T0.4）。
 * 同时把前端轮询间隔下发给前端，便于统一调整节奏。
 */
import { Router } from 'express';
import { sendOk } from './respond.js';

export function createHealthRouter({ config, startedAt = Date.now() }) {
  const router = Router();

  router.get('/', (req, res) => {
    sendOk(res, {
      status: 'ok',
      version: '1.0.0',
      nodeEnv: config.nodeEnv,
      platform: process.platform,
      adapter: config.adapter,
      uptimeMs: Date.now() - startedAt,
      now: new Date().toISOString(),
      poll: { logsMs: config.poll.logsMs, servicesMs: config.poll.servicesMs },
      log: { defaultTailLines: config.log.defaultTailLines, maxTailLines: config.log.maxTailLines },
    });
  });

  return router;
}
