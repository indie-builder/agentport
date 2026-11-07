import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { hasErrorCode } from '@agentport/shared';

export async function pathSegmentsProblem(
  physicalRoot: string,
  segments: readonly string[],
): Promise<'link' | 'outside' | null> {
  let physical = physicalRoot;
  for (const segment of segments) {
    physical = join(physical, segment);
    const info = await lstat(physical).catch((error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    });
    if (info === null) break;
    if (info.isSymbolicLink()) return 'link';
    const actual = await realpath(physical);
    if (actual !== physicalRoot && !actual.startsWith(`${physicalRoot}${sep}`)) return 'outside';
  }
  return null;
}
