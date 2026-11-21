import { type OpenUiToolDescriptor, openUiPromptOptions } from '@agentport/shared';
import {
  generateSystemPrompt,
  type LibrarySpec,
  type SystemPromptSpec,
  type ToolSpec,
} from '@openuidev/lang-core';
import { LRUCache } from 'lru-cache';
import spec from './generated/openui.spec.json' with { type: 'json' };

const cache = new LRUCache<string, string>({ max: 32 });

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
  const cached = cache.peek(key);
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
  cache.set(key, prompt);
  return prompt;
}
