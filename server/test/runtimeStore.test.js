/**
 * 运行时档案（runtime-<port>.json）测试：记录生命周期、损坏降级、按端口分文件的隔离。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRuntimeStore } from '../src/db/runtimeStore.js';
import { createSilentLogger } from '../testkit/harness.js';
import { cleanupTempDirs, makeTempDir } from '../testkit/tmp.js';

after(cleanupTempDirs);

async function makeStore(over = {}) {
  const dir = await makeTempDir();
  const filePath = path.join(dir, 'data', over.fileName ?? 'runtime-3010.json');
  const store = createRuntimeStore({
    filePath,
    corruptBackupDir: path.join(dir, 'data', 'corrupt'),
    logger: createSilentLogger(),
    ...over.options,
  });
  await store.init();
  return { dir, filePath, store };
}

test('set/get/remove：写入落盘、回读一致、删除后消失', async () => {
  const { filePath, store } = await makeStore();
  assert.equal(store.get('s1'), null, '空档案读不到');

  await store.set('s1', { pid: 26448, creationDate: '20260918104326.105632+480', name: 'cmd.exe', startedAt: '2026-09-18T10:43:26.000Z' });
  assert.equal(store.get('s1').pid, 26448);
  assert.equal(store.get('s1').creationDate, '20260918104326.105632+480');
  assert.ok(store.get('s1').savedAt, '写入时自动补 savedAt');

  // 真的落了盘（不是只写内存）：新实例重新 init 能读回
  const reloaded = createRuntimeStore({ filePath, logger: createSilentLogger() });
  await reloaded.init();
  assert.equal(reloaded.get('s1').pid, 26448);

  assert.equal(await reloaded.remove('s1'), true);
  assert.equal(await reloaded.remove('s1'), false, '重复删除幂等');
  const afterRemove = createRuntimeStore({ filePath, logger: createSilentLogger() });
  await afterRemove.init();
  assert.equal(afterRemove.get('s1'), null);
});

test('不合法记录被拒：没有 pid 或没有创建时间的一律不收', async () => {
  const { store } = await makeStore();
  await assert.rejects(() => store.set('s1', { pid: '4000', creationDate: 'x' }), /不合法/);
  await assert.rejects(() => store.set('s1', { pid: 4000 }), /不合法/);
  assert.equal(store.get('s1'), null);
});

test('损坏的档案：备份后降级为空，不挡启动', async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, 'data', 'runtime-3010.json');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '{ 这不是 JSON', 'utf8');

  const store = createRuntimeStore({ filePath, corruptBackupDir: path.join(dir, 'corrupt'), logger: createSilentLogger() });
  await store.init();
  assert.equal(store.get('s1'), null, '损坏 → 空档案');
  const backups = await fs.readdir(path.join(dir, 'corrupt'));
  assert.match(backups[0], /runtime-3010\.json\.corrupt-/);
});

test('字段不完整的条目在加载时丢弃，完整条目保留', async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, 'runtime-3010.json');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      services: {
        good: { pid: 100, creationDate: '20260918104326.105632+480', name: 'cmd.exe' },
        noPid: { creationDate: '20260918104326.105632+480' },
        noCreation: { pid: 200 },
      },
    }),
    'utf8',
  );
  const store = createRuntimeStore({ filePath, logger: createSilentLogger() });
  await store.init();
  assert.deepEqual(
    store.list().map(([id]) => id),
    ['good'],
    '缺 pid / 缺创建时间的条目没法做身份校验，留着你就是隐患',
  );
});

test('v1 旧档案（只有 pid、没有 tree）读进来时退化成「只记了壳」的树', async () => {
  // 向后兼容的意义：升级控制台不该让「重启前还在跑的服务」突然接不上。
  // 老记录只能退化成单成员树——接管逻辑照跑，只是壳一旦死了就接不上（这是老数据的固有局限）。
  const dir = await makeTempDir();
  const filePath = path.join(dir, 'runtime-3010.json');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      services: { calibre: { pid: 26448, creationDate: '20260918104326.105632+480', name: 'cmd.exe' } },
    }),
    'utf8',
  );
  const store = createRuntimeStore({ filePath, logger: createSilentLogger() });
  await store.init();
  const entry = store.get('calibre');
  assert.equal(entry.pid, 26448);
  assert.deepEqual(entry.tree, [{ pid: 26448, ppid: 0, name: 'cmd.exe', creationDate: '20260918104326.105632+480', depth: 0 }]);
});

test('整棵子树落盘后原样读回（顺序、深度、创建时间都不丢）', async () => {
  const { filePath, store } = await makeStore();
  const tree = [
    { pid: 26448, ppid: 22260, name: 'cmd.exe', creationDate: '20260918104326.105632+480', depth: 0 },
    { pid: 16116, ppid: 26448, name: 'python.exe', creationDate: '20260918104327.001122+480', depth: 1 },
    { pid: 25452, ppid: 16116, name: 'python.exe', creationDate: '20260918104328.554433+480', depth: 2 },
  ];
  await store.set('calibre', { pid: 26448, creationDate: tree[0].creationDate, name: 'cmd.exe', tree });

  const reloaded = createRuntimeStore({ filePath, logger: createSilentLogger() });
  await reloaded.init();
  assert.deepEqual(reloaded.get('calibre').tree, tree, 'pid 被复用与否全靠逐成员的创建时间，不能在这一层丢');
});

test('子树里的坏成员逐条丢弃（成员级容错），全坏则退化成单成员树', async () => {
  const { store } = await makeStore();
  await store.set('s1', {
    pid: 10,
    creationDate: '20260918104326.105632+480',
    tree: [
      { pid: 10, creationDate: '20260918104326.105632+480', depth: 0 },
      null, // 坏：不是对象
      { pid: '20', creationDate: 'x' }, // 坏：pid 不是正整数
      { pid: 30 }, // 坏：没有创建时间，没法验身份
      { pid: 40, creationDate: '20260918104327.001122+480', depth: 1 },
    ],
  });
  assert.deepEqual(
    store.get('s1').tree.map((member) => member.pid),
    [10, 40],
    '一条坏成员不该连累整条记录',
  );
});

test('子树成员数封顶 64：损坏/恶意档案不能把内存撑爆', async () => {
  const { store } = await makeStore();
  const tree = Array.from({ length: 200 }, (_, index) => ({
    pid: 100 + index,
    creationDate: `20260918104326.${String(index).padStart(6, '0')}+480`,
    depth: 1,
  }));
  await store.set('s1', { pid: 100, creationDate: tree[0].creationDate, tree });
  assert.equal(store.get('s1').tree.length, 64);
});

test('按端口分文件：dev（3011）与 production（3010）互不可见', async () => {
  const dir = await makeTempDir();
  const prod = createRuntimeStore({ filePath: path.join(dir, 'runtime-3010.json'), logger: createSilentLogger() });
  const dev = createRuntimeStore({ filePath: path.join(dir, 'runtime-3011.json'), logger: createSilentLogger() });
  await prod.init();
  await dev.init();

  await prod.set('calibre', { pid: 26448, creationDate: '20260918104326.105632+480' });
  assert.equal(dev.get('calibre'), null, '开发档看不到生产档的记录——否则它会认领并误杀生产的服务');
  assert.equal(prod.list().length, 1);
});
