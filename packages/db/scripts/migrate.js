import { migrate } from 'drizzle-orm/bun-sql/migrator';
import { createDb } from '../dist/client.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const { db, client } = createDb(url);
try {
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
} finally {
  await client.close();
}
console.log('migrations applied');
