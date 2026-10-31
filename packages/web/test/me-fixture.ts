import { PERMISSIONS } from '@agentport/shared';

/**
 * 页面测试的默认已登录身份：目录内每个叶都有授权，便于原有用例聚焦交互。
 * 权限本身的判定由 access 单元测试覆盖，这里只避免页面因未配置 me 查询而挂起。
 */
export const allAccessMe = {
  authenticated: true as const,
  user: { businessId: 'test-admin', username: 'admin', name: '测试管理员' },
  roles: [],
  grants: PERMISSIONS.map((permission) => ({
    permissionId: permission.id,
    scope: permission.scopes[0]!,
  })),
};
