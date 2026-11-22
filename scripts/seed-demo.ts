import { existsSync } from 'node:fs';
import { createDb, platformBootstrap, repo } from '@agentport/db';
import { eq } from 'drizzle-orm';
import { seedActivity } from './seed/activity';
import { seedAgents } from './seed/agents';
import { seedChannels } from './seed/channels';
import { seedKnowledge } from './seed/knowledge';
import { seedOps } from './seed/ops';
import type { DemoCatalog, SeedContext } from './seed/types';

const envPath = Bun.fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('缺少 DATABASE_URL；请在根 .env 配置后重试');
  process.exit(1);
}

const { db, client } = createDb(databaseUrl);

try {
  const secretKey = process.env.APP_SECRET_KEY;
  if (!secretKey || secretKey.length < 32) {
    console.error('缺少 APP_SECRET_KEY 或长度不足 32 字符；请在根 .env 配置后重试');
    process.exit(1);
  }

  const [bootstrap] = await db
    .select({ adminBusinessId: platformBootstrap.adminBusinessId })
    .from(platformBootstrap)
    .where(eq(platformBootstrap.id, repo.access.BOOTSTRAP_ID))
    .limit(1);
  const businessId = bootstrap?.adminBusinessId ?? 'bootstrap-admin';
  if (!bootstrap?.adminBusinessId) {
    console.log(
      '未找到 platform_bootstrap.admin_business_id，使用 bootstrap-admin；首次登录后管理员若使用其它 businessId，个人页可能看不到演示数据',
    );
  }

  const catalog: DemoCatalog = {};
  const ctx: SeedContext = {
    db,
    businessId,
    now: new Date(),
    log: (message) => console.log(message),
  };

  await seedAgents(ctx, catalog);
  await seedKnowledge(ctx);
  await seedChannels(ctx, catalog);
  await seedActivity(ctx, catalog);
  await seedOps(ctx, catalog);

  console.log(
    `演示数据种子完成：businessId=${businessId}，专家=${Object.keys(catalog.agents ?? {}).length}，频道=${Object.keys(catalog.channels ?? {}).length}`,
  );
} finally {
  await client.close();
}
