import { z } from 'zod';

/**
 * 连接器目录条目：仅用于「浏览并预填创建表单」，不是可直接运行的东西。
 * 选中后仍走现有 POST /api/servers（校验 / SSRF / 加密 / 审计），测试连接仍是独立动作。
 * stdio 条目的命令会在用户显式保存并测试时于宿主执行 —— 目录本身不执行任何命令。
 */
export const connectorCatalogItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(['http', 'stdio']),
  /** http: 远程 MCP 端点。 */
  url: z.string().optional(),
  /** stdio: 启动命令与参数。 */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** stdio: 需要的环境变量「键名」，绝不带值。 */
  envKeys: z.array(z.string()).optional(),
  /** 来源与核对信息，帮助用户判断可信度。 */
  sourceUrl: z.string(),
  reviewedAt: z.string(),
});

export type ConnectorCatalogItem = z.infer<typeof connectorCatalogItemSchema>;

export const connectorCatalogSchema = z.array(connectorCatalogItemSchema);
