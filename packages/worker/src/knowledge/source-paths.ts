/**
 * 各来源共用的文件名去重后缀。独立成叶模块，避免 `sources.ts` 与 `source-*` 之间形成
 * 只为这一函数的循环依赖。
 */
export function uniquePath(path: string, used: Set<string>, token: string): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = path.lastIndexOf('.');
  const disambiguated =
    dot > 0 ? `${path.slice(0, dot)} [${token}]${path.slice(dot)}` : `${path} [${token}]`;
  used.add(disambiguated);
  return disambiguated;
}
