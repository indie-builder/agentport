import { type OpenUiToolDescriptor, openUiPromptOptions } from '@agentport/shared';
import {
  generateSystemPrompt,
  type LibrarySpec,
  type SystemPromptSpec,
  type ToolSpec,
} from '@openuidev/lang-core';
import spec from './generated/openui.spec.json' with { type: 'json' };

/**
 * 服务端提示词只读官方 CLI 生成的 LibrarySpec（`packages/core/src/generated/openui.spec.json`）。
 * spec 由 `pnpm openui:spec` 从**真实的浏览器库**（`packages/web/src/openui/library.tsx`）导出，
 * 因此提示词里的签名、默认值与分组和前端实际渲染的是同一份契约，不存在第二套定义。
 *
 * 主构建不调用 web → core：生成物是提交进仓库的静态文件，构建只读。
 */

const CACHE_MAX = 32;

/** 提示词只随工具目录变化：按工具名+schema+描述缓存，避免每个 run 重算整段。 */
const cache = new Map<string, string>();

/** lang-core 的 ToolSpec 要求 outputSchema；平台侧可以没有，用 object 占位以保留入参签名。 */
function toToolSpec(tool: OpenUiToolDescriptor): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? { type: 'object' },
  };
}

/**
 * 生成式 UI 的系统提示词段。组件定义来自官方 spec，
 * inlineMode 让模型只在需要结构化输出时才放 `openui-lang` 围栏，普通提问仍用纯文本。
 * tools 必须与执行桥用同一份描述：提示词里没有的工具，前端调用会被拒绝。
 */
export function openuiSystemPrompt(tools: OpenUiToolDescriptor[] = []): string {
  const key = tools
    .map(
      (tool) =>
        `${tool.name}:${tool.description}:${JSON.stringify(tool.inputSchema ?? null)}:${JSON.stringify(tool.outputSchema ?? null)}`,
    )
    .sort()
    .join('|');
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const { tools: _ignored, examples, ...options } = openUiPromptOptions();
  const input: SystemPromptSpec = {
    library: spec as unknown as LibrarySpec,
    promptOptions: {
      ...options,
      examples,
      ...(tools.length === 0 ? {} : { tools: tools.map(toToolSpec) }),
    },
  };
  const prompt = generateSystemPrompt(input);
  // 超出上限时丢最早一条：工具目录是有限组合，不需要完整 LRU。
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, prompt);
  return prompt;
}
