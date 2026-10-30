import { chmod, cp, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_DIR_MODE } from '@agentport/core';

/** 只预建目录，不改内容；刷新必须由调用方持有会话 lease。 */
export async function ensureSessionWorkspace(input: {
  workspacesDir: string;
  slug: string;
  conversationId: string;
  /** 本次加载的子智能体；它们各自的项目记忆宿主与沙盒挂载点都要预先建好。 */
  subAgentSlugs?: string[];
}): Promise<{
  workspaceDir: string;
  outputsDir: string;
  inputsDir: string;
  memoryDir: string;
  sessionsDir: string;
  /** 个人记忆宿主目录，只读挂载到沙盒 /mnt/user。 */
  personalDir: string;
  /** 子智能体项目记忆宿主目录，按 slug 排序后 rw 挂载到沙盒项目记忆根。 */
  subAgentMemoryDirs: Array<{ slug: string; memoryDir: string }>;
}> {
  const agent = join(input.workspacesDir, input.slug);
  const session = join(agent, 'session-sandboxes', input.conversationId);
  const paths = {
    workspaceDir: join(session, 'workspace'),
    outputsDir: join(session, 'outputs'),
    inputsDir: join(agent, 'conversation-inputs', input.conversationId),
    memoryDir: join(agent, 'agent-memory'),
    sessionsDir: join(agent, 'sdk-sessions', input.conversationId),
    personalDir: join(input.workspacesDir, '_user'),
  };
  const subAgentMemoryDirs = [...(input.subAgentSlugs ?? [])]
    .sort()
    .map((slug) => ({ slug, memoryDir: join(input.workspacesDir, slug, 'agent-memory') }));
  // 父目录同样拒绝链接；挂载路径不能借父目录跳出该智能体。
  const dirs = [
    agent,
    join(agent, 'session-sandboxes'),
    session,
    join(agent, 'conversation-inputs'),
    join(agent, 'sdk-sessions'),
    ...Object.values(paths),
  ];
  // 宿主记忆目录与工作区里的挂载点都要先建好；刷新时保留这棵子树，避免换掉挂载根 inode。
  for (const { slug, memoryDir } of subAgentMemoryDirs) {
    dirs.push(
      join(input.workspacesDir, slug),
      memoryDir,
      join(paths.workspaceDir, '.claude'),
      join(paths.workspaceDir, '.claude', 'agent-memory'),
      join(paths.workspaceDir, '.claude', 'agent-memory', slug),
    );
  }
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true, mode: WORKSPACE_DIR_MODE });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Session path must be a real directory: ${dir}`);
    await chmod(dir, WORKSPACE_DIR_MODE);
  }
  return { ...paths, subAgentMemoryDirs };
}

/**
 * 先检查完整来源，保持已挂载根的 inode；容器只能在独占 lease 中观察这次更新。
 * `preserveMemoryMount` 只给工作区定义使用：`.claude/agent-memory` 是子智能体记忆的 rw
 * 挂载根，保留它和 `.claude` 的 inode，其他定义照常整棵替换；来源里同名的记忆目录也不得
 * 覆盖挂载子树。产出没有挂载根，默认按普通目录整棵替换（含同名的 `.claude/agent-memory`）。
 */
export async function refreshSessionDirectory(
  source: string,
  target: string,
  options: { preserveMemoryMount?: boolean } = {},
): Promise<void> {
  const check = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) {
      throw new Error(`Session copy requires regular files without links: ${path}`);
    }
    if (info.isDirectory()) for (const name of await readdir(path)) await check(join(path, name));
  };
  await check(source);
  const destination = await lstat(target);
  if (!destination.isDirectory() || destination.isSymbolicLink())
    throw new Error(`Session target must be a real directory: ${target}`);

  // 整棵替换：清掉目标旧内容后逐项复制；skip 用于保留挂载根所在的那一层。
  const replace = async (from: string, to: string, skip?: string): Promise<void> => {
    for (const name of await readdir(to)) {
      if (name === skip) continue;
      await rm(join(to, name), { recursive: true, force: true });
    }
    for (const name of await readdir(from)) {
      if (name === skip) continue;
      await cp(join(from, name), join(to, name), { recursive: true });
    }
  };

  if (options.preserveMemoryMount !== true) {
    await replace(source, target);
    return;
  }

  const sourceClaude = join(source, '.claude');
  const sourceClaudeInfo = await lstat(sourceClaude).catch(() => null);
  if (sourceClaudeInfo !== null && !sourceClaudeInfo.isDirectory())
    throw new Error(`Session source .claude must be a directory: ${sourceClaude}`);
  const targetClaude = join(target, '.claude');
  const targetClaudeInfo = await lstat(targetClaude).catch(() => null);
  if (
    targetClaudeInfo !== null &&
    (!targetClaudeInfo.isDirectory() || targetClaudeInfo.isSymbolicLink())
  )
    throw new Error(`Session target .claude must be a real directory: ${targetClaude}`);

  await replace(source, target, '.claude');

  // 两边都没有 .claude 时不要凭空创建。
  if (sourceClaudeInfo === null && targetClaudeInfo === null) return;

  const preservedMemory = join(targetClaude, 'agent-memory');
  const memoryInfo = await lstat(preservedMemory).catch(() => null);
  if (memoryInfo !== null && (!memoryInfo.isDirectory() || memoryInfo.isSymbolicLink()))
    throw new Error(`Session memory mount must be a real directory: ${preservedMemory}`);
  await mkdir(targetClaude, { recursive: true, mode: WORKSPACE_DIR_MODE });
  if (sourceClaudeInfo === null) {
    for (const name of await readdir(targetClaude)) {
      if (name === 'agent-memory') continue;
      await rm(join(targetClaude, name), { recursive: true, force: true });
    }
    return;
  }
  await replace(sourceClaude, targetClaude, 'agent-memory');
}
