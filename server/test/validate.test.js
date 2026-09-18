import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertValidServiceInput, validateServiceInput } from '../src/lib/validate.js';

const valid = {
  name: '订单服务',
  workDir: 'C:\\services\\order',
  startScript: 'C:\\services\\order\\start.bat',
  logFile: 'C:\\services\\order\\logs\\app.log',
  port: 8081,
};

test('validateServiceInput：合法输入通过并做 trim', () => {
  const result = validateServiceInput({ ...valid, name: '  订单服务  ' });
  assert.equal(result.ok, true);
  assert.equal(result.value.name, '订单服务');
  assert.equal(result.value.port, 8081);
});

test('validateServiceInput：port 可省略或留空 → null（选填）', () => {
  for (const port of [undefined, null, '']) {
    const result = validateServiceInput({ ...valid, port });
    assert.equal(result.ok, true);
    assert.equal(result.value.port, null);
  }
});

test('validateServiceInput：port 支持字符串数字，越界或非整数被拒', () => {
  assert.equal(validateServiceInput({ ...valid, port: '9000' }).value.port, 9000);
  for (const port of [0, 70000, 8081.5, 'abc']) {
    const result = validateServiceInput({ ...valid, port });
    assert.equal(result.ok, false, `port=${port} 应被拒绝`);
    assert.equal(result.errors[0].field, 'port');
  }
});

test('validateServiceInput：必填字段缺失或全空白被拒，并逐项给出中文提示', () => {
  const result = validateServiceInput({ port: 80 });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((e) => e.field),
    ['name', 'workDir', 'startScript', 'logFile'],
  );
  assert.ok(result.errors.every((e) => e.message.length > 0));

  assert.equal(validateServiceInput({ ...valid, name: '   ' }).ok, false);
});

test('validateServiceInput：字段类型错误被拒', () => {
  assert.equal(validateServiceInput({ ...valid, name: 123 }).ok, false);
  assert.equal(validateServiceInput({ ...valid, workDir: { a: 1 } }).ok, false);
});

test('validateServiceInput：超长字段被拒', () => {
  const result = validateServiceInput({ ...valid, logFile: `C:\\${'x'.repeat(600)}.log` });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /长度/);
});

test('validateServiceInput：路径含 cmd 元字符被拒（经 cmd.exe 执行会失败）', () => {
  for (const bad of ['C:\\a&b\\start.bat', 'C:\\a|b.bat', 'C:\\a>b.bat', 'C:\\a"b.bat', 'C:\\a^b.bat']) {
    const result = validateServiceInput({ ...valid, startScript: bad });
    assert.equal(result.ok, false, `${bad} 应被拒绝`);
    assert.match(result.errors[0].message, /cmd 特殊字符/);
  }
});

test('validateServiceInput：非对象请求体被拒', () => {
  for (const input of [null, undefined, 'text', 42, [1, 2]]) {
    const result = validateServiceInput(input);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].field, '_');
  }
});

test('validateServiceInput：startupGraceMs 可省略 → null（沿用全局默认）', () => {
  for (const value of [undefined, null, '']) {
    const result = validateServiceInput({ ...valid, startupGraceMs: value });
    assert.equal(result.ok, true);
    assert.equal(result.value.startupGraceMs, null);
  }
});

test('validateServiceInput：startupGraceMs 支持字符串数字与非负整数（含 0 = 关闭宽限期）', () => {
  assert.equal(validateServiceInput({ ...valid, startupGraceMs: 60000 }).value.startupGraceMs, 60000);
  assert.equal(validateServiceInput({ ...valid, startupGraceMs: '60000' }).value.startupGraceMs, 60000);
  assert.equal(validateServiceInput({ ...valid, startupGraceMs: 0 }).value.startupGraceMs, 0);
});

test('validateServiceInput：startupGraceMs 负数 / 小数 / 非数字 / 超上限被拒（防止把秒当毫秒误填）', () => {
  for (const value of [-1, 1.5, 'abc', 30 * 60 * 1000 + 1]) {
    const result = validateServiceInput({ ...valid, startupGraceMs: value });
    assert.equal(result.ok, false, `startupGraceMs=${value} 应被拒绝`);
    assert.equal(result.errors[0].field, 'startupGraceMs');
    assert.match(result.errors[0].message, /启动宽限期/);
  }
});

test('assertValidServiceInput：校验失败抛 AppError（状态码 400 + 明细）', () => {
  assert.throws(
    () => assertValidServiceInput({ ...valid, name: '' }),
    (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      assert.equal(err.status, 400);
      assert.ok(Array.isArray(err.details.errors));
      return true;
    },
  );
});

test('assertValidServiceInput：通过时返回规范化后的值', () => {
  const value = assertValidServiceInput(valid);
  assert.equal(value.name, valid.name);
  assert.equal(value.port, 8081);
});
