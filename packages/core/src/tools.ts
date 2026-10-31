/** `.mcp.json` 中的单个条目。 */
export type McpJsonEntry =
  | { command: string; args: string[]; env: Record<string, string> }
  | {
      type: 'http';
      url: string;
      headers: Record<string, string>;
      /** 仅预览用：说明运行时注入的 Authorization，不写入真实工作区文件。 */
      _note?: string;
    };
