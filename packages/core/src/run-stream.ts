import { STREAM_TTL_SECONDS } from '@agentport/shared';

interface StreamWriter {
  send(command: string, args: string[]): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export async function appendStreamEvent(
  redis: StreamWriter,
  key: string,
  event: unknown,
): Promise<void> {
  await Promise.all([
    redis.send('XADD', [key, '*', 'payload', JSON.stringify(event)]),
    redis.expire(key, STREAM_TTL_SECONDS),
  ]);
}
