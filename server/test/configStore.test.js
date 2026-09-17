import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createConfigStore, STORE_VERSION } from '../src/db/configStore.js';
import { createSilentLogger } from '../testkit/harness.js';
import { cleanupTempDirs, makeTempDir } from '../testkit/tmp.js';

after(cleanupTempDirs);

const input = (overrides = {}) => ({
  name: '订单服务',
  workDir: 'C:\\services\\order',
  startScript: 'C:\\services\\order\\start.bat',
  logFile: 'C:\\services\\order\\app.log',
  port: 8081,
  ...overrides,
});

async function makeStore({ payload } = {}) {
  const dir = await makeTempDir();
  const filePath = path.join(dir, 'data', 'services.json');
  const corruptBackupDir = path.join(dir, 'data', 'corrupt');
  if (payload !== undefined) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, payload, 'utf8');
  }
  const store = createConfigStore({ filePath, corruptBackupDir, logger: createSilentLogger() });
  const { warnings } = await store.init();
  return { dir, filePath, corruptBackupDir, store, warnings };
}

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8'));

test('init：配置文件不存在 → 空列表启动，不写文件也不报错', async () => {
  const { store, warnings, filePath } = await makeStore();
  assert.deepEqual(store.list(), []);
  assert.deepEqual(warnings, []);
  assert.equal(store.isLoaded(), true);
  await assert.rejects(fs.access(filePath), /ENOENT/);
});

test('create：写盘为 { version, services }，字段带 id 与时间戳', async () => {
  const { store, filePath } = await makeStore();
  const created = await store.create(input());

  assert.ok(created.id.length > 0);
  assert.equal(created.name, '订单服务');
  assert.equal(created.createdAt, created.updatedAt);

  const onDisk = await readJson(filePath);
  assert.equal(onDisk.version, STORE_VERSION);
  assert.equal(onDisk.services.length, 1);
  assert.equal(onDisk.services[0].id, created.id);
});

test('list / get：返回副本，外部修改不影响内部状态（不可变）', async () => {
  const { store } = await makeStore();
  const created = await store.create(input());

  const list = store.list();
  list[0].name = '被外部改了';
  assert.equal(store.get(created.id).name, '订单服务');

  const got = store.get(created.id);
  got.name = '又被改了';
  assert.equal(store.get(created.id).name, '订单服务');
  assert.equal(store.get('不存在'), null);
  assert.equal(store.has(created.id), true);
  assert.equal(store.count(), 1);
});

test('update：修改字段并刷新 updatedAt，落盘生效', async () => {
  const { store, filePath } = await makeStore();
  const created = await store.create(input());
  await new Promise((resolve) => setTimeout(resolve, 5));
  const updated = await store.update(created.id, input({ name: '订单服务 v2', port: null }));

  assert.equal(updated.name, '订单服务 v2');
  assert.equal(updated.port, null);
  assert.notEqual(updated.updatedAt, created.updatedAt);
  assert.equal(updated.createdAt, created.createdAt, 'createdAt 不应被改动');

  const onDisk = await readJson(filePath);
  assert.equal(onDisk.services[0].name, '订单服务 v2');
});

test('update：id 不存在返回 null；校验失败抛错且不落盘', async () => {
  const { store, filePath } = await makeStore();
  await store.create(input());
  assert.equal(await store.update('missing', input()), null);

  await assert.rejects(() => store.update(store.list()[0].id, input({ name: '' })), /名称不能为空/);
  const onDisk = await readJson(filePath);
  assert.equal(onDisk.services[0].name, '订单服务', '校验失败不应污染磁盘内容');
});

test('remove：删除生效并落盘；不存在返回 false', async () => {
  const { store, filePath } = await makeStore();
  const created = await store.create(input());
  assert.equal(await store.remove(created.id), true);
  assert.deepEqual(store.list(), []);
  assert.equal(await store.remove(created.id), false);
  assert.deepEqual((await readJson(filePath)).services, []);
});

test('并发写：多次同时修改全部落盘，且不相互覆盖（写操作串行化）', async () => {
  const { store, filePath } = await makeStore();
  await Promise.all([
    store.create(input({ name: 'svc-1' })),
    store.create(input({ name: 'svc-2' })),
    store.create(input({ name: 'svc-3' })),
  ]);
  assert.equal(store.count(), 3);
  const onDisk = await readJson(filePath);
  assert.deepEqual(
    onDisk.services.map((s) => s.name).sort(),
    ['svc-1', 'svc-2', 'svc-3'],
  );
});

test('原子写：写完不留临时文件', async () => {
  const { store, filePath } = await makeStore();
  await store.create(input());
  const entries = await fs.readdir(path.dirname(filePath));
  assert.deepEqual(entries, ['services.json']);
});

test('损坏配置：备份原文件 + 降级为空列表 + 返回告警', async () => {
  const { store, warnings, filePath, corruptBackupDir } = await makeStore({ payload: '{ 这不是 JSON' });
  assert.deepEqual(store.list(), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /配置文件损坏/);

  const backups = await fs.readdir(corruptBackupDir);
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^services\.json\.corrupt-/);
  assert.equal(await fs.readFile(path.join(corruptBackupDir, backups[0]), 'utf8'), '{ 这不是 JSON');
  await assert.rejects(fs.access(filePath), /ENOENT/, '损坏文件应被移走');

  // 降级后仍可正常新增
  await store.create(input());
  assert.equal(store.count(), 1);
});

test('services 字段不是数组 → 同样降级并备份', async () => {
  const { store, warnings, corruptBackupDir } = await makeStore({ payload: '{"version":1,"services":{}}' });
  assert.deepEqual(store.list(), []);
  assert.match(warnings[0], /配置文件损坏/);
  assert.equal((await fs.readdir(corruptBackupDir)).length, 1);
});

test('兼容裸数组格式的旧配置', async () => {
  const { store } = await makeStore({ payload: JSON.stringify([{ id: 'a', name: '旧服务' }]) });
  assert.equal(store.count(), 1);
  assert.equal(store.get('a').name, '旧服务');
});

test('加载归一化：缺字段补齐、id 缺失或重复自动补发、非法 port 置空', async () => {
  const payload = JSON.stringify({
    version: 1,
    services: [
      { id: 'dup', name: 'A' },
      { id: 'dup', name: 'B', port: 99999 },
      { name: 'C', workDir: '', startScript: '', logFile: '', port: '80' },
      null,
      'bad',
    ],
  });
  const { store, warnings } = await makeStore({ payload });

  const list = store.list();
  assert.equal(list.length, 3, 'null / 非法条目应被忽略');
  const ids = list.map((s) => s.id);
  assert.equal(new Set(ids).size, 3, 'id 必须唯一');
  assert.equal(list[0].id, 'dup');
  assert.equal(list[1].port, null, '越界端口置空');
  assert.equal(list[2].port, null, '字符串端口在加载时不做类型推断，置空更安全');
  assert.ok(list.every((s) => typeof s.createdAt === 'string' && s.createdAt.length > 0));
  assert.match(warnings.join(), /无效记录/);
});

test('warnings：初始加载告警可在初始化后读取', async () => {
  const { store, warnings } = await makeStore({ payload: 'not json at all' });
  assert.equal(store.warnings().length, warnings.length);
  assert.ok(store.warnings().length > 0);
});
