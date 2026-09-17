import { test } from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { createDiagBuffer } from '../src/proc/diagBuffer.js';

test('createDiagBuffer：跨块拼接未成行的半截内容', () => {
  const buffer = createDiagBuffer({ maxLines: 10 });
  buffer.push(Buffer.from('正在启动服务', 'utf8'));
  buffer.push(Buffer.from('，等待端口绑定\n第二步\n', 'utf8'));
  assert.deepEqual(buffer.lines(), ['正在启动服务，等待端口绑定', '第二步']);
});

test('createDiagBuffer：环形上限，只保留最近 N 行', () => {
  const buffer = createDiagBuffer({ maxLines: 3 });
  for (let i = 1; i <= 6; i += 1) buffer.push(Buffer.from(`line-${i}\n`, 'utf8'));
  assert.deepEqual(buffer.lines(), ['line-4', 'line-5', 'line-6']);
  assert.equal(buffer.wasTruncated(), true);
});

test('createDiagBuffer：GBK 输出（中文 Windows 的 cmd / 服务常见）可读', () => {
  const buffer = createDiagBuffer({ maxLines: 10 });
  buffer.push(iconv.encode('错误：系统找不到指定的路径。\r\n', 'gbk'));
  assert.deepEqual(buffer.lines(), ['错误：系统找不到指定的路径。']);
});

test('createDiagBuffer：flush 收下退出时未成行的残留内容', () => {
  const buffer = createDiagBuffer({ maxLines: 10 });
  buffer.push(Buffer.from('没有换行的最后一行', 'utf8'));
  assert.deepEqual(buffer.lines(), []);
  buffer.flush();
  assert.deepEqual(buffer.lines(), ['没有换行的最后一行']);
  assert.equal(buffer.isEmpty(), false);
});

test('createDiagBuffer：超长单行被裁剪，且空输入不产生噪音', () => {
  const buffer = createDiagBuffer({ maxLines: 10 });
  buffer.push(Buffer.from(`${'x'.repeat(5000)}\n`, 'utf8'));
  buffer.push(Buffer.alloc(0));
  const [line] = buffer.lines();
  assert.equal(line.length, 4002);
  assert.ok(line.endsWith(' …'));
  assert.ok(buffer.bytes() >= 5000);
});

test('createDiagBuffer：CRLF 与混合编码下的行为', () => {
  const buffer = createDiagBuffer({ maxLines: 10 });
  buffer.push(Buffer.from('ascii-line\r\n'));
  buffer.push(iconv.encode('中文行\r\n', 'gbk'));
  assert.deepEqual(buffer.lines(), ['ascii-line', '中文行']);
  assert.equal(buffer.isEmpty(), false);
});
