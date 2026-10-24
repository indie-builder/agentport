import { type AgentInput, agentInputSchema } from '@agentport/shared';
import { unsupportedAgentRuntime } from './agent-rules.js';
import { fail } from './errors.js';
import { parseMarkdownFrontmatter } from './markdown-frontmatter.js';

/**
 * 只接受官方智能体 frontmatter 中平台能落库的字段：导出器会写出
 * tools/disallowedTools/skills/permissionMode，必须能原样导回。
 */
const ALLOWED_KEYS = new Set([
  'name',
  'description',
  'model',
  'maxTurns',
  'effort',
  'tools',
  'disallowedTools',
  'skills',
  'permissionMode',
]);

const WARNING = '已按官方智能体字段导入；MCP Server 与子智能体需在平台重新绑定。';

function invalid(message: string, path: string): never {
  fail('INVALID_INPUT', message, { path });
}

/** 官方 tools/disallowedTools/skills 接受 YAML 列表或逗号分隔字符串。 */
export function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }
  invalid(`智能体文件的 ${field} 必须是字符串列表或逗号分隔字符串`, `/${field}`);
}

/** 报错路径指向用户写的字段：slug 来自 name，systemPrompt 来自正文。 */
function fieldOf(path: PropertyKey | undefined): string {
  const field = String(path ?? 'name');
  if (field === 'slug') return 'name';
  if (field === 'systemPrompt') return 'body';
  return field;
}

/** 解析官方智能体定义（frontmatter + 正文）；纯函数，拒绝会改变运行时行为的未声明字段。 */
export function parseAgentMd(
  content: string,
  options: { allowInherit?: boolean } = {},
): { agent: AgentInput; warnings: string[] } {
  const { fields, body: rawBody } = parseMarkdownFrontmatter(content, '智能体文件', '/agentMd');

  const unknown = [...fields.keys()].filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length > 0) {
    invalid(
      `不支持的智能体前置字段：${unknown.join('、')}（可能改变运行时行为）`,
      `/${unknown[0]}`,
    );
  }

  const name = fields.get('name');
  const description = fields.get('description');
  if (typeof description !== 'string' || description.trim() === '') {
    invalid('智能体文件的 description 不能为空', '/description');
  }

  const model = fields.get('model');
  if (model !== undefined) {
    if (typeof model !== 'string' || model.trim() === '') {
      invalid('智能体文件的 model 必须是非空字符串', '/model');
    }
    // 存储的根智能体没有父会话，inherit 在这里没有可继承的对象；
    // 子智能体文件允许 inherit，由调用方补上父模型后再落库。
    if (model === 'inherit' && options.allowInherit !== true) {
      invalid('智能体文件的 model 不支持 inherit（导入的是根智能体，无父会话可继承）', '/model');
    }
  }

  const body = rawBody.trim();
  if (body === '') invalid('智能体文件的正文（系统提示）不能为空', '/body');

  const warnings = [WARNING];
  const tools = stringList(fields.get('tools'), 'tools');
  const disallowedTools = stringList(fields.get('disallowedTools'), 'disallowedTools');
  // skills 是技能名而不是平台 ID，纯函数里无法解析绑定；导入后由用户重新选择。
  if ((stringList(fields.get('skills'), 'skills')?.length ?? 0) > 0) {
    warnings.push('技能前置字段 skills 不会自动绑定；请在平台重新选择技能');
  }

  const parsed = agentInputSchema.safeParse({
    slug: name,
    name,
    description,
    ...(model === undefined || model === 'inherit' ? {} : { model }),
    systemPrompt: body,
    maxTurns: fields.get('maxTurns'),
    effort: fields.get('effort'),
    permissionMode: fields.get('permissionMode'),
    ...(tools === undefined ? {} : { allowedTools: tools }),
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = fieldOf(issue?.path[0]);
    invalid(`智能体文件的 ${field} 无效：${issue?.message ?? '字段不合法'}`, `/${field}`);
  }

  // 导入与创建/PATCH 走同一份运行时安全规则，不能靠文件绕过。
  const runtime = unsupportedAgentRuntime(parsed.data);
  if (runtime) invalid(runtime.message, `/${runtime.field}`);

  return { agent: parsed.data, warnings };
}
