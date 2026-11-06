import { RedisClient } from 'bun';
import { createBunRedisClient } from 'bullmq';

export async function probeBunRedis(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  const client = new RedisClient(url, {
    connectionTimeout: 1_000,
    maxRetries: 1,
    autoReconnect: false,
  });
  try {
    await client.connect();
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    client.close();
  }
}

export function bunRedisConnection(url: string) {
  const connection = createBunRedisClient(new RedisClient(url));
  return { connection, close: () => connection.quit() };
}
