import type { Stats } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  errorText,
  INPUTS_CONTAINER_DIR,
  OUTPUTS_CONTAINER_DIR,
  PERSONAL_MEMORY_FILENAME,
  PERSONAL_MEMORY_MAX_BYTES,
  PERSONAL_MEMORY_MAX_CHARS,
  SUBAGENT_MEMORY_CONTAINER_DIR,
  USER_CONTAINER_DIR,
  WORKSPACE_CONTAINER_DIR,
} from '@agentport/shared';
import type { HookCallback, PreToolUseHookSpecificOutput } from '@anthropic-ai/claude-agent-sdk';

const MEMORY_TOOLS = new Set(['Read', 'Write', 'Edit']);
const OTHER_FILE_TOOLS = new Set(['Glob', 'Grep', 'NotebookEdit']);

/** 工作区技能与插件资源根；文件工具对它们只读。 */
const SKILLS_DIR = `${WORKSPACE_CONTAINER_DIR}/.claude/skills`;
const PLUGINS_DIR = `${WORKSPACE_CONTAINER_DIR}/.claude/plugins`;

/** 个人记忆由宿主只读挂载到 /mnt/user；每轮用户提交前注入，恢复会话也读最新文件。 */
export const PERSONAL_MEMORY_FILE = `${USER_CONTAINER_DIR}/${PERSONAL_MEMORY_FILENAME}`;

const PERSONAL_MEMORY_LIMIT_MESSAGE = `个人偏好最多 ${PERSONAL_MEMORY_MAX_CHARS} 个字符，本轮未启动`;

/**
 * UserPromptSubmit hook：读取个人记忆文件并作为 additionalContext 注入本轮。
 * 缺失或空白返回空；符号链接、非普通文件、超过 9000 字符或 36 KiB 时拒绝本轮并报告原因。
 * 个人记忆不是官方用户级 CLAUDE.md 自动发现：宿主只读挂载到 /mnt/user，由本 hook 每轮注入；
 * 只读固定挂载路径，不读取宿主 .claude，也不加载开发者设置。
 */
export function createPersonalMemoryHook(
  file = PERSONAL_MEMORY_FILE,
  onError: (message: string) => void = () => {},
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'UserPromptSubmit') return {};
    const fail = (message: string) => {
      onError(message);
      return { decision: 'block' as const, reason: message };
    };
    let info: Stats;
    try {
      info = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      return fail(`个人记忆读取失败：${errorText(error)}`);
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      return fail(`个人记忆必须是普通文件：${file}`);
    }
    if (info.size > PERSONAL_MEMORY_MAX_BYTES) {
      return fail(PERSONAL_MEMORY_LIMIT_MESSAGE);
    }
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch (error) {
      return fail(`个人记忆读取失败：${errorText(error)}`);
    }
    if ([...content].length > PERSONAL_MEMORY_MAX_CHARS) {
      return fail(PERSONAL_MEMORY_LIMIT_MESSAGE);
    }
    if (content.trim().length === 0) return {};
    return {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: content },
    };
  };
}

