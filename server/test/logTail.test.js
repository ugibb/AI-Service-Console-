import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import iconv from 'iconv-lite';
import { tailFile, TAIL_KINDS, TRUNCATED_MARKER } from '../src/logs/logTail.js';
import { cleanupTempDirs, makeTempDir, writeFileIn } from '../testkit/tmp.js';

after(cleanupTempDirs);

async function makeLog(content, name = 'service.log') {
  const dir = await makeTempDir();
  const file = await writeFileIn(dir, name, content);
  return { dir, file };
}

const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`).join('\n');

test('tailFile：返回最后 N 行，行序与文件一致', async () => {
  const { file } = await makeLog(`${lines(10)}\n`);
  const result = await tailFile(file, { lines: 3 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.lines, ['line-8', 'line-9', 'line-10']);
  assert.equal(result.lineCount, 3);
  assert.equal(result.hasMore, true, '文件里还有更早的行');
});

test('tailFile：请求行数多于文件行数时返回全部，hasMore=false', async () => {
  const { file } = await makeLog(`a\nb\nc\n`);
  const result = await tailFile(file, { lines: 500 });
  assert.deepEqual(result.lines, ['a', 'b', 'c']);
  assert.equal(result.hasMore, false);
});

test('tailFile：文件末尾没有换行时最后一行不丢', async () => {
  const { file } = await makeLog('a\nb\nc');
  const result = await tailFile(file, { lines: 2 });
  assert.deepEqual(result.lines, ['b', 'c']);
});

test('tailFile：CRLF 行尾不会带 \\r', async () => {
  const { file } = await makeLog('first\r\nsecond\r\n');
  const result = await tailFile(file, { lines: 5 });
  assert.deepEqual(result.lines, ['first', 'second']);
});

test('tailFile：GBK 中文日志无乱码（Windows 高频坑）', async () => {
  const text = '服务启动成功\n连接数据库失败：超时\n';
  const { file } = await makeLog(iconv.encode(text, 'gbk'));
  const result = await tailFile(file, { lines: 10 });
  assert.equal(result.encoding, 'gbk');
  assert.deepEqual(result.lines, ['服务启动成功', '连接数据库失败：超时']);
});

test('tailFile：UTF-8 中文日志按 utf8 解码', async () => {
  const { file } = await makeLog('服务启动成功\n');
  const result = await tailFile(file, { lines: 10 });
  assert.equal(result.encoding, 'utf8');
  assert.deepEqual(result.lines, ['服务启动成功']);
});

test('tailFile：极小分块下多字节字符不被切坏（分块边界落在字符中间）', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：服务运行正常`);
  const { file } = await makeLog(`${rows.join('\n')}\n`);
  const result = await tailFile(file, { lines: 5, chunkSize: 16 });
  assert.equal(result.lines.length, 5);
  assert.deepEqual(result.lines, rows.slice(-5));
  assert.ok(!result.lines.some((line) => line.includes('�')), '不应出现替换字符');
});

test('tailFile：超长单行被截断并标记', async () => {
  const huge = 'x'.repeat(5000);
  const { file } = await makeLog(`short\n${huge}\nlast\n`);
  const result = await tailFile(file, { lines: 10, maxLineBytes: 1024 });
  assert.equal(result.truncatedLines, 1);
  assert.ok(result.lines[1].endsWith(TRUNCATED_MARKER));
  assert.equal(result.lines[1].length, 1024 + TRUNCATED_MARKER.length + 1);
  assert.deepEqual([result.lines[0], result.lines[2]], ['short', 'last']);
});

test('tailFile：空文件返回空行列表而非报错', async () => {
  const { file } = await makeLog('');
  const result = await tailFile(file, { lines: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.emptyFile, true);
  assert.deepEqual(result.lines, []);
  assert.equal(result.fileSize, 0);
});

test('tailFile：文件被轮转/截断后仍读到最新内容（全量 tail 的天然免疫）', async () => {
  const dir = await makeTempDir();
  const file = await writeFileIn(dir, 'app.log', 'old-1\nold-2\nold-3\n');
  const before = await tailFile(file, { lines: 10 });
  assert.deepEqual(before.lines, ['old-1', 'old-2', 'old-3']);

  // 模拟轮转：改名 + 新文件
  await fs.rename(file, path.join(dir, 'app.log.1'));
  await fs.writeFile(file, 'new-1\nnew-2\n');
  const afterRotate = await tailFile(file, { lines: 10 });
  assert.deepEqual(afterRotate.lines, ['new-1', 'new-2']);

  // 模拟截断：同路径写入更短内容
  await fs.writeFile(file, 'truncated\n');
  const afterTruncate = await tailFile(file, { lines: 10 });
  assert.deepEqual(afterTruncate.lines, ['truncated']);
});

test('tailFile：文件不存在 → 结构化降级，不抛异常', async () => {
  const dir = await makeTempDir();
  const result = await tailFile(path.join(dir, 'missing.log'), { lines: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, TAIL_KINDS.MISSING);
  assert.equal(result.code, 'LOG_PATH_MISSING');
  assert.equal(result.message, '日志文件尚未生成');
});

test('tailFile：路径是目录 → 明确提示', async () => {
  const dir = await makeTempDir();
  const result = await tailFile(dir, { lines: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, TAIL_KINDS.DIRECTORY);
  assert.match(result.message, /目录/);
});

test('tailFile：无读取权限 → 明确提示', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('以 root 运行，chmod 无法真正限制读取');
    return;
  }
  const { file } = await makeLog('secret\n');
  await fs.chmod(file, 0o000);
  try {
    const result = await tailFile(file, { lines: 10 });
    assert.equal(result.ok, false);
    assert.equal(result.kind, TAIL_KINDS.PERMISSION);
    assert.match(result.message, /权限/);
  } finally {
    await fs.chmod(file, 0o644);
  }
});

test('tailFile：单行很长且文件无换行时也只在阈值内返回', async () => {
  const { file } = await makeLog('y'.repeat(3000));
  const result = await tailFile(file, { lines: 10, maxLineBytes: 512 });
  assert.equal(result.truncatedLines, 1);
  assert.ok(result.lines[0].startsWith('y'.repeat(512)));
});

test('tailFile：返回文件大小与修改时间供前端展示', async () => {
  const { file } = await makeLog('a\nb\n');
  const result = await tailFile(file, { lines: 10 });
  assert.equal(result.fileSize, 4);
  assert.ok(result.mtime > 0);
  assert.equal(result.path, file);
});
