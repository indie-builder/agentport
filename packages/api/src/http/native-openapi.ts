import { auditItemSchema } from '@agentport/contract/audit';
import { evalCaseExportQuerySchema } from '@agentport/contract/eval';
import {
  AGENT_PACKAGE_MAX_BYTES,
  agentSchema,
  channelEventSchema,
  channelEventsQuerySchema,
  chatEventSchema,
  evalDatasetSchema,
  evalRunExportSchema,
  knowledgeFaqTransferDocumentSchema,
  outputContentSchema,
  outputPathSchema,
  pluginSchema,
  problemSchema,
  runListItemSchema,
} from '@agentport/shared';
import { isObjectSchema, type OpenAPI, toOpenAPIParameters, toOpenAPISchema } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { z } from 'zod';
import { agentImportQuerySchema } from '../modules/agents/http.js';
import { auditExportQuerySchema } from '../modules/audit/http.js';
import { PLUGIN_ZIP_MAX_BYTES, pluginImportQuerySchema } from '../modules/plugins/http.js';
import { runExportQuerySchema } from '../modules/runs/router.js';

const converter = new ZodToJsonSchemaConverter();
export const nativeOpenAPISchemas: Record<string, OpenAPI.SchemaObject> = {
  ChatEvent: toOpenAPISchema(converter.convert(chatEventSchema, { strategy: 'output' })[1]),
  ChannelEvent: toOpenAPISchema(converter.convert(channelEventSchema, { strategy: 'output' })[1]),
};
function jsonSchema(name: string, schema: z.ZodType): OpenAPI.ReferenceObject {
  nativeOpenAPISchemas[name] = toOpenAPISchema(
    converter.convert(schema, { strategy: 'output' })[1],
  );
  return { $ref: `#/components/schemas/${name}` };
}
const problem = {
  description: 'Problem，包含 code、message、status、requestId、retryable。',
  content: { 'application/json': { schema: jsonSchema('Problem', problemSchema) } },
} satisfies OpenAPI.ResponseObject;
const protectedErrors = {
  400: problem,
  401: problem,
  403: problem,
  404: problem,
  429: problem,
  500: problem,
  503: problem,
};
const session = [{ sessionCookie: [] }];
const binary = { type: 'string', format: 'binary' } satisfies OpenAPI.SchemaObject;
const disposition = {
  description: '附件文件名，可能包含 RFC 5987 UTF-8 filename*。',
  schema: { type: 'string' },
} satisfies OpenAPI.HeaderObject;
const attachmentHeaders = { 'Content-Disposition': disposition };
const archive = {
  description: 'ZIP 附件。',
  headers: attachmentHeaders,
  content: { 'application/zip': { schema: binary } },
} satisfies OpenAPI.ResponseObject;
const download = {
  description: '原始文件附件；Content-Type 取决于存储文件的 MIME。',
  headers: attachmentHeaders,
  content: { '*/*': { schema: binary } },
} satisfies OpenAPI.ResponseObject;
const markdown = {
  description: 'UTF-8 Markdown 附件。',
  headers: attachmentHeaders,
  content: { 'text/markdown': { schema: { type: 'string' } } },
} satisfies OpenAPI.ResponseObject;

function params(...names: string[]): OpenAPI.ParameterObject[] {
  return names.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', minLength: 1 },
  }));
}

function query(shape: Record<string, z.ZodType>): OpenAPI.ParameterObject[] {
  const [, schema] = converter.convert(z.object(shape), { strategy: 'input' });
  if (!isObjectSchema(schema)) throw new Error('OpenAPI query schema must be an object');
  return toOpenAPIParameters(schema, 'query');
}

function jsonAttachment(name: string, schema: z.ZodType) {
  return {
    description: 'JSON 附件。',
    headers: attachmentHeaders,
    content: { 'application/json': { schema: jsonSchema(name, schema) } },
  } satisfies OpenAPI.ResponseObject;
}

function events(eventSchema: z.ZodType) {
  return {
    description: `SSE 文本流，只发送 data 行和保活注释，不设置 event 或 id 字段。data 为 JSON 事件，结构见 ${eventSchema === channelEventSchema ? '#/components/schemas/ChannelEvent' : '#/components/schemas/ChatEvent'}。连接起始发送 retry: 3000。`,
    headers: {
      'Cache-Control': { schema: { type: 'string', enum: ['no-cache, no-transform'] } },
      'X-Accel-Buffering': { schema: { type: 'string', enum: ['no'] } },
    },
    content: {
      'text/event-stream': {
        schema: { type: 'string', description: '标准 SSE 帧，data 行是 JSON 字符串。' },
      },
    },
  } satisfies OpenAPI.ResponseObject;
}

