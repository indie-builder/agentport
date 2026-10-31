import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOwnership } from './dataset-ownership.ts';

const base = {
  dataset: 'demo-dataset',
  label: '连接器 demo',
  hasRecord: false,
  owned: undefined as { name: string } | undefined,
  named: undefined as { name: string } | undefined,
  expectedName: 'demo',
  nameOf: (entity: { name: string }) => entity.name,
};

test('只在没有记录也没有同名资产时创建', () => {
  assert.deepEqual(resolveOwnership(base), { kind: 'create' });
});

test('已归属但当前不存在时报冲突，不重建', () => {
  const decision = resolveOwnership({ ...base, hasRecord: true });
  assert.equal(decision.kind, 'conflict');
});

test('已归属但名称改变时报冲突，不覆盖', () => {
  const decision = resolveOwnership({
    ...base,
    hasRecord: true,
    owned: { name: 'renamed' },
    named: { name: 'demo' },
  });
  assert.equal(decision.kind, 'conflict');
});

test('未归属的同名资产不被自动接管', () => {
  const decision = resolveOwnership({ ...base, named: { name: 'demo' } });
  assert.equal(decision.kind, 'conflict');
});

test('ID 与名称都一致时复用', () => {
  const owned = { name: 'demo' };
  assert.deepEqual(resolveOwnership({ ...base, hasRecord: true, owned, named: owned }), {
    kind: 'reuse',
    entity: owned,
  });
});
