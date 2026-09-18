import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig, PROJECT_ROOT } from '../src/config.js';
import { DEFAULT_PROFILE, DEV_CLIENT_PORT, PROFILE_NAMES, PROFILES, overriddenKeys, profileEnv, readProfileArg } from '../src/profiles.js';

/** 展开某个档案并交给 loadConfig，等价于 index.js 启动时做的事（base 传空 {} 以免被真实 process.env 干扰） */
const profileConfig = (name, base = {}) => loadConfig(profileEnv(name, { root: PROJECT_ROOT, base }));

test('readProfileArg：没有 --env= 时返回 null（由调用方套默认档）', () => {
  assert.equal(readProfileArg(['node', 'src/index.js']), null);
  assert.equal(readProfileArg([]), null);
  assert.equal(readProfileArg(['--env']), null, '--env 不带 = 不算数');
});

test('readProfileArg：认得两个档案名', () => {
  assert.equal(readProfileArg(['node', 'index.js', '--env=development']), 'development');
  assert.equal(readProfileArg(['node', 'index.js', '--env=production']), 'production');
  assert.equal(readProfileArg(['node', 'index.js', '--env=development', '--env=production']), 'development', '取第一个');
});

test('readProfileArg：认不出的档案名直接报错，不回退默认档', () => {
  // 静默回退是最坏的结果：--env=dev 是个笔误，人以为在开发，实际起在生产档 3010，
  // 而开发档与生产档共用 data/ 台账——写进去的每一笔都是真的。
  assert.throws(() => readProfileArg(['node', 'index.js', '--env=dev']), /未知的环境档案 --env=dev/);
  assert.throws(() => readProfileArg(['node', 'index.js', '--env=']), /未知的环境档案/);
});

test('DEFAULT_PROFILE 是 production（desktop / e2e / 打包验证都不带 --env）', () => {
  assert.equal(DEFAULT_PROFILE, 'production');
  assert.ok(PROFILE_NAMES.includes(DEFAULT_PROFILE));
});

test('漂移守卫：生产档案必须等于 config.js 的默认值', () => {
  // 这条不变量是整套设计的地基：`npm start` 不带任何参数，走的就是 config.js 的默认值，
  // 而这里说「那等于生产档案」。两边一旦分叉，生产就会在无人察觉的情况下换端口或换数据目录。
  assert.ok(PROFILE_NAMES.includes('production'), '必须有 production 档案');
  const defaults = loadConfig({});

  assert.equal(PROFILES.production.port, defaults.port);
  assert.equal(PROFILES.production.serveClient, defaults.serveClient);
  assert.equal(PROFILES.production.nodeEnv, defaults.nodeEnv);
  assert.equal(path.join(PROJECT_ROOT, PROFILES.production.dataDir, 'services.json'), defaults.servicesFile);
  assert.equal(path.join(PROJECT_ROOT, PROFILES.production.dataDir, 'logs', PROFILES.production.consoleLogName), defaults.consoleLogFile);
});

test('把生产档案展开再 loadConfig，结果与直接取默认值逐项一致', () => {
  const defaults = loadConfig({});
  const viaProfile = profileConfig('production');

  assert.equal(viaProfile.port, defaults.port);
  assert.equal(viaProfile.serveClient, defaults.serveClient);
  assert.equal(viaProfile.nodeEnv, defaults.nodeEnv);
  assert.equal(viaProfile.servicesFile, defaults.servicesFile);
  assert.equal(viaProfile.consoleLogFile, defaults.consoleLogFile);
});

test('开发档：3011、不托管前端、NODE_ENV 为 development', () => {
  const dev = profileConfig('development');

  assert.equal(dev.port, 3011);
  assert.equal(dev.serveClient, false, '开发档只出 API，界面由 Vite dev server 提供');
  assert.equal(dev.nodeEnv, 'development');
  assert.notEqual(dev.port, loadConfig({}).port, '必须与生产档端口不同，否则两个环境无法同时存在');
});