function inside(local: string): boolean {
  return local.length > 0 && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

/**
 * 文件工具边界：
 * - 主会话可写记忆目录内的普通 .md，也可在本轮产出目录内读写交付文件；
 *   只读可及本轮附件（任意普通文件）、技能参考文件（`.claude/skills/<slug>/references/`）
 *   与插件技能资源（`.claude/plugins/<slug>/skills/<name>/`）。
 * - 子智能体只可读写自己的 project 记忆目录（`.claude/agent-memory/<slug>/` 内的 .md），
 *   可写性跟随父专家的运行期策略；未登记的调用方、兄弟目录、父级记忆/产出/附件一律拒绝。
 * 其余文件工具请求一律拒绝。
 */
export function createFileBoundaryHook({
  memoryDir,
  skillsDir = SKILLS_DIR,
  pluginsDir = PLUGINS_DIR,
  outputsDir = OUTPUTS_CONTAINER_DIR,
  inputsDir = INPUTS_CONTAINER_DIR,
  projectMemoryDir = SUBAGENT_MEMORY_CONTAINER_DIR,
  subAgentSlugs: knownSubAgents = new Set<string>(),
  memoryWritable = true,
}: {
  memoryDir: string;
  skillsDir?: string;
  pluginsDir?: string;
  outputsDir?: string;
  inputsDir?: string;
  /** 子智能体 project 记忆根；缺省为容器内官方目录。 */
  projectMemoryDir?: string;
  /** 本次加载的已知子智能体 slug；未登记的子智能体不放行任何文件。 */
  subAgentSlugs?: ReadonlySet<string>;
  /** 主会话与已登记子智能体是否可写记忆目录；proposal_only 或未启用记忆时为 false，只保留读。 */
  memoryWritable?: boolean;
}): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (!MEMORY_TOOLS.has(input.tool_name) && !OTHER_FILE_TOOLS.has(input.tool_name)) return {};

    const output: PreToolUseHookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'File tools are limited to native memory, this run’s outputs, and skill reference Markdown.',
    };
    const deny = (reason?: string): { hookSpecificOutput: PreToolUseHookSpecificOutput } => {
      if (reason !== undefined) output.permissionDecisionReason = reason;
      return { hookSpecificOutput: output };
    };
    const allow = (): { hookSpecificOutput: PreToolUseHookSpecificOutput } => {
      output.permissionDecision = 'allow';
      const { permissionDecisionReason: _reason, ...rest } = output;
      return { hookSpecificOutput: rest };
    };
    if (!MEMORY_TOOLS.has(input.tool_name)) return deny();
    const args = input.tool_input;
    if (typeof args !== 'object' || args === null || !('file_path' in args)) return deny();
    const path = args.file_path;
    if (
      typeof path !== 'string' ||
      !isAbsolute(path) ||
      path.includes('\0') ||
      path.split(sep).some((part) => part === '..' || part === '.')
    )
      return deny();

    const hasMarkdown = path.endsWith('.md');
    let base: string;
    let writable: boolean;
    if (input.agent_id !== undefined) {
      const slug = input.agent_type ?? '';
      if (!knownSubAgents.has(slug) || !hasMarkdown) return deny();
      base = join(projectMemoryDir, slug);
      if (!inside(relative(base, path))) return deny();
      if (!memoryWritable && input.tool_name !== 'Read') {
        return deny('当前策略不允许运行期写入子智能体记忆，请把建议写进最终回复。');
      }
      writable = memoryWritable;
    } else {
      const inputsLocal = relative(inputsDir, path);
      const memoryLocal = relative(memoryDir, path);
      const outputLocal = relative(outputsDir, path);
      if (inside(inputsLocal)) {
        if (input.tool_name !== 'Read') return deny();
        base = inputsDir;
        writable = false;
      } else if (inside(memoryLocal)) {
        if (!hasMarkdown) return deny();
        if (!memoryWritable && input.tool_name !== 'Read') return deny();
        base = memoryDir;
        writable = memoryWritable;
      } else if (inside(outputLocal)) {
        base = outputsDir;
        writable = true;
      } else {
        // 插件技能资源：Read 打开技能正文或它的 references 时，CLI 给的是真实路径。
        const [pluginSlug, skillsSegment, skillName] = relative(pluginsDir, path).split(sep);
        const insidePluginSkill =
          input.tool_name === 'Read' &&
          hasMarkdown &&
          /^[a-z0-9][a-z0-9_-]*$/.test(pluginSlug ?? '') &&
          skillsSegment === 'skills' &&
          /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(skillName ?? '');
        const [slug, kind, ...rest] = relative(skillsDir, path).split(sep);
        const insideSkillRefs =
          input.tool_name === 'Read' &&
          hasMarkdown &&
          kind === 'references' &&
          rest.length > 0 &&
          /^[a-z0-9][a-z0-9_-]*$/.test(slug ?? '');
        if (!insidePluginSkill && !insideSkillRefs) return deny();
        base = insidePluginSkill ? pluginsDir : skillsDir;
        writable = false;
      }
    }
    const local = relative(base, path);
    if (!inside(local)) return deny();

    try {
      const root = await lstat(base);
      if (!root.isDirectory() || root.isSymbolicLink() || (await realpath(base)) !== base)
        return deny();
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
            return deny();
          return allow();
        }
        if (entry.isSymbolicLink() || (await realpath(current)) !== current) return deny();
        const last = index === parts.length - 1;
        if (last ? !entry.isFile() || entry.nlink !== 1 : !entry.isDirectory()) return deny();
      }
      return allow();
    } catch {
      return deny();
    }
  };
}
