import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  type Database,
} from '@agentport/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { hashPassword } from 'better-auth/crypto';
import { username } from 'better-auth/plugins/username';
import { eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import { isPgCode } from '../../plugins/errors.js';
import { AUTH_COOKIE, AUTH_MAX_AGE_SECONDS } from './types.js';

const ADMIN_USER_ID = 'agentport-admin-user';
const ADMIN_ACCOUNT_ID = 'agentport-admin-account';
const ADMIN_EMAIL = 'admin@agentport.invalid';

export function createAuth(config: Config, db: Database) {
  return betterAuth({
    baseURL: config.SELF_URL,
    secret: config.JWT_SECRET,
    trustedOrigins: [
      ...config.CORS_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
      config.SELF_URL,
    ],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: { expiresIn: AUTH_MAX_AGE_SECONDS },
    plugins: [
      username({
        minUsernameLength: 1,
        maxUsernameLength: 128,
        // ADMIN_USER 来自 env，语义上不限于默认验证器的字母数字下划线。
        usernameValidator: () => true,
        usernameNormalization: false,
        displayUsername: false,
      }),
    ],
    advanced: {
      // 显式关掉 __Secure- 前缀；secure 由应用按 NODE_ENV 决定。
      useSecureCookies: false,
      cookies: {
        session_token: {
          name: AUTH_COOKIE,
          attributes: {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            secure: config.NODE_ENV === 'production',
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * 幂等播种唯一管理员。onConflictDoUpdate 处理同 ID 并发；若其它唯一列（username/email）
 * 已被旧行占用，唯一冲突后按固定 ID 覆盖，避免启动失败。
 */
export async function ensureAdmin(db: Database, config: Config): Promise<void> {
  const now = new Date();
  const password = await hashPassword(config.ADMIN_PASSWORD);
  const user = {
    id: ADMIN_USER_ID,
    name: config.ADMIN_USER,
    email: ADMIN_EMAIL,
    emailVerified: true,
    username: config.ADMIN_USER,
    updatedAt: now,
  };

  try {
    await db
      .insert(authUsers)
      .values({ ...user, createdAt: now })
      .onConflictDoUpdate({ target: authUsers.id, set: user });
  } catch (error) {
    if (!isPgCode(error, '23505')) throw error;
    await db.update(authUsers).set(user).where(eq(authUsers.id, ADMIN_USER_ID));
  }

  const account = {
    id: ADMIN_ACCOUNT_ID,
    accountId: ADMIN_USER_ID,
    providerId: 'credential',
    userId: ADMIN_USER_ID,
    password,
    updatedAt: now,
  };
  try {
    await db
      .insert(authAccounts)
      .values({ ...account, createdAt: now })
      .onConflictDoUpdate({ target: authAccounts.id, set: account });
  } catch (error) {
    if (!isPgCode(error, '23505')) throw error;
    await db.update(authAccounts).set(account).where(eq(authAccounts.id, ADMIN_ACCOUNT_ID));
  }
}
