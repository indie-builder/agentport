import type { OpenAPI } from '@orpc/openapi';

const queueCounts = {
  anyOf: [
    {
      type: 'object',
      required: ['waiting', 'active', 'completed', 'failed', 'delayed'],
      properties: {
        waiting: { type: 'integer' },
        active: { type: 'integer' },
        completed: { type: 'integer' },
        failed: { type: 'integer' },
        delayed: { type: 'integer' },
      },
    },
    { enum: [null] },
  ],
} satisfies OpenAPI.SchemaObject;

const readiness = {
  type: 'object',
  required: ['status', 'db', 'redis'],
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded'] },
    db: { type: 'string', enum: ['ok', 'error'] },
    redis: { type: 'string', enum: ['ok', 'error'] },
  },
} satisfies OpenAPI.SchemaObject;

export const healthOpenAPIPaths: OpenAPI.PathsObject = {
  '/health/live': {
    servers: [{ url: '/' }],
    get: {
      operationId: 'healthLive',
      responses: {
        200: {
          description: '进程存活',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: { status: { type: 'string', const: 'ok' } },
              },
            },
          },
        },
      },
    },
  },
  '/health/ready': {
    servers: [{ url: '/' }],
    get: {
      operationId: 'healthReady',
      responses: {
        200: {
          description: 'PostgreSQL 与 Redis 可用',
          content: { 'application/json': { schema: readiness } },
        },
        503: {
          description: 'PostgreSQL 或 Redis 不可用',
          content: { 'application/json': { schema: readiness } },
        },
      },
    },
  },
  '/health/metrics': {
    servers: [{ url: '/' }],
    get: {
      operationId: 'healthMetrics',
      description: '需要 operations.read 权限。',
      responses: {
        200: {
          description: '进程、队列与数据库连通指标',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['process', 'queue', 'knowledgeQueue', 'db', 'redis'],
                properties: {
                  process: {
                    type: 'object',
                    required: ['uptimeSeconds', 'memoryRssBytes', 'bunVersion'],
                    properties: {
                      uptimeSeconds: { type: 'number' },
                      memoryRssBytes: { type: 'number' },
                      bunVersion: { type: 'string' },
                    },
                  },
                  queue: queueCounts,
                  knowledgeQueue: queueCounts,
                  db: {
                    type: 'object',
                    required: ['connected', 'pingMs', 'maxConnections'],
                    properties: {
                      connected: { type: 'boolean' },
                      pingMs: { anyOf: [{ type: 'number' }, { enum: [null] }] },
                      maxConnections: { anyOf: [{ type: 'integer' }, { enum: [null] }] },
                    },
                  },
                  redis: {
                    anyOf: [
                      {
                        type: 'object',
                        required: ['pingMs'],
                        properties: { pingMs: { type: 'number' } },
                      },
                      { enum: [null] },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
