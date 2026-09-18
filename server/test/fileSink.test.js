/**
 * 控制台日志落盘的测试（见 `02-doc/02-design/030-desktop-packaging.md` §5.2）。
 *
 * 这一层的头号要求不是「能写」，而是**写不进去时也不能把控制台带崩**：
 * 桌面版没有控制台窗口，日志器自己抛异常 = 用户看不到任何界面也看不到任何日志。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMultiSink, createRotatingFileSink } from '../src/lib/fileSink.js';
import { cleanupTempDirs, makeTempDir } from '../testkit/tmp.js';

after(cleanupTempDirs);

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

test('基本写入：自动建父目录，内容原样落盘', async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, 'logs', 'console.log');

  const sink = createRotatingFileSink({ filePath });
  sink.write('第一行\n');
  sink.write('第二行\n');

  assert.equal(sink.lastError, null);
  assert.equal(read(filePath), '第一行\n第二行\n');
  assert.ok(path.isAbsolute(sink.filePath));
});

test('追加语义：控制台重启后接着上次写，不冲掉旧日志', async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, 'console.log');

  createRotatingFileSink({ filePath }).write('上一次运行的日志\n');
  // 模拟控制台重启：新起一个 sink 指向同一个文件
  createRotatingFileSink({ filePath }).write('这一次运行的日志\n');

  assert.equal(read(filePath), '上一次运行的日志\n这一次运行的日志\n');
});

test('按大小轮转：保留 maxBackups 份，最老的一份被丢弃', async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, 'console.log');
  const line = 'x'.repeat(63) + '\n'; // 64 字节

  // maxBytes=64 → 每写一行就正好超限触发一次轮转
  const sink = createRotatingFileSink({ filePath, maxBytes: 64, maxBackups: 2 });
  for (let i = 1; i <= 4; i += 1) sink.write(`第${i}轮 ${line.slice(3)}`);

  assert.ok(exists(filePath), '当前文件必须存在');
  assert.ok(exists(`${filePath}.1`), '应保留一份备份');
  assert.ok(exists(`${filePath}.2`), '应保留两份备份');
  assert.equal(exists(`${filePath}.3`), false, 'maxBackups=2 时不应出现第 3 份备份');

  // 最老的（第 1 轮）应已被丢弃，第 2 轮落在 .2
  assert.match(read(`${filePath}.2`), /第2轮/);
  assert.equal(read(`${filePath}.2`).includes('第1轮'), false, '最老的一份应被丢弃');
  assert.match(read(filePath), /第4轮/, '最新一轮必须落在当前文件里');
});

test('maxBackups=0：只保留当前文件，超限直接从头写', async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, 'console.log');

  const sink = createRotatingFileSink({ filePath, maxBytes: 16, maxBackups: 0 });
  sink.write('a'.repeat(20));
  sink.write('b'.repeat(20));

  assert.equal(exists(`${filePath}.1`), false, 'maxBackups=0 不应产生备份文件');
  assert.equal(read(filePath), 'b'.repeat(20));
});

test('写失败不抛出：路径写不进去也只记 lastError（桌面版没有控制台窗口，崩了就什么都看不到）', async () => {
  const dir = await makeTempDir();
  // 把「日志文件」指到一个目录上 —— appendFileSync 必失败
  const asDir = path.join(dir, 'not-a-file');
  fs.mkdirSync(asDir);

  const errors = [];
  const sink = createRotatingFileSink({ filePath: asDir, onError: (err) => errors.push(err) });

  assert.doesNotThrow(() => sink.write('这条写不进去\n'));
  assert.ok(sink.lastError instanceof Error, 'lastError 应记录失败原因');
  assert.ok(errors.length >= 1, '应回调 onError 让调用方有机会提示用户');
});

test('createMultiSink：单个 sink 抛错不连累其他 sink，也不冒泡给调用方', () => {
  // 场景就是桌面版：GUI 进程没有控制台，process.stdout 写入可能抛错，
  // 不能因此让「记录一条日志」把控制台本身打挂
  const good = [];
  const multi = createMultiSink([
    {
      write: () => {
        throw new Error('stdout 不可写');
      },
    },
    { write: (c) => good.push(c) },
  ]);

  assert.doesNotThrow(() => multi.write('还得能记下来\n'));
  assert.deepEqual(good, ['还得能记下来\n'], '失败 sink 之后的其他 sink 仍须收到日志');
});

test('createMultiSink：一条日志同时写给所有 sink，且容忍空位', () => {
  const a = [];
  const b = [];
  const multi = createMultiSink([{ write: (c) => a.push(c) }, null, { write: (c) => b.push(c) }]);

  multi.write('同一行\n');
  assert.deepEqual(a, ['同一行\n']);
  assert.deepEqual(b, ['同一行\n']);
});

test('createRotatingFileSink：缺 filePath 直接报错（配置层不该让它静默跑起来）', () => {
  assert.throws(() => createRotatingFileSink({}), /filePath/);
});
