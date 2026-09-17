import { test } from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import {
  countByte,
  countReplacements,
  decodeAuto,
  decodeBuffer,
  detectEncoding,
  isValidUtf8,
  splitLines,
  stripBom,
  stripCr,
  trimIncompleteGbkTail,
  trimIncompleteUtf8Tail,
} from '../src/logs/decode.js';

const utf8 = (text) => Buffer.from(text, 'utf8');
const gbk = (text) => iconv.encode(text, 'gbk');

test('isValidUtf8：合法 UTF-8 与 GBK 字节序列的区分', () => {
  assert.equal(isValidUtf8(utf8('中文日志 ok')), true);
  assert.equal(isValidUtf8(utf8('')), true);
  assert.equal(isValidUtf8(gbk('中文日志')), false, 'GBK 字节不是合法 UTF-8');
});

test('detectEncoding：UTF-8 中文 / GBK 中文 / 纯 ASCII', () => {
  assert.equal(detectEncoding(utf8('服务启动成功')), 'utf8');
  assert.equal(detectEncoding(gbk('服务启动成功')), 'gbk');
  assert.equal(detectEncoding(utf8('plain ascii')), 'utf8');
  assert.equal(detectEncoding(Buffer.alloc(0)), 'utf8');
});

test('detectEncoding：UTF-8 被从多字节字符中间截断时仍判为 utf8（替换字符极少）', () => {
  const full = utf8('服务启动成功');
  const cut = full.subarray(0, full.length - 1);
  assert.equal(isValidUtf8(cut), false);
  assert.equal(countReplacements(cut.toString('utf8')), 1);
  assert.equal(detectEncoding(cut), 'utf8');
});

test('decodeBuffer：按编码解码，GBK 中文无乱码', () => {
  assert.equal(decodeBuffer(gbk('服务启动成功'), { encoding: 'gbk' }).text, '服务启动成功');
  assert.equal(decodeBuffer(utf8('服务启动成功'), { encoding: 'utf8' }).text, '服务启动成功');
});

test('decodeBuffer + trimTail：截断的多字节字符不产生替换字符', () => {
  const cut = utf8('服务启动成功').subarray(0, utf8('服务启动成功').length - 1);
  const raw = decodeBuffer(cut, { encoding: 'utf8' }).text;
  assert.equal(countReplacements(raw), 1, '不裁剪时应出现替换字符');

  const trimmed = decodeBuffer(cut, { encoding: 'utf8', trimTail: true }).text;
  assert.equal(countReplacements(trimmed), 0);
  assert.equal(trimmed, '服务启动成');
});

test('decodeAuto：单块自动判编码', () => {
  assert.equal(decodeAuto(gbk('错误：端口被占用')).text, '错误：端口被占用');
  assert.equal(decodeAuto(utf8('错误：端口被占用')).text, '错误：端口被占用');
});

test('trimIncompleteUtf8Tail：合法 UTF-8 原样返回；GBK 不被误裁剪', () => {
  const valid = utf8('正常');
  assert.equal(trimIncompleteUtf8Tail(valid), valid);
  const gbkBytes = gbk('中文日志');
  assert.deepEqual(trimIncompleteUtf8Tail(gbkBytes), gbkBytes, '不能把 GBK 误当成截断的 UTF-8 裁掉');
});

test('trimIncompleteGbkTail：裁掉尾部孤立的首字节', () => {
  const whole = gbk('中文');
  assert.deepEqual(trimIncompleteGbkTail(whole), whole);
  const cut = whole.subarray(0, whole.length - 1); // 只剩半个字
  assert.equal(trimIncompleteGbkTail(cut).length, whole.length - 2);
});

test('splitLines：按 0x0A 切分并保留未成行的尾段', () => {
  const { lines, tail } = splitLines(utf8('a\nb\nc'));
  assert.deepEqual(
    lines.map((b) => b.toString('utf8')),
    ['a', 'b'],
  );
  assert.equal(tail.toString('utf8'), 'c');

  const trailing = splitLines(utf8('a\nb\n'));
  assert.equal(trailing.lines.length, 2);
  assert.equal(trailing.tail.length, 0);
});

test('splitLines 对 GBK 与 UTF-8 都成立（换行字节相同）', () => {
  const { lines } = splitLines(gbk('第一行\n第二行\n'));
  assert.deepEqual(
    lines.map((b) => iconv.decode(b, 'gbk')),
    ['第一行', '第二行'],
  );
});

test('stripCr / stripBom / countByte / countReplacements', () => {
  assert.equal(stripCr(utf8('abc\r')).toString('utf8'), 'abc');
  assert.equal(stripCr(utf8('abc')).toString('utf8'), 'abc');
  assert.equal(stripBom('﻿日志'), '日志');
  assert.equal(stripBom('日志'), '日志');
  assert.equal(countByte(utf8('a\nb\n'), 0x0a), 2);
  assert.equal(countReplacements('a�b�'), 2);
});
