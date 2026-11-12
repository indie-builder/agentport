export function compareBySort<T extends { name: string; createdAt: string }>(
  a: T,
  b: T,
  sort: 'newest' | 'name',
): number {
  return sort === 'name'
    ? a.name.localeCompare(b.name, 'zh-CN')
    : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}
