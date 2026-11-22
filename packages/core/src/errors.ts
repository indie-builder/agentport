import { ERROR_META, type ErrorCode } from '@agentport/shared';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly path?: string;
  readonly resource?: string;
  readonly resourceId?: string;
  readonly hint?: string;
  readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      path?: string;
      resource?: string;
      resourceId?: string;
      hint?: string;
      cause?: unknown;
      retryable?: boolean;
    },
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_META[code].status;
    this.retryable = options?.retryable ?? ERROR_META[code].retryable;
    if (options?.path !== undefined) this.path = options.path;
    if (options?.resource !== undefined) this.resource = options.resource;
    if (options?.resourceId !== undefined) this.resourceId = options.resourceId;
    if (options?.hint !== undefined) this.hint = options.hint;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export function fail(
  code: ErrorCode,
  message: string,
  options?: {
    path?: string;
    resource?: string;
    resourceId?: string;
    hint?: string;
    cause?: unknown;
    retryable?: boolean;
  },
): never {
  throw new AppError(code, message, options);
}

export function invalidInput(message: string, path: string): never {
  return fail('INVALID_INPUT', message, { path });
}

export const INVALID_CURSOR_MESSAGE = '分页游标无效，请刷新后重试';

export const AGENT_DIR_SLUG_INVALID_MESSAGE = '智能体目录名非法';

export const NOT_FOUND_MESSAGES = {
  agent: '智能体不存在，可能已被删除；请刷新后重试',
  conversation: '会话不存在，可能已被删除；请刷新后重试',
  run: '运行记录不存在，可能已被清理；请刷新后重试',
  approval: '审批记录不存在，可能已被处理或失效；请刷新后重试',
  workflow: '工作流不存在，可能已被删除；请刷新后重试',
  skill: '技能不存在，可能已被删除；请刷新后重试',
  plugin: '插件不存在，可能已被删除；请刷新后重试',
  runtimeEnvironment: '运行环境不存在，可能已被删除；请刷新后重试',
  runtimeEnvironmentVersion: '该构建版本不存在，可能已被清理；请刷新版本列表',
  dataDomain: '数据域不存在，可能已被删除；请刷新后重试',
  server: 'MCP Server 不存在，可能已被删除；请刷新后重试',
  tool: '该工具不存在，可能已被删除；请刷新后重试',
} as const;
export type NotFoundResource = keyof typeof NOT_FOUND_MESSAGES;

export const AGENT_SELECTION_MISSING_MESSAGE = '智能体不存在，可能已被删除；请刷新后重新选择';

export function notFound(resource: NotFoundResource, message?: string, resourceId?: string): never {
  throw new AppError('NOT_FOUND', message ?? NOT_FOUND_MESSAGES[resource], {
    resource,
    ...(resourceId === undefined ? {} : { resourceId }),
  });
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
