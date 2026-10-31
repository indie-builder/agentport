export type OwnershipResolution<T> =
  | { kind: 'reuse'; entity: T }
  | { kind: 'create' }
  | { kind: 'conflict'; message: string };

/**
 * manifest 归属判定：只有带正确 ID 且名称未变的记录可复用。
 * 已归属但丢失/改名、未归属却同名，都按冲突停止，不重建也不覆盖。
 */
export function resolveOwnership<T>(input: {
  dataset: string;
  label: string;
  hasRecord: boolean;
  owned: T | undefined;
  named: T | undefined;
  expectedName: string;
  nameOf: (entity: T) => string;
}): OwnershipResolution<T> {
  const { dataset, label, hasRecord, owned, named, expectedName, nameOf } = input;
  if (hasRecord) {
    if (!owned) {
      return {
        kind: 'conflict',
        message: `${label} 已归属 ${dataset}，但当前不存在（已删除或 ID 丢失）`,
      };
    }
    if (nameOf(owned) !== expectedName) {
      return {
        kind: 'conflict',
        message: `${label} 已归属 ${dataset}，但名称已被改为 ${nameOf(owned)}`,
      };
    }
    return { kind: 'reuse', entity: owned };
  }
  if (named) {
    return { kind: 'conflict', message: `${label} 已存在但不在 ${dataset} manifest 中` };
  }
  return { kind: 'create' };
}
