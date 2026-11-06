import { RedisClient } from 'bun';
import { createDb } from '../../../packages/db/src/client.js';

const url = process.env.E2E_DATABASE_URL;
if (!url) throw new Error('E2E_DATABASE_URL must identify the isolated E2E database');

export const { db, client } = createDb(url);

let redisClient: RedisClient | undefined;

export function redis(): RedisClient {
  const url = process.env.E2E_REDIS_URL;
  if (!url) throw new Error('E2E_REDIS_URL must identify the isolated E2E Redis');
  redisClient ??= new RedisClient(url);
  return redisClient;
}

export async function close(): Promise<void> {
  try {
    await client.close();
  } finally {
    redisClient?.close();
  }
}
