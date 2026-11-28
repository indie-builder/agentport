import { type Database, repo } from '@agentport/db';
import { hashPassword } from 'better-auth/crypto';
import type { Config } from '../../config.js';
import { BOOTSTRAP_ADMIN_BUSINESS_ID } from './types.js';

export async function ensureDefaultAssistant(db: Database): Promise<void> {
  await repo.bootstrap.ensureDefaultAssistant(db, BOOTSTRAP_ADMIN_BUSINESS_ID);
}

export async function ensureBootstrap(db: Database, config: Config): Promise<void> {
  await repo.bootstrap.ensureBootstrap(db, {
    adminUser: config.ADMIN_USER,
    adminBusinessId: BOOTSTRAP_ADMIN_BUSINESS_ID,
    createPasswordHash: () => hashPassword(config.ADMIN_PASSWORD),
  });
}
