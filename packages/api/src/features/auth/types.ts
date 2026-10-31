export const AUTH_COOKIE = 'agentport_token';
/** better-auth 会话有效期；cookie maxAge 与数据库 expiresAt 共用。 */
export const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24;

/** 首次初始化管理员使用的普通稳定业务 ID；与认证技术 ID 无关。 */
export const BOOTSTRAP_ADMIN_BUSINESS_ID = 'bootstrap-admin';
export const BOOTSTRAP_ID = 'initial';
