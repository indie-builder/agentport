import { createDb } from '../src/client.js';

const UNREACHABLE_URL = 'postgres://unreachable@127.0.0.1:1/unavailable';

export async function probeTestDb(url = process.env.DATABASE_URL) {
  const effectiveUrl = url || UNREACHABLE_URL;
  const { db, client } = createDb(effectiveUrl);
  if (!url) return { db, client, ready: false, url: effectiveUrl };
  const ready = await client.unsafe('select 1').then(
    () => true,
    () => false,
  );
  if (!ready) await client.close();
  return { db, client, ready, url: effectiveUrl };
}
