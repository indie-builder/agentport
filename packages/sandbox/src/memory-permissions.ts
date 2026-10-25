import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { HookCallback, PreToolUseHookSpecificOutput } from '@anthropic-ai/claude-agent-sdk';

const MEMORY_TOOLS = new Set(['Read', 'Write', 'Edit']);
const OTHER_FILE_TOOLS = new Set(['Glob', 'Grep', 'NotebookEdit']);

export const createMemoryHook = createFileBoundaryHook;

/**
 * 文件工具边界：主会话可写记忆目录内的普通 .md；只读可及记忆目录、
 * 技能参考文件（`.claude/skills/<slug>/references/`）以及插件技能资源
 * （`.claude/plugins/<slug>/skills/<name>/`）。其余文件工具请求一律拒绝。
 */
export function createFileBoundaryHook(
  memoryDir: string,
  skillsDir = '/workspace/.claude/skills',
  pluginsDir = '/workspace/.claude/plugins',
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (!MEMORY_TOOLS.has(input.tool_name) && !OTHER_FILE_TOOLS.has(input.tool_name)) return {};

    const output: PreToolUseHookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'File tools are limited to native memory and skill reference Markdown for the main agent.',
    };
    const deny = { hookSpecificOutput: output };
    const allow = (): { hookSpecificOutput: PreToolUseHookSpecificOutput } => {
      output.permissionDecision = 'allow';
      // 允许分支不带拒绝文案，避免日志与排障误判。
      const { permissionDecisionReason: _reason, ...rest } = output;
      return { hookSpecificOutput: rest };
    };
    if (!MEMORY_TOOLS.has(input.tool_name) || input.agent_id !== undefined) return deny;
    const args = input.tool_input;
    if (typeof args !== 'object' || args === null || !('file_path' in args)) return deny;
    const path = args.file_path;
    if (
      typeof path !== 'string' ||
      !isAbsolute(path) ||
      path.includes('\0') ||
      !path.endsWith('.md') ||
      path.split(sep).some((part) => part === '..' || part === '.')
    )
      return deny;

    // 记忆目录：主会话可读写。技能参考文件：只读、且必须落在 .claude/skills/<slug>/references/ 下。
    let base = memoryDir;
    let writable = true;
    const memoryLocal = relative(memoryDir, path);
    if (
      !memoryLocal ||
      memoryLocal.startsWith(`..${sep}`) ||
      memoryLocal === '..' ||
      isAbsolute(memoryLocal)
    ) {
      const skillLocal = relative(skillsDir, path);
      const [slug, kind, ...rest] = skillLocal.split(sep);
      const insideSkillRefs =
        input.tool_name === 'Read' &&
        Boolean(slug) &&
        kind === 'references' &&
        rest.length > 0 &&
        /^[a-z0-9][a-z0-9_-]*$/.test(slug ?? '') &&
        path.endsWith('.md');
      // 插件技能资源：Read 打开技能正文或它的 references 时，CLI 给的是真实路径。
      const pluginLocal = relative(pluginsDir, path);
      const [pluginSlug, skillsSegment, skillName] = pluginLocal.split(sep);
      const insidePluginSkill =
        input.tool_name === 'Read' &&
        Boolean(pluginSlug) &&
        skillsSegment === 'skills' &&
        Boolean(skillName) &&
        /^[a-z0-9][a-z0-9_-]*$/.test(pluginSlug ?? '') &&
        /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(skillName ?? '') &&
        path.endsWith('.md');
      if (!insideSkillRefs && !insidePluginSkill) return deny;
      base = insideSkillRefs ? skillsDir : pluginsDir;
      writable = false;
    }
    const local = relative(base, path);
    if (!local || local.startsWith(`..${sep}`) || local === '..' || isAbsolute(local)) return deny;

    try {
      // Recheck every call: neither a symlink nor a hard link may alias another agent's files.
      const root = await lstat(base);
      if (!root.isDirectory() || root.isSymbolicLink() || (await realpath(base)) !== base)
        return deny;
      const parts = local.split(sep);
      let current = base;
      for (const [index, part] of parts.entries()) {
        current = join(current, part);
        let entry: Stats;
        try {
          entry = await lstat(current);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
            input.tool_name !== 'Write' ||
            !writable
          )
            return deny;
          // Write creates missing parents; all existing ancestors have already passed the boundary.
          return allow();
        }
        if (entry.isSymbolicLink() || (await realpath(current)) !== current) return deny;
        const last = index === parts.length - 1;
        if (last ? !entry.isFile() || entry.nlink !== 1 : !entry.isDirectory()) return deny;
      }
      return allow();
    } catch {
      return deny;
    }
  };
}
