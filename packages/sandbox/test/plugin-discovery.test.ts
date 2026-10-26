import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

// 真实 CLI 的启动开销小，15s 足以覆盖冷启动。
const TIMEOUT = 15_000;

const require = createRequire(import.meta.url);

// SDK 自己按 process.platform/arch 找可选依赖里的原生 CLI；缺包时跳过，
// 不把安装问题报成插件加载失败。
function hasNativeCli(): boolean {
  try {
    const fromSdk = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'));
    const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const names = process.platform === 'linux' ? [base, `${base}-musl`] : [base];
    const exe = process.platform === 'win32' ? '.exe' : '';
    return names.some((name) => {
      try {
        fromSdk.resolve(`${name}/claude${exe}`);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

const nativeCli = hasNativeCli();

const RUNTIME_NAME = 'probe-plugin';
const SKILL_DIR = 'probe-skill';
const SKILL_NAME = 'probe-skill-name';

/**
 * 只做初始化，不产生模型请求：prompt 永不 yield，initializationResult() 走 CLI 的
 * control initialize，读到的是真实加载结果。
 */
async function load(withPlugin = true): Promise<{
  version: string | undefined;
  commands: { name: string; aliases?: string[] }[];
  agents: string[];
  pluginsApplied: boolean | undefined;
}> {
  const root = await mkdtemp(join(tmpdir(), 'plugin-discovery-'));
  try {
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    const plugin = join(root, 'plugins', 'probe-slug');
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
    await mkdir(join(plugin, 'skills', SKILL_DIR), { recursive: true });
    await mkdir(join(plugin, 'agents'), { recursive: true });
    await writeFile(join(cwd, '.mcp.json'), '{}');
    await writeFile(
      join(plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: RUNTIME_NAME, version: '1.0.0', description: 'probe' }),
    );
    await writeFile(
      join(plugin, 'skills', SKILL_DIR, 'SKILL.md'),
      `---\nname: ${SKILL_NAME}\ndescription: Characterization fixture for plugin skill discovery.\n---\n\nNo-op.\n`,
    );
    await writeFile(
      join(plugin, 'agents', 'helper.md'),
      '---\nname: helper\ndescription: Characterization fixture for plugin agent discovery.\n---\n\nNo-op.\n',
    );

    let release = () => {};
    const idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    // biome-ignore lint/correctness/useYield: 永不产出即永不发用户消息，正是这里要的。
    const pending = (async function* () {
      await idle;
    })();
    let closed: Promise<void> | undefined;
    const session = query({
      prompt: pending,
      options: {
        spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
          const child = spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'] });
          closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
          return child;
        },
        cwd,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          TMPDIR: tmpdir(),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_ERROR_REPORTING: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        },
        settingSources: ['project'],
        // runner 传的是 `<runtimeName>:<技能目录名>`；真实 CLI 会把它解析到该插件技能，
        // 规范名取 frontmatter name，目录名保留为别名。
        skills: [`${RUNTIME_NAME}:${SKILL_DIR}`],
        ...(withPlugin ? { plugins: [{ type: 'local' as const, path: plugin }] } : {}),
        pluginDelivery: 'initialize',
        tools: [],
        strictMcpConfig: true,
        mcpServers: {},
        permissionMode: 'default',
        settings: {
          autoMemoryEnabled: false,
          disableClaudeAiConnectors: true,
          disableBundledSkills: true,
          disableAllHooks: true,
        },
      },
    });

    try {
      const init = await session.initializationResult();
      const commands = await session.supportedCommands();
      const agents = await session.supportedAgents();
      return {
        version: init.claude_code_version,
        commands: commands.map((command) => ({
          name: command.name,
          aliases: command.aliases,
        })),
        agents: agents.map((agent) => agent.name),
        pluginsApplied: init.plugins_applied,
      };
    } finally {
      session.close();
      release();
      await closed;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('real CLI plugin loading', () => {
  it(
    'namespaces plugin skills and agents after the manifest name',
    async (ctx) => {
      if (!nativeCli) ctx.skip(`no native CLI installed for ${process.platform}-${process.arch}`);
      const { version, commands, agents, pluginsApplied } = await load();
      const skill = commands.find((command) => command.name.startsWith(`${RUNTIME_NAME}:`));

      expect(version).toMatch(/^\d+\.\d+\.\d+/);
      expect(skill?.name).toBe(`${RUNTIME_NAME}:${SKILL_NAME}`);
      // 目录名以 `<plugin>:<dir>` 形式保留为别名，也是 `skills` 过滤按后缀匹配的名字。
      expect(skill?.aliases).toContain(`${RUNTIME_NAME}:${SKILL_DIR}`);
      expect(agents).toContain(`${RUNTIME_NAME}:helper`);
      expect(pluginsApplied).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'does not invent plugin components when no plugin is loaded',
    async (ctx) => {
      if (!nativeCli) ctx.skip(`no native CLI installed for ${process.platform}-${process.arch}`);
      const { commands, agents, pluginsApplied } = await load(false);

      expect(commands.some((command) => command.name.startsWith(`${RUNTIME_NAME}:`))).toBe(false);
      expect(agents.some((agent) => agent.startsWith(`${RUNTIME_NAME}:`))).toBe(false);
      expect(pluginsApplied).toBeUndefined();
    },
    TIMEOUT,
  );
});
