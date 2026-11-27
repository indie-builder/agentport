import type { generateCookie } from 'hono/cookie';

export const AUTH_COOKIE = 'agentport_token';

type HonoCookieAttributes = NonNullable<Parameters<typeof generateCookie>[2]>;
type CookieAttributes = Omit<HonoCookieAttributes, 'domain'> & { domain?: string | undefined };

export interface AuthService {
  $context: Promise<{
    authCookies: {
      sessionToken: {
        name: string;
        attributes: CookieAttributes;
      };
    };
  }>;
  api: {
    getSession: {
      (input: {
        headers: Headers;
        query?: { disableRefresh?: boolean };
        returnHeaders: true;
      }): Promise<{ response: unknown; headers: Headers }>;
      (input: {
        headers: Headers;
        query?: { disableRefresh?: boolean };
        returnHeaders?: false;
      }): Promise<unknown>;
    };
    signInUsername(input: {
      body: { username: string; password: string };
      headers: Headers;
      asResponse: true;
    }): Promise<Response>;
    signOut(input: { headers: Headers; asResponse: true }): Promise<Response>;
    changePassword(input: {
      body: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean };
      headers: Headers;
    }): Promise<unknown>;
    updateUser(input: {
      body: { name: string };
      headers: Headers;
      returnHeaders: true;
    }): Promise<{ headers: Headers }>;
    listSessions(input: { headers: Headers }): Promise<
      Array<{
        id: string;
        token: string;
        createdAt: Date;
        updatedAt: Date;
        expiresAt: Date;
        ipAddress?: string | null | undefined;
        userAgent?: string | null | undefined;
      }>
    >;
    revokeSession(input: {
      body: { token: string };
      headers: Headers;
      returnHeaders: true;
    }): Promise<{ headers: Headers }>;
  };
}
