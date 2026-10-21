import { z } from 'zod';
/** 用户配置的 MCP Server；密钥字段在 API 层加密，返回时脱敏。 */
export declare const serverKindSchema: z.ZodEnum<{
    generated: "generated";
    http: "http";
    stdio: "stdio";
}>;
export type ServerKind = z.infer<typeof serverKindSchema>;
export declare const SECRET_MASK = "\u2022\u2022\u2022\u2022";
export declare const PREVIEW_SECRET = "\u2022\u2022\u2022\u2022";
/** 空值保留为空；已配置密钥不泄露长度或前缀。 */
export declare function maskSecret(value: string | null | undefined): string;
/** Build an MCP entry with values supplied by the caller (masked, empty, or runtime secrets). */
export declare function previewMcpEntry(server: {
    kind: ServerKind;
    config: Record<string, unknown>;
}, values?: Record<string, string>): {
    command: string;
    args: string[];
    env: Record<string, string>;
    type?: never;
    url?: never;
    headers?: never;
} | {
    command?: never;
    args?: never;
    env?: never;
    type: 'http';
    url: string;
    headers: Record<string, string>;
};
export declare const stdioServerSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    kind: z.ZodLiteral<"stdio">;
    command: z.ZodString;
    args: z.ZodDefault<z.ZodArray<z.ZodString>>;
    env: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>;
/** 只允许 http/https；ftp/file/javascript 等在 schema 层就被拦下。 */
export declare const httpUrlSchema: z.ZodURL;
export declare const httpServerSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    kind: z.ZodLiteral<"http">;
    url: z.ZodURL;
    headers: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>;
/** 由平台自身把上游 HTTP API 包装成 MCP 的 server。 */
export declare const generatedServerSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    kind: z.ZodLiteral<"generated">;
    baseUrl: z.ZodURL;
    headers: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>;
export declare const serverInputSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    kind: z.ZodLiteral<"stdio">;
    command: z.ZodString;
    args: z.ZodDefault<z.ZodArray<z.ZodString>>;
    env: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    kind: z.ZodLiteral<"http">;
    url: z.ZodURL;
    headers: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    kind: z.ZodLiteral<"generated">;
    baseUrl: z.ZodURL;
    headers: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>], "kind">;
export type ServerInput = z.infer<typeof serverInputSchema>;
export declare const serverSchema: z.ZodIntersection<z.ZodDiscriminatedUnion<[z.ZodObject<{
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    kind: z.ZodLiteral<"stdio">;
    command: z.ZodString;
    args: z.ZodDefault<z.ZodArray<z.ZodString>>;
    env: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    kind: z.ZodLiteral<"http">;
    url: z.ZodURL;
    headers: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    kind: z.ZodLiteral<"generated">;
    baseUrl: z.ZodURL;
    headers: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>], "kind">, z.ZodObject<{
    id: z.ZodString;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, z.core.$strip>>;
export type Server = z.infer<typeof serverSchema>;
/** generated server 下的单个 HTTP 工具。 */
export declare const apiToolInputSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    method: z.ZodDefault<z.ZodEnum<{
        DELETE: "DELETE";
        GET: "GET";
        PATCH: "PATCH";
        POST: "POST";
        PUT: "PUT";
    }>>;
    pathTemplate: z.ZodString;
    inputSchema: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    paramsIn: z.ZodDefault<z.ZodEnum<{
        body: "body";
        query: "query";
    }>>;
    requiresApproval: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type ApiToolInput = z.infer<typeof apiToolInputSchema>;
export declare const apiToolSchema: z.ZodIntersection<z.ZodObject<{
    name: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    method: z.ZodDefault<z.ZodEnum<{
        DELETE: "DELETE";
        GET: "GET";
        PATCH: "PATCH";
        POST: "POST";
        PUT: "PUT";
    }>>;
    pathTemplate: z.ZodString;
    inputSchema: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    paramsIn: z.ZodDefault<z.ZodEnum<{
        body: "body";
        query: "query";
    }>>;
    requiresApproval: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    id: z.ZodString;
    serverId: z.ZodString;
    enabled: z.ZodBoolean;
    createdAt: z.ZodString;
}, z.core.$strip>>;
export type ApiTool = z.infer<typeof apiToolSchema>;
/** 测试连接的结果，回显到页面。 */
export declare const serverTestResultSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    serverInfo: z.ZodOptional<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
    }, z.core.$strip>>;
    tools: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    error: z.ZodOptional<z.ZodString>;
    durationMs: z.ZodNumber;
}, z.core.$strip>;
export type ServerTestResult = z.infer<typeof serverTestResultSchema>;
//# sourceMappingURL=mcp.d.ts.map