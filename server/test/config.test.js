import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig, PROJECT_ROOT } from '../src/config.js';

test('loadConfig：默认值符合 PRD（127.0.0.1:3010，tail 500，GBK 回退）', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.port, 3010);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.adapter, 'win32');
  assert.equal(cfg.log.defaultTailLines, 500);
  assert.equal(cfg.log.fallbackEncoding, 'gbk');
  assert.equal(cfg.log.preferredEncoding, 'utf8');
  assert.equal(cfg.proc.startFailureWindowMs, 5000);
  assert.equal(cfg.proc.startupGraceMs, 5000, '启动宽限期默认 5000ms');
  assert.equal(cfg.proc.stopGraceTimeoutMs, 5000);
  assert.equal(cfg.poll.logsMs, 1000);
  assert.equal(cfg.poll.servicesMs, 1500);
  assert.equal(cfg.servicesFile, path.join(PROJECT_ROOT, 'data', 'services.json'));
  assert.deepEqual(cfg.warnings, []);
});

test('loadConfig：环境变量可覆盖端口 / 绑定地址 / 数据目录（默认值不写死）', () => {
  const cfg = loadConfig({
    LSC_PORT: '4321',
    LSC_HOST: '0.0.0.0',
    LSC_DATA_DIR: './tmp-data',
    LSC_LOG_TAIL_LINES: '1200',
    LSC_POLL_LOGS_MS: '2500',
    LSC_STARTUP_GRACE_MS: '60000',
    LSC_SERVE_CLIENT: '0',
  });
  assert.equal(cfg.port, 4321);
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.log.defaultTailLines, 1200);
  assert.equal(cfg.poll.logsMs, 2500);
  assert.equal(cfg.proc.startupGraceMs, 60000, '全局默认宽限期可用 LSC_STARTUP_GRACE_MS 调整（AI 服务场景）');
  assert.equal(cfg.serveClient, false);
  assert.ok(path.isAbsolute(cfg.dataDir), '数据目录应被解析为绝对路径');
  assert.ok(cfg.dataDir.endsWith(`${path.sep}tmp-data`));
});

test('loadConfig：非法数值回退默认值并给出告警（不静默失败）', () => {
  const cfg = loadConfig({ LSC_PORT: 'abc', LSC_LOG_TAIL_LINES: '0', LSC_STOP_GRACE_MS: '-5' });
  assert.equal(cfg.port, 3010);
  assert.equal(cfg.log.defaultTailLines, 500);
  assert.equal(cfg.proc.stopGraceTimeoutMs, 5000);
  assert.equal(cfg.warnings.length, 3);
  assert.ok(cfg.warnings.every((w) => w.includes('已回退默认值')));
});

test('loadConfig：非法的适配器取值回退到 win32 并告警', () => {
  const cfg = loadConfig({ LSC_PROC_ADAPTER: 'posix' });
  assert.equal(cfg.adapter, 'win32');
  assert.equal(cfg.warnings.length, 1);
  assert.match(cfg.warnings[0], /LSC_PROC_ADAPTER/);
});

test('loadConfig：返回对象是冻结的，子对象同样冻结（防误改）', () => {
  const cfg = loadConfig({});
  assert.equal(Object.isFrozen(cfg), true);
  assert.equal(Object.isFrozen(cfg.log), true);
  assert.equal(Object.isFrozen(cfg.proc), true);
  assert.equal(Object.isFrozen(cfg.poll), true);
});
