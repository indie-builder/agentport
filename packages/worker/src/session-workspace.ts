import { chmod, cp, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_DIR_MODE } from '@agentport/core';

/** 只预建目录，不改内容；刷新必须由调用方持有会话 lease。 */
export async function ensureSessionWorkspace(input: {
  workspacesDir: string;
  slug: string;
  conversationId: string;
}): Promise<{
  workspaceDir: string;
  outputsDir: string;
  inputsDir: string;
  memoryDir: string;
  sessionsDir: string;
}> {
  const agent = join(input.workspacesDir, input.slug);
  const session = join(agent, 'session-sandboxes', input.conversationId);
  const paths = {
    workspaceDir: join(session, 'workspace'),
    outputsDir: join(session, 'outputs'),
    inputsDir: join(agent, 'conversation-inputs', input.conversationId),
    memoryDir: join(agent, 'agent-memory'),
    sessionsDir: join(agent, 'sdk-sessions', input.conversationId),
  };
  // 父目录同样拒绝链接；挂载路径不能借父目录跳出该智能体。
  for (const dir of [
    agent,
    join(agent, 'session-sandboxes'),
    session,
    join(agent, 'conversation-inputs'),
    join(agent, 'sdk-sessions'),
    ...Object.values(paths),
  ]) {
    await mkdir(dir, { recursive: true, mode: WORKSPACE_DIR_MODE });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Session path must be a real directory: ${dir}`);
    await chmod(dir, WORKSPACE_DIR_MODE);
  }
  return paths;
}

/** 先检查完整来源，保持已挂载根的 inode；容器只能在独占 lease 中观察这次更新。 */
export async function refreshSessionDirectory(source: string, target: string): Promise<void> {
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
  for (const name of await readdir(target))
    await rm(join(target, name), { recursive: true, force: true });
  for (const name of await readdir(source))
    await cp(join(source, name), join(target, name), { recursive: true });
}
