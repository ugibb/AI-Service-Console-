/**
 * 日志读取 API（T1.8）。
 *
 * GET /api/services/:id/logs?tail=500
 *
 * 关键点：
 * - 每次请求都重新 tail 文件尾部（全量 tail）→ 文件被轮转 / 截断都天然免疫（PRD §8.2）。
 * - 文件不存在 / 是目录 / 无权限 → 仍然返回 HTTP 200，用 available=false + kind + message
 *   表达降级状态（这不是请求错误，而是「服务还没写日志」的正常情况），前端据此显示引导文案。
 */
import { Router } from 'express';
import { serviceNotFound } from '../lib/errors.js';
import { tailFile } from '../logs/logTail.js';
import { resolveServicePaths } from '../services/paths.js';
import { sendOk } from './respond.js';

const DEGRADED_MESSAGES = Object.freeze({
  missing: '日志文件尚未生成（服务可能未启动，或尚未产生输出）',
  directory: '配置的日志路径是一个目录，不是文件；请检查服务配置',
  permission: '没有读取该日志文件的权限；请检查文件 ACL 或换个日志路径',
  unknown: '读取日志文件失败',
});

export function createLogsRouter({ store, config }) {
  const router = Router();

  function parseTail(rawTail) {
    const fallback = config.log.defaultTailLines;
    if (rawTail === undefined || rawTail === '') return fallback;
    const value = Number(rawTail);
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.min(Math.floor(value), config.log.maxTailLines);
  }

  router.get('/:id/logs', async (req, res) => {
    const service = store.get(req.params.id);
    if (!service) throw serviceNotFound(req.params.id);

    const paths = resolveServicePaths(service);
    const tail = parseTail(req.query.tail);
    const result = await tailFile(paths.logPath, {
      lines: tail,
      chunkSize: config.log.chunkSize,
      maxLineBytes: config.log.maxLineBytes,
      fallbackEncoding: config.log.fallbackEncoding,
    });

    if (!result.ok) {
      sendOk(res, {
        serviceId: service.id,
        path: paths.logPath,
        tail,
        available: false,
        kind: result.kind,
        code: result.code,
        message: DEGRADED_MESSAGES[result.kind] ?? result.message,
        detail: result.message,
        lines: [],
        lineCount: 0,
        hasMore: false,
        truncatedLines: 0,
        encoding: null,
        fileSize: null,
        mtime: null,
      });
      return;
    }

    sendOk(res, {
      serviceId: service.id,
      path: paths.logPath,
      tail,
      available: true,
      kind: null,
      code: null,
      message: result.emptyFile ? '日志文件已存在，但当前内容为空' : null,
      lines: result.lines,
      lineCount: result.lineCount,
      hasMore: result.hasMore,
      truncatedLines: result.truncatedLines,
      encoding: result.encoding,
      fileSize: result.fileSize,
      mtime: result.mtime,
    });
  });

  return router;
}
