import { chmod, cp, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  conversationInputsDir,
  personalMemoryDir,
  sdkSessionDir,
  sdkSessionsRoot,
  sessionSandboxDir,
  sessionSandboxesRoot,
  WORKSPACE_DIR_MODE,
  WORKSPACE_FILE_MODE,
} from '@agentport/core';
import { idPrefixes } from '@agentport/db';

export function runWorkspaceDir(workspacesDir: string, slug: string, runId: string): string {
  return join(workspacesDir, slug, runId);
}

export function isRunWorkspaceName(name: string): boolean {
  return name.startsWith(`${idPrefixes.run}_`);
}

export function toHostWorkspacePath(
  input: { workspacesDir: string; hostWorkspacesDir: string },
  dir: string,
): string {
  return join(input.hostWorkspacesDir, relative(input.workspacesDir, dir));
}

export async function ensureSessionWorkspace(input: {
  workspacesDir: string;
  slug: string;
  conversationId: string;
  businessId?: string;
  subAgentSlugs?: string[];
}): Promise<{
  workspaceDir: string;
  outputsDir: string;
  inputsDir: string;
  memoryDir: string;
  sessionsDir: string;
  personalDir?: string;
  subAgentMemoryDirs: Array<{ slug: string; memoryDir: string }>;
}> {
  const agent = join(input.workspacesDir, input.slug);
  const session = sessionSandboxDir(input.workspacesDir, input.slug, input.conversationId);
  const personalDir =
    input.businessId === undefined
      ? undefined
      : personalMemoryDir(input.workspacesDir, input.businessId);
  const paths = {
    workspaceDir: join(session, 'workspace'),
    outputsDir: join(session, 'outputs'),
    inputsDir: conversationInputsDir({
      root: input.workspacesDir,
      slug: input.slug,
      conversationId: input.conversationId,
    }),
    memoryDir: join(agent, 'agent-memory'),
    sessionsDir: sdkSessionDir(input.workspacesDir, input.slug, input.conversationId),
    ...(personalDir === undefined ? {} : { personalDir }),
  };
  const subAgentMemoryDirs = [...(input.subAgentSlugs ?? [])]
    .sort()
    .map((slug) => ({ slug, memoryDir: join(input.workspacesDir, slug, 'agent-memory') }));
  const dirs = [
    agent,
    sessionSandboxesRoot(input.workspacesDir, input.slug),
    session,
    join(agent, 'conversation-inputs'),
    sdkSessionsRoot(input.workspacesDir, input.slug),
    paths.workspaceDir,
    paths.outputsDir,
    paths.inputsDir,
    paths.memoryDir,
    paths.sessionsDir,
    ...(personalDir === undefined ? [] : [join(input.workspacesDir, '_users'), personalDir]),
  ];
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

export async function writeRulesDirectory(
  rulesDir: string,
  rules: ReadonlyArray<{ slug: string; content: string }>,
): Promise<void> {
  await rm(rulesDir, { recursive: true, force: true });
  if (rules.length === 0) return;
  await mkdir(rulesDir, { mode: WORKSPACE_DIR_MODE, recursive: true });
  for (const rule of rules) {
    await writeFile(join(rulesDir, `${rule.slug}.md`), rule.content, {
      encoding: 'utf8',
      mode: WORKSPACE_FILE_MODE,
    });
  }
}

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
