/**
 * 进程树纯函数测试（proc/tree.js）。
 *
 * 这一层是「真接管」的地基：档案里记哪些进程、重启后认谁、卡片上显示哪个 pid、
 * 停止时杀哪些 pid，全部由这几个纯函数决定。它们不碰进程也不碰文件，所以这里
 * 可以穷举边界（成环、损坏数据、pid 复用、超过上限）——真机上没法这么干。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSubtree, proveMembers, representativePid, sameTree } from '../src/proc/tree.js';

/** 一份手工进程表 → collectSubtree 需要的那种 Map 快照 */
function snapshotOf(...procs) {
  return new Map(procs.map((proc) => [proc.pid, proc]));
}

const proc = (pid, ppid, name = 'p.exe', creationDate = `2026010100000${pid}.000000+480`) => ({ pid, ppid, name, creationDate });

test('collectSubtree：只有根本身 → 单个成员，depth=0', () => {
  const snapshot = snapshotOf(proc(10, 1));
  const tree = collectSubtree(snapshot, 10);
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0], { pid: 10, ppid: 1, name: 'p.exe', creationDate: proc(10, 1).creationDate, depth: 0 });
});

test('collectSubtree：孙子也要收进来（.bat → cmd → python 这条链是真机实际形状）', () => {
  const snapshot = snapshotOf(proc(10, 1, 'cmd.exe'), proc(20, 10, 'python.exe'), proc(30, 20, 'python.exe'));
  const tree = collectSubtree(snapshot, 10);
  assert.deepEqual(
    tree.map((m) => [m.pid, m.depth]),
    [
      [10, 0],
      [20, 1],
      [30, 2],
    ],
  );
});

test('collectSubtree：只收自己的后代——别人的孩子、自己的祖先都不在内', () => {
  const snapshot = snapshotOf(proc(1, 0), proc(10, 1), proc(15, 1, 'sibling.exe'), proc(40, 99, 'other.exe'));
  const tree = collectSubtree(snapshot, 10);
  assert.deepEqual(
    tree.map((m) => m.pid),
    [10],
  );
});

test('collectSubtree：顺序稳定（同层按 pid 升序），与快照的遍历顺序无关', () => {
  const procs = [proc(10, 1), proc(32, 10), proc(31, 10), proc(33, 31)];
  const forward = collectSubtree(snapshotOf(...procs), 10).map((m) => m.pid);
  const backward = collectSubtree(snapshotOf(...[...procs].reverse()), 10).map((m) => m.pid);
  assert.deepEqual(forward, [10, 31, 32, 33]);
  assert.deepEqual(backward, forward, '同一棵树两次收集必须给出同一个形状，否则档案会反复重写');
});

test('collectSubtree：环状数据（异常快照）不会转圈，成员不重复', () => {
  // 10 → 20 → 10：真实进程表不可能这样，但快照是外部数据，防御点很便宜
  const snapshot = snapshotOf(proc(10, 20), proc(20, 10));
  const tree = collectSubtree(snapshot, 10);
  assert.deepEqual(
    tree.map((m) => m.pid),
    [10, 20],
  );
});

test('collectSubtree：根不在快照里 → 空树（进程已退出）', () => {
  assert.deepEqual(collectSubtree(snapshotOf(proc(20, 10)), 10), []);
  assert.deepEqual(collectSubtree(snapshotOf(), 10), []);
});

test('collectSubtree：非法 rootPid（null/0/负数/非整数）→ 空树', () => {
  const snapshot = snapshotOf(proc(10, 1));
  for (const bad of [null, undefined, 0, -1, 1.5, '10']) {
    assert.deepEqual(collectSubtree(snapshot, bad), [], `rootPid=${String(bad)} 应返回空树`);
  }
});

test('collectSubtree：成员数有上限（根恰好是系统进程时不至于把整机收进来）', () => {
  const procs = [proc(10, 1)];
  for (let i = 0; i < 200; i += 1) procs.push(proc(100 + i, 10));
  const tree = collectSubtree(snapshotOf(...procs), 10);
  assert.equal(tree.length, 64);
});

test('proveMembers：存活且创建时间精确相等才算数', () => {
  const tree = collectSubtree(snapshotOf(proc(10, 1), proc(20, 10)), 10);
  const proven = proveMembers(tree, snapshotOf(proc(10, 1), proc(20, 10)));
  assert.deepEqual(
    proven.map((m) => m.pid),
    [10, 20],
  );
});

test('proveMembers：pid 被复用（存活但创建时间不同）→ 不认领', () => {
  const tree = collectSubtree(snapshotOf(proc(10, 1)), 10);
  const reused = snapshotOf({ pid: 10, ppid: 1, name: 'unrelated.exe', creationDate: '20300101000000.000000+480' });
  assert.deepEqual(proveMembers(tree, reused), []);
});

test('proveMembers：壳死了、后代还活着 → 后代仍然验得上（真机 3/3 的那一幕）', () => {
  const tree = collectSubtree(snapshotOf(proc(10, 1, 'cmd.exe'), proc(20, 10, 'python.exe')), 10);
  // 壳从快照里消失，只剩 python
  const proven = proveMembers(tree, snapshotOf(proc(20, 10, 'python.exe')));
  assert.deepEqual(
    proven.map((m) => m.pid),
    [20],
  );
  assert.equal(proven[0].depth, 1);
});

test('proveMembers：空树/损坏输入不炸', () => {
  assert.deepEqual(proveMembers([], snapshotOf(proc(10, 1))), []);
  assert.deepEqual(proveMembers(null, snapshotOf(proc(10, 1))), []);
  assert.deepEqual(proveMembers([null, { pid: 'x' }, {}], snapshotOf(proc(10, 1))), []);
});

test('representativePid：取最深的那一个（壳先死时，活着的恰好是后代）', () => {
  const tree = collectSubtree(snapshotOf(proc(10, 1), proc(20, 10), proc(30, 20)), 10);
  const proven = proveMembers(tree, snapshotOf(proc(10, 1), proc(20, 10), proc(30, 20)));
  assert.equal(representativePid(proven), 30);
});

test('representativePid：空的证明集合 → null（调用方据此判「不接管」）', () => {
  assert.equal(representativePid([]), null);
  assert.equal(representativePid(null), null);
});

test('sameTree：形状相同才为真（pid 或创建时间任一不同即视为「树变了」）', () => {
  const a = collectSubtree(snapshotOf(proc(10, 1), proc(20, 10)), 10);
  const same = collectSubtree(snapshotOf(proc(10, 1), proc(20, 10)), 10);
  const longer = collectSubtree(snapshotOf(proc(10, 1), proc(20, 10), proc(30, 20)), 10);
  const reused = collectSubtree(snapshotOf(proc(10, 1), { ...proc(20, 10), creationDate: '20300101000000.000000+480' }), 10);
  assert.equal(sameTree(a, same), true);
  assert.equal(sameTree(a, longer), false);
  assert.equal(sameTree(a, reused), false);
  assert.equal(sameTree(null, a), false);
});
