import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 只验证 docker CLI 参数；容器真跑由 sandbox 镜像测试覆盖。
const state = vi.hoisted(() => ({ args: [] as string[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (_command: string, args: string[]) => {
      state.args = args;
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  };
});

afterEach(() => {
  state.args = [];
});

async function create(
  extraMounts?: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>,
  entrypoint?: string,
) {
  const { DockerSandboxProvider } = await import('../src/sandbox/docker.js');
  const provider = new DockerSandboxProvider({
    memory: '1g',
    cpus: 1,
    pids: 128,
    egress: 'open',
  });
  await provider.create({
    image: 'sandbox:test',
    workspaceDir: '/tmp/workspace',
    env: {},
    ...(extraMounts === undefined ? {} : { extraMounts }),
    ...(entrypoint === undefined ? {} : { entrypoint, command: ['dist/probe.js'] }),
  });
  return state.args;
}

describe('docker sandbox provider', () => {
  it('mounts the session directory over the config tmpfs instead of duplicating it', async () => {
    const args = await create([{ hostPath: '/tmp/sessions', containerPath: '/home/node/.claude' }]);
    // Docker 不允许同一路径既 tmpfs 又 bind mount；两者同时出现会直接失败。
    expect(args.join(' ')).not.toContain('--tmpfs /home/node/.claude');
    expect(args.join(' ')).toContain('-v /tmp/sessions:/home/node/.claude:rw');
    expect(args.join(' ')).toContain('--tmpfs /tmp:');
  });

  it('keeps the config tmpfs for runs without a session mount', async () => {
    const args = await create();
    expect(args.join(' ')).toContain('--tmpfs /home/node/.claude:');
  });

  it('overrides the entrypoint only when asked', async () => {
    const probe = await create(undefined, 'node');
    expect(probe.join(' ')).toContain('--entrypoint node sandbox:test dist/probe.js');
    const run = await create();
    expect(run.join(' ')).not.toContain('--entrypoint');
  });
});
