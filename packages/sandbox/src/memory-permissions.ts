import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { HookCallback, PreToolUseHookSpecificOutput } from '@anthropic-ai/claude-agent-sdk';

const MEMORY_TOOLS = new Set(['Read', 'Write', 'Edit']);
const OTHER_FILE_TOOLS = new Set(['Glob', 'Grep', 'NotebookEdit']);

export function createMemoryHook(directory: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (!MEMORY_TOOLS.has(input.tool_name) && !OTHER_FILE_TOOLS.has(input.tool_name)) return {};

    const output: PreToolUseHookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Only the main agent may access ordinary Markdown files inside its memory directory.',
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
    const local = relative(directory, path);
    if (!local || local.startsWith(`..${sep}`) || local === '..' || isAbsolute(local)) return deny;

    try {
      // Recheck every call: neither a symlink nor a hard link may alias another agent's files.
      const root = await lstat(directory);
      if (!root.isDirectory() || root.isSymbolicLink() || (await realpath(directory)) !== directory)
        return deny;
      const parts = local.split(sep);
      let current = directory;
      for (const [index, part] of parts.entries()) {
        current = join(current, part);
        let entry: Stats;
        try {
          entry = await lstat(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || input.tool_name !== 'Write')
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
