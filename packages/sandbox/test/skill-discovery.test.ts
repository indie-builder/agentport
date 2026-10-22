import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

// 真实 CLI 的启动开销小，15s 足够覆盖冷启动；不因单次慢而放宽全部测试。
const TIMEOUT = 15_000;

const require = createRequire(import.meta.url);

// SDK 自己按 process.platform/arch 找可选依赖里的原生 CLI（linux 先 glibc 后 musl，win32 带 .exe）。
// 这里只探测同一个包是否存在：缺包时测试应显式跳过，而不是把安装问题报成技能发现失败。
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

const SKILL = 'bound-skill';

/**
 * 只做初始化，不产生模型请求：prompt 是永远不 yield 的异步生成器，
 * initializationResult() 触发的是 CLI 的 control initialize，拿到的是真实技能列表。
 */
async function discover(
  withSkill = true,
): Promise<{ version: string | undefined; commands: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'skill-discovery-'));
  try {
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, '.mcp.json'), '{}');
    // settingSources 只开 project，所以技能必须位于 cwd/.claude/skills。
    if (withSkill) {
      await mkdir(join(cwd, '.claude', 'skills', SKILL), { recursive: true });
      await writeFile(
        join(cwd, '.claude', 'skills', SKILL, 'SKILL.md'),
        `---\nname: ${SKILL}\ndescription: Characterization fixture for skill discovery.\n---\n\nNo-op.\n`,
      );
    }

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
        skills: [SKILL],
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
      const commands = (await session.supportedCommands()).map((command) => command.name);
      return { version: init.claude_code_version, commands };
    } finally {
      // CLI 退出前仍可能写状态文件，必须等 close 后再清理目录。
      session.close();
      release();
      await closed;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('real CLI skill discovery', () => {
  it(
    'lists a project skill enabled through the SDK options',
    async (ctx) => {
      if (!nativeCli) ctx.skip(`no native CLI installed for ${process.platform}-${process.arch}`);
      const { version, commands } = await discover();

      expect(version).toMatch(/^\d+\.\d+\.\d+/);
      expect(commands).toContain(SKILL);
    },
    TIMEOUT,
  );

  it(
    'does not invent a skill that is absent from disk',
    async (ctx) => {
      if (!nativeCli) ctx.skip(`no native CLI installed for ${process.platform}-${process.arch}`);
      const { commands } = await discover(false);

      expect(commands).not.toContain(SKILL);
    },
    TIMEOUT,
  );
});
