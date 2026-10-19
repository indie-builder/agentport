import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from '../dist/client.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const { db, pool } = createDb(url);
await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
await pool.end();
console.log('migrations applied');
