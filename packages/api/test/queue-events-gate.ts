import { connect, createServer, type Socket } from 'node:net';
import { Redis } from 'ioredis';

/**
 * 回归“完成通知早于首个 XREAD”的测试支撑：
 * - startXreadGate 在真实 Redis 前加一层 TCP 门闩，只扣住首个 XREAD；
 * - watchIsFinished 用 MONITOR 确认产品已执行 isFinished 回查（job 此刻仍未完成）。
 * 两者都是事件驱动，不轮询；只用于测试，不参与产品运行。
 */

interface ParsedCommand {
  args: string[];
  end: number;
}

/** 解析 ioredis 发出的 RESP 数组命令；数据不完整返回 null。 */
function parseCommand(buffer: Buffer): ParsedCommand | null {
  if (buffer.length === 0 || buffer[0] !== 0x2a) return null;
  const headerEnd = buffer.indexOf('\r\n');
  if (headerEnd < 0) return null;
  const count = Number(buffer.subarray(1, headerEnd).toString());
  let offset = headerEnd + 2;
  const args: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer[offset] !== 0x24) return null;
    const lengthEnd = buffer.indexOf('\r\n', offset + 1);
    if (lengthEnd < 0) return null;
    const length = Number(buffer.subarray(offset + 1, lengthEnd).toString());
    const dataStart = lengthEnd + 2;
    const dataEnd = dataStart + length;
    if (buffer.length < dataEnd + 2) return null;
    args.push(buffer.subarray(dataStart, dataEnd).toString());
    offset = dataEnd + 2;
  }
  return { args, end: offset };
}

export interface XreadGate {
  readonly url: string;
  /** 首个 XREAD 已被扣住。 */
  readonly held: Promise<void>;
  release(): void;
  close(): Promise<void>;
}

export async function startXreadGate(redisUrl: string): Promise<XreadGate> {
  const target = new URL(redisUrl);
  const sockets = new Set<Socket>();
  const held = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let releasedFlag = false;

  const server = createServer((client) => {
    const upstream = connect({
      host: target.hostname,
      port: Number(target.port) || 6379,
    });
    sockets.add(client);
    sockets.add(upstream);

    let pending = Buffer.alloc(0);
    // 只扣住这条连接：Queue 的连接还要继续跑 isFinished 等回查命令。
    let holding = false;
    let heldChunks: Buffer[] = [];

    const flushHeld = (): void => {
      if (!holding) return;
      holding = false;
      for (const chunk of heldChunks) upstream.write(chunk);
      heldChunks = [];
    };
    void released.promise.then(() => {
      releasedFlag = true;
      flushHeld();
    });

    client.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (holding) {
          // XREAD 之后同一连接的字节必须保持顺序，一并等到放行。
          heldChunks.push(pending);
          pending = Buffer.alloc(0);
          return;
        }
        const command = parseCommand(pending);
        if (!command) {
          // 非 RESP 数组不该出现在 ioredis 连接上；原样转发避免卡死。
          if (pending.length > 0 && pending[0] !== 0x2a) {
            upstream.write(pending);
            pending = Buffer.alloc(0);
          }
          return;
        }
        const raw = Buffer.from(pending.subarray(0, command.end));
        pending = pending.subarray(command.end);
        if (command.args[0]?.toLowerCase() === 'xread' && !releasedFlag) {
          holding = true;
          heldChunks.push(raw);
          held.resolve();
        } else {
          upstream.write(raw);
        }
      }
    });

    upstream.on('data', (chunk) => client.write(chunk));
    const closeBoth = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', closeBoth);
    upstream.on('error', closeBoth);
    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing xread gate port');

  return {
    url: `redis://127.0.0.1:${address.port}${target.pathname}`,
    held: held.promise,
    release: () => released.resolve(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface CommandWatch {
  /** isFinished 已在真实 Redis 执行（返回时 job 仍未完成）。 */
  readonly isFinished: Promise<void>;
  close(): Promise<void>;
}

export async function watchIsFinished(redisUrl: string, queueName: string): Promise<CommandWatch> {
  const base = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const monitor = await base.monitor();
  const seen = Promise.withResolvers<void>();
  const suffix = `:${queueName}:`;
  monitor.on('monitor', (_time: string, args: string[]) => {
    // isFinished 的 KEYS = [completed, failed, jobId]，ARGV = [jobId, '1']；
    // EVALSHA 首次未命中会改发 EVAL，两者键的位置一致。
    const jobId = args[6];
    if (
      args[2] === '3' &&
      args[3]?.endsWith(`${suffix}completed`) &&
      args[4]?.endsWith(`${suffix}failed`) &&
      args[5]?.endsWith(`:${jobId}`)
    ) {
      seen.resolve();
    }
  });
  return {
    isFinished: seen.promise,
    close: async () => {
      monitor.disconnect();
      base.disconnect();
    },
  };
}
