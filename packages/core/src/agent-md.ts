import { type AgentInput, agentInputSchema } from '@agentport/shared';
import { fail } from './errors.js';
import { parseMarkdownFrontmatter } from './markdown-frontmatter.js';
import { assertProjectMemory } from './official-files.js';

/** 只导入角色定义；运行限制与权限由平台默认值决定。 */
const ALLOWED_KEYS = new Set(['name', 'description', 'model', 'maxTurns', 'effort', 'memory']);

const WARNING = '仅导入角色定义；平台运行限制与权限采用默认值，请检查后运行。';

function invalid(message: string, path: string): never {
  fail('INVALID_INPUT', message, { path });
}

/** 报错路径指向用户写的字段：slug 来自 name，systemPrompt 来自正文。 */
function fieldOf(path: PropertyKey | undefined): string {
  const field = String(path ?? 'name');
  if (field === 'slug') return 'name';
  if (field === 'systemPrompt') return 'body';
  return field;
}

/** 解析官方智能体定义（frontmatter + 正文）；纯函数，拒绝会改变运行时行为的未声明字段。 */
export function parseAgentMd(content: string): { agent: AgentInput; warnings: string[] } {
  const { fields, body: rawBody } = parseMarkdownFrontmatter(content, '智能体文件', '/agentMd');

  const unknown = [...fields.keys()].filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length > 0) {
    invalid(
      `不支持的智能体前置字段：${unknown.join('、')}（可能改变运行时行为）`,
      `/${unknown[0]}`,
    );
  }
  assertProjectMemory(fields.get('memory'), '智能体文件', '/memory');

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
    // 存储的根智能体没有父会话，inherit 在这里没有可继承的对象。
    if (model === 'inherit') {
      invalid('智能体文件的 model 不支持 inherit（导入的是根智能体，无父会话可继承）', '/model');
    }
  }

  const body = rawBody.trim();
  if (body === '') invalid('智能体文件的正文（系统提示）不能为空', '/body');

  const parsed = agentInputSchema.safeParse({
    slug: name,
    name,
    description,
    ...(model === undefined ? {} : { model }),
    systemPrompt: body,
    maxTurns: fields.get('maxTurns'),
    effort: fields.get('effort'),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = fieldOf(issue?.path[0]);
    invalid(`智能体文件的 ${field} 无效：${issue?.message ?? '字段不合法'}`, `/${field}`);
  }

  return { agent: parsed.data, warnings: [WARNING] };
}
