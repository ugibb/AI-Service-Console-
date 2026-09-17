/**
 * Express 应用组装（T1.9）。
 *
 * 生产模式：单端口同时提供 API 与前端静态资源（PRD §10）。
 * 这里不负责 listen，方便在测试里用 supertest 风格直接打 app（无需真实端口）。
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { AppError, ERROR_CODES } from './lib/errors.js';
import { errorBody } from './routes/respond.js';
import { createHealthRouter } from './routes/health.js';
import { createServicesRouter } from './routes/services.js';
import { createActionsRouter } from './routes/actions.js';
import { createLogsRouter } from './routes/logs.js';

const FALLBACK_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>本地服务控制台</title>
<style>body{font-family:ui-monospace,Consolas,monospace;background:#12151b;color:#d7dde8;padding:2.5rem;line-height:1.7}
code{background:#1d222c;padding:.15rem .4rem;border-radius:4px;color:#7fd1c8}h1{font-size:1.2rem}</style></head>
<body><h1>后端已就绪，但未找到前端构建产物</h1>
<p>请先构建前端，再刷新本页：</p>
<p><code>npm run build</code></p>
<p>或开发模式（前端 5173，API 代理到 3010）：<code>npm run dev</code></p>
<p>API 健康检查：<code>/api/health</code></p>
</body></html>`;

function requestLogger(logger) {
  return (req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.debug?.(`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - startedAt}ms)`);
    });
    next();
  };
}

function parseErrorHandler() {
  return (err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
      next(new AppError(ERROR_CODES.BAD_REQUEST, '请求体不是合法 JSON', { status: 400 }));
      return;
    }
    next(err);
  };
}

/**
 * @param {{ store: object, procManager: object, config: object, logger?: object, startedAt?: number }} deps
 * @returns {import('express').Express}
 */
export function createApp({ store, procManager, config, logger = console, startedAt = Date.now() }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.jsonBodyLimit }));
  app.use(parseErrorHandler());
  app.use(requestLogger(logger));

  app.use('/api/health', createHealthRouter({ config, startedAt }));
  app.use('/api/services', createActionsRouter({ store, procManager }));
  app.use('/api/services', createLogsRouter({ store, config }));
  app.use('/api/services', createServicesRouter({ store, procManager, config }));

  app.use('/api', (req, res) => {
    res.status(404).json(errorBody(new AppError(ERROR_CODES.NOT_FOUND, `接口不存在：${req.method} ${req.originalUrl}`, { status: 404 })));
  });

  mountClient(app, { config, logger });

  // eslint-disable-next-line no-unused-vars -- Express 靠 4 个参数识别错误中间件
  app.use((err, req, res, next) => {
    if (err instanceof AppError || err?.expose) {
      res.status(err.status ?? 500).json(errorBody(err));
      return;
    }
    logger.error?.(`未处理异常 ${req.method} ${req.originalUrl}：${err?.stack ?? err}`);
    res.status(500).json(errorBody(new AppError(ERROR_CODES.INTERNAL_ERROR, '服务器内部错误，请查看控制台日志')));
  });

  return app;
}

/** 生产模式托管前端构建产物 + SPA 兜底路由 */
function mountClient(app, { config, logger }) {
  if (!config.serveClient) return;
  const distDir = config.clientDistDir;
  const indexHtml = path.join(distDir, 'index.html');

  if (!fs.existsSync(indexHtml)) {
    logger.warn?.(`未找到前端构建产物（${indexHtml}），当前仅提供 API。执行 npm run build 后重启即可。`);
    app.get('/', (req, res) => res.status(200).type('html').send(FALLBACK_HTML));
    return;
  }

  app.use(express.static(distDir, { index: 'index.html', maxAge: '1h' }));
  // SPA 兜底：非 /api 的 GET/HEAD 请求一律回 index.html（不写成通配路由，规避 Express 5 路径语法差异）
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/')) return next();
    if (!req.accepts('html')) return next();
    return res.sendFile(indexHtml);
  });
}
