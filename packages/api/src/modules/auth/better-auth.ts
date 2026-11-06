import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  type Database,
} from '@agentport/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { username } from 'better-auth/plugins/username';
import type { Config } from '../../config.js';
import { getTrustedOrigins } from '../../config.js';
import { AUTH_COOKIE, AUTH_MAX_AGE_SECONDS } from './types.js';

export function createAuth(config: Config, db: Database) {
  return betterAuth({
    baseURL: config.SELF_URL,
    secret: config.JWT_SECRET,
    trustedOrigins: getTrustedOrigins(config),
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
    user: {
      // 业务身份与停用状态由应用写入；客户端不能通过注册/更新接口改动。
      additionalFields: {
        businessId: { type: 'string', required: true, input: false },
        disabled: { type: 'boolean', required: false, defaultValue: false, input: false },
      },
    },
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