const zipRequest = {
  required: true,
  description: '原始 ZIP 字节，使用 application/zip，不使用 multipart/form-data。',
  content: { 'application/zip': { schema: binary } },
} satisfies OpenAPI.RequestBodyObject;
const strings = z.array(z.string());
const exportedAt = z.iso.datetime();
const count = z.number().int().nonnegative();

export const nativeOpenAPIPaths: OpenAPI.PathsObject = {
  '/audit/export': {
    get: {
      operationId: 'exportAudit',
      description:
        '需要 audit.read。可用 actor、actorKind、since（created_at 下限）与 before（created_at 上限）组合过滤。format=ndjson 返回 application/x-ndjson，每行一个事件，按 chain_seq 升序，含 chainSeq/prevHash/hash，用 afterSeq 游标分页（响应头 x-next-after-seq），空页表示结束；format=json（默认）返回审计快照，最多 limit 条，超限返回 409。',
      security: session,
      parameters: query(auditExportQuerySchema.shape),
      responses: {
        ...protectedErrors,
        200: {
          description: 'JSON 审计快照，或 NDJSON 行分隔的链式事件。',
          headers: {
            ...attachmentHeaders,
            'X-Next-After-Seq': { schema: { type: 'string' } },
          },
          content: {
            'application/json': {
              schema: jsonSchema(
                'AuditExport',
                z.object({
                  format: z.literal('agentport/audit@1'),
                  exportedAt,
                  items: z.array(auditItemSchema),
                }),
              ),
            },
            'application/x-ndjson': {
              schema: jsonSchema(
                'AuditExportLine',
                z.object({
                  ...auditItemSchema.shape,
                  chainSeq: z.number().int(),
                  prevHash: z.string().nullable(),
                  hash: z.string().nullable(),
                }),
              ),
            },
          },
        },
        409: problem,
      },
    },
  },
  '/knowledge/versions/{versionId}/images/{name}': {
    get: {
      operationId: 'knowledgeVersionImage',
      description: '需要 knowledge.read。图片名必须属于此版本。',
      security: session,
      parameters: params('versionId', 'name'),
      responses: {
        ...protectedErrors,
        200: {
          description:
            '图片原始字节，MIME 使用 image/*，不合法的记录回落 application/octet-stream。',
          headers: { 'Cache-Control': { schema: { type: 'string', enum: ['private'] } } },
          content: {
            'image/*': { schema: binary },
            'application/octet-stream': { schema: binary },
          },
        },
      },
    },
  },
  '/knowledge/versions/{versionId}/content': {
    get: {
      operationId: 'knowledgeVersionOriginal',
      description: '需要 knowledge.read。MIME 为存储的原件类型。',
      security: session,
      parameters: params('versionId'),
      responses: { ...protectedErrors, 200: download },
    },
  },
  '/knowledge/versions/{versionId}/markdown': {
    get: {
      operationId: 'knowledgeVersionMarkdown',
      description: '需要 knowledge.read。返回已解析正文。',
      security: session,
      parameters: params('versionId'),
      responses: {
        ...protectedErrors,
        200: {
          description: 'UTF-8 Markdown 正文。',
          headers: {
            'X-Knowledge-Document-Status': {
              description: '文档当前状态。',
              schema: { type: 'string' },
            },
          },
          content: { 'text/markdown': { schema: { type: 'string' } } },
        },
      },
    },
  },
  '/knowledge/bases/{id}/export': {
    get: {
      operationId: 'exportKnowledgePackage',
      description: '需要 knowledge.export 及知识库对象范围。',
      security: session,
      parameters: params('id'),
      responses: { ...protectedErrors, 200: archive, 409: problem },
    },
  },
  '/knowledge/bases/import': {
    post: {
      operationId: 'importKnowledgePackage',
      description: '需要 knowledge.import 和可信 Origin。原始 ZIP 最大 64 MiB，创建新知识库。',
      security: session,
      requestBody: zipRequest,
      responses: {
        ...protectedErrors,
        201: {
          description: '知识库及内置连接器已创建。',
          content: {
            'application/json': {
              schema: jsonSchema(
                'KnowledgePackageImport',
                z.object({
                  baseId: z.string(),
                  serverId: z.string(),
                  counts: z.object({
                    folders: count,
                    tags: count,
                    documents: count,
                    versions: count,
                    chunks: count,
                    wikiPages: count,
                  }),
                }),
              ),
            },
          },
        },
        409: problem,
        413: problem,
        415: problem,
      },
    },
  },
  '/knowledge/bases/{id}/faqs/export': {
    get: {
      operationId: 'exportKnowledgeFaqs',
      description:
        '需要 knowledge.export 及知识库对象范围。format=csv 选择 CSV，其余值使用 JSON；version=draft 选择草稿，其余值使用已发布版本。最多 500 条。',
      security: session,
      parameters: [
        ...params('id'),
        {
          name: 'format',
          in: 'query',
          schema: { type: 'string', default: 'json', example: 'csv' },
        },
        {
          name: 'version',
          in: 'query',
          schema: { type: 'string', default: 'published', example: 'draft' },
        },
      ],
      responses: {
        ...protectedErrors,
        200: {
          description: 'FAQ 附件，JSON 与 CSV 均可原样导回。',
          headers: attachmentHeaders,
          content: {
            'application/json': {
              schema: jsonSchema('KnowledgeFaqTransfer', knowledgeFaqTransferDocumentSchema),
            },
            'text/csv': {
              schema: { type: 'string', description: '固定七列，字段与 FAQ 导入格式一致。' },
            },
          },
        },
        409: problem,
        413: problem,
      },
    },
  },
  '/conversations/{id}/outputs/{runId}/content': {
    get: {
      operationId: 'conversationOutputContent',
      description:
        '需要 conversations.read 及会话私人正文范围。预览限 1 MiB，只支持 UTF-8 text/*、application/json、image/svg+xml。',
      security: session,
      parameters: [...params('id', 'runId'), ...query({ path: outputPathSchema })],
      responses: {
        ...protectedErrors,
        200: {
          description: '成果元数据及文本正文。',
          content: {
            'application/json': { schema: jsonSchema('OutputContent', outputContentSchema) },
          },
        },
        413: problem,
        415: problem,
      },
    },
  },
  '/conversations/{id}/outputs/{runId}/download': {
    get: {
      operationId: 'downloadConversationOutput',
      description: '需要 conversations.read 及会话私人正文范围。返回成果原件。',
      security: session,
      parameters: [...params('id', 'runId'), ...query({ path: outputPathSchema })],
      responses: { ...protectedErrors, 200: download },
    },
  },
  '/chat/{runId}/events': {
    get: {
      operationId: 'chatRunEvents',
      description:
        '需要 runs.read 及运行私人正文范围。重连从保留的事件流起点回放，不消费 Last-Event-ID。终态或 run_unavailable 后关闭连接。',
      security: session,
      parameters: params('runId'),
      responses: { ...protectedErrors, 200: events(chatEventSchema) },
    },
  },
  '/conversations/{id}/attachments/{attachmentId}/download': {
    get: {
      operationId: 'downloadConversationAttachment',
      description: '需要 conversations.read 及会话私人正文范围。附件必须属于此会话。',
      security: session,
      parameters: params('id', 'attachmentId'),
      responses: { ...protectedErrors, 200: download },
    },
  },
  '/public/output-shares/{id}/download': {
    get: {
      operationId: 'downloadPublicOutputShare',
      description:
        '使用分享链接的 token 作为 Authorization: Bearer，独立于登录会话。token 缺失、错误、已撤销或文件变化均返回 404。URL 片段不会发送到服务端。',
      security: [{ shareToken: [] }],
      parameters: params('id'),
      responses: { 200: download, 404: problem, 429: problem, 500: problem },
    },
  },
  '/eval/cases/export': {
    get: {
      operationId: 'exportEvalCases',
      description: '需要 eval.read 及智能体对象范围。最多 500 条和 1 MiB。',
      security: session,
      parameters: query(evalCaseExportQuerySchema.shape),
      responses: {
        ...protectedErrors,
        200: jsonAttachment('EvalDataset', evalDatasetSchema),
        409: problem,
      },
    },
  },
  '/eval/runs/{id}/export': {
    get: {
      operationId: 'exportEvalRun',
      description:
        '需要 eval.read 及智能体对象范围。运行中返回 409 EVAL_RUN_IN_PROGRESS；最多 500 条结果和 1 MiB。',
      security: session,
      parameters: params('id'),
      responses: {
        ...protectedErrors,
        200: jsonAttachment('EvalRunExport', evalRunExportSchema),
        409: problem,
      },
    },
  },
  '/channels/{id}/events': {
    get: {
      operationId: 'channelEvents',
      description:
        '需要登录及频道读取范围。after 为已收到的消息序号，默认 0；大于当前序号返回 400。重连由 after 恢复，不消费 Last-Event-ID。失去读取权限时发送 error 并关闭连接。',
      security: session,
      parameters: [...params('id'), ...query(channelEventsQuerySchema.shape)],
      responses: { ...protectedErrors, 200: events(channelEventSchema) },
    },
  },
  '/channels/{id}/runs/{runId}/events': {
    get: {
      operationId: 'channelRunEvents',
      description:
        '需要登录且为频道成员，运行必须属于此频道。重连从保留的事件流起点回放，不消费 Last-Event-ID；失去成员资格时发送 run_unavailable 并关闭连接。',
      security: session,
      parameters: params('id', 'runId'),
      responses: { ...protectedErrors, 200: events(chatEventSchema) },
    },
  },
  '/channels/{id}/runs/{runId}/outputs/download': {
    get: {
      operationId: 'downloadChannelRunOutput',
      description: '需要登录且为频道成员，运行必须属于此频道。返回成果原件。',
      security: session,
      parameters: [...params('id', 'runId'), ...query({ path: outputPathSchema })],
      responses: { ...protectedErrors, 200: download },
    },
  },
  '/me/memory/download': {
    get: {
      operationId: 'downloadPersonalMemory',
      description: '需要 personal_memory.read，仅下载当前用户的个人记忆。',
      security: session,
      responses: { ...protectedErrors, 200: markdown },
    },
  },
  '/runs/export': {
    get: {
      operationId: 'exportRuns',
      description:
        '需要 runs.export，按当前账号对象范围筛选。超过 limit 返回 409，请先缩小筛选范围。',
      security: session,
      parameters: query(runExportQuerySchema.shape),
      responses: {
        ...protectedErrors,
        200: jsonAttachment(
          'RunExport',
          z.object({
            format: z.literal('agentport/runs@1'),
            exportedAt,
            items: z.array(runListItemSchema),
          }),
        ),
        409: problem,
      },
    },
  },
  '/skills/{id}/file': {
    get: {
      operationId: 'downloadSkillFile',
      description: '需要 skills.read，下载官方 SKILL.md 文件。',
      security: session,
      parameters: params('id'),
      responses: { ...protectedErrors, 200: markdown },
    },
  },
  '/plugins/import': {
    post: {
      operationId: 'importPluginZip',
      description: `需要 plugins.import 和可信 Origin。原始 ZIP 最大 ${PLUGIN_ZIP_MAX_BYTES / 1024 / 1024} MiB。`,
      security: session,
      parameters: query(pluginImportQuerySchema.shape),
      requestBody: zipRequest,
      responses: {
        ...protectedErrors,
        201: {
          description: '插件已创建。',
          content: {
            'application/json': {
              schema: jsonSchema(
                'PluginZipImport',
                z.object({ plugin: pluginSchema, warnings: strings }),
              ),
            },
          },
        },
        409: problem,
        413: problem,
        415: problem,
      },
    },
  },
  '/plugins/{id}/export': {
    get: {
      operationId: 'exportPluginZip',
      description: '需要 plugins.export。',
      security: session,
      parameters: params('id'),
      responses: { ...protectedErrors, 200: archive },
    },
  },
  '/import/agents': {
    post: {
      operationId: 'importAgentZip',
      description: `需要 agents.import、agents.create 和可信 Origin。新建连接器或技能还需 servers.create、skills.create；指定运行环境需 runtime_environments.read。原始 ZIP 最大 ${AGENT_PACKAGE_MAX_BYTES / 1024 / 1024} MiB。`,
      security: session,
      parameters: query(agentImportQuerySchema.shape),
      requestBody: zipRequest,
      responses: {
        ...protectedErrors,
        201: {
          description: '智能体及关联资源已导入。',
          content: {
            'application/json': {
              schema: jsonSchema(
                'AgentZipImport',
                z.object({
                  agent: agentSchema,
                  createdServers: strings,
                  reusedServers: strings,
                  createdSkills: strings,
                  createdSubAgents: strings,
                  warnings: strings,
                }),
              ),
            },
          },
        },
        409: problem,
        413: problem,
        415: problem,
      },
    },
  },
  '/export/agents/{id}': {
    get: {
      operationId: 'exportAgentZip',
      description:
        '需要 agents.export、agents.files.read、agents.config.read、agents.rules.read、agents.styles.read、agents.memory.read 及对应智能体对象范围。',
      security: session,
      parameters: params('id'),
      responses: {
        ...protectedErrors,
        200: {
          ...archive,
          headers: {
            ...attachmentHeaders,
            'X-Package-Warnings': {
              description: 'encodeURIComponent 编码的 JSON 警告数组。',
              schema: { type: 'string' },
            },
          },
        },
        409: problem,
      },
    },
  },
  '/agents/{id}/subagents/{childId}/file': {
    get: {
      operationId: 'downloadSubagentFile',
      description:
        '需要 agents.files.read、agents.config.read 及父智能体对象范围。childId 必须是此父智能体的子智能体。',
      security: session,
      parameters: params('id', 'childId'),
      responses: { ...protectedErrors, 200: markdown },
    },
  },
  '/agents/{id}/memory/download': {
    get: {
      operationId: 'downloadAgentMemory',
      description:
        '需要 agents.memory.read 及智能体对象范围。空目录返回 404，超出包大小或文件数上限返回 409。',
      security: session,
      parameters: params('id'),
      responses: { ...protectedErrors, 200: archive, 409: problem },
    },
  },
};