test('两个档案共用同一份服务台账（刻意如此：开发时想看到真实的服务列表）', () => {
  const dev = profileConfig('development');
  const prod = profileConfig('production');

  assert.equal(PROFILES.development.dataDir, PROFILES.production.dataDir);
  assert.equal(dev.servicesFile, prod.servicesFile);
});

test('两个档案的 console 日志必须是两个文件', () => {
  // 共用 data/ 后两个进程会同时追加并轮转同一个文件，而 fileSink 的轮转基于各自进程内的
  // size 记账——一方 rename 会把文件从另一方脚下搬走，记账随即失真。台账共用是刻意的，
  // 日志没必要跟着一起冒险。
  const dev = profileConfig('development');
  const prod = profileConfig('production');

  assert.notEqual(dev.consoleLogFile, prod.consoleLogFile);
});

test('显式环境变量优先于档案（e2e 的 3199 / verify-bundle 的 3098 靠这条活着）', () => {
  // 档案若压过显式 env，client/e2e/console-server.mjs 与 scripts/verify-bundle.mjs 这两个
  // 隔离实例会被拖到 3011 去，跟正在跑的控制台抢端口。
  const dev = profileConfig('development', { LSC_PORT: '3199', LSC_DATA_DIR: './tmp-e2e' });
  assert.equal(dev.port, 3199);
  assert.equal(dev.servicesFile, path.resolve('./tmp-e2e', 'services.json'));

  // 没被显式覆盖的项仍取档案值
  assert.equal(dev.serveClient, false);
});

test('覆盖 LSC_DATA_DIR 时，console 日志跟着走（否则「隔离实例」照样在污染真实日志）', () => {
  const isolated = profileConfig('production', { LSC_DATA_DIR: './tmp-isolated' });
  const tmp = path.resolve('./tmp-isolated');

  assert.equal(isolated.servicesFile, path.join(tmp, 'services.json'));
  assert.equal(
    isolated.consoleLogFile,
    path.join(tmp, 'logs', 'console.log'),
    '日志路径必须由生效的 dataDir 推导，不能钉死在档案里那个相对路径上',
  );
});

test('开发档覆盖 LSC_DATA_DIR 后，日志名仍是 dev 专属的那个', () => {
  const dev = profileConfig('development', { LSC_DATA_DIR: './tmp-isolated' });
  assert.equal(dev.consoleLogFile, path.join(path.resolve('./tmp-isolated'), 'logs', 'console-dev.log'));
});

test('显式 LSC_SERVE_CLIENT 能反过来打开开发档的前端托管', () => {
  assert.equal(profileConfig('development', { LSC_SERVE_CLIENT: '1' }).serveClient, true);
  assert.equal(profileConfig('production', { LSC_SERVE_CLIENT: '0' }).serveClient, false);
});

test('overriddenKeys：报出被环境变量压过的键（静默覆盖是本设计唯一不透明的部分）', () => {
  assert.deepEqual(overriddenKeys('production', { root: PROJECT_ROOT, base: {} }), []);
  assert.deepEqual(overriddenKeys('development', { root: PROJECT_ROOT, base: { LSC_PORT: '3199' } }), ['LSC_PORT']);
  // 值与档案一致时不算「被覆盖」
  assert.deepEqual(overriddenKeys('development', { root: PROJECT_ROOT, base: { LSC_PORT: '3011' } }), []);
});

test('profileEnv：缺 root 时报错（路径推导必须由调用方传入，见 profiles.js 文件头）', () => {
  assert.throws(() => profileEnv('development', {}), /需要 root/);
});

test('profileEnv：未知档案名报错', () => {
  assert.throws(() => profileEnv('staging', { root: PROJECT_ROOT }), /未知的环境档案 staging/);
});

test('DEV_CLIENT_PORT 是 5173，且与任何档案端口都不冲突', () => {
  assert.equal(DEV_CLIENT_PORT, 5173);
  for (const name of PROFILE_NAMES) {
    assert.notEqual(DEV_CLIENT_PORT, PROFILES[name].port, `${name} 档不得占用前端端口`);
  }
});
