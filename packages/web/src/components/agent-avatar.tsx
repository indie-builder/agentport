import type { Agent } from '@agentport/shared';
import backendEngineer from '../assets/agents/backend-engineer.png';
import contentOps from '../assets/agents/content-ops.png';
import dataAnalyst from '../assets/agents/data-analyst.jpg';
import devopsEngineer from '../assets/agents/devops-engineer.jpg';
import digitalTwin from '../assets/agents/digital-twin.png';
import frontendEngineer from '../assets/agents/frontend-engineer.png';
import opsEngineer from '../assets/agents/ops-engineer.jpg';
import productManager from '../assets/agents/product-manager.jpg';
import projectAdmin from '../assets/agents/project-admin.jpg';
import qaEngineer from '../assets/agents/qa-engineer.png';
import supportBot from '../assets/agents/support-bot.jpg';
import uiDesigner from '../assets/agents/ui-designer.jpg';
import { cn } from '../lib/cn.js';

/**
 * 专家没有存头像字段，按角色关键词匹配一组固定插画头像；未命中时稳定散列到同一组图，
 * 保证同一个 slug 每次渲染都是同一个头像，不新增 schema。
 */
const avatars = [
  frontendEngineer,
  backendEngineer,
  qaEngineer,
  productManager,
  dataAnalyst,
  uiDesigner,
  contentOps,
  devopsEngineer,
  projectAdmin,
  supportBot,
  opsEngineer,
];

// 从具体到宽泛排列，先命中先返回（如「前端工程师」先于「工程师」）。
const roleAvatars: ReadonlyArray<readonly [RegExp, string]> = [
  [/前端|frontend|react|ui\s*工程/i, frontendEngineer],
  [/后端|backend|server\s*端|api\s*开发/i, backendEngineer],
  [/测试|qa|quality/i, qaEngineer],
  [/产品|product|\bpm\b/i, productManager],
  [/数据|analyst|data/i, dataAnalyst],
  [/设计|\bui\b|ux|design/i, uiDesigner],
  [/运营|内容|content|运营专员/i, contentOps],
  [/devops|运维|ops|部署/i, devopsEngineer],
  [/项目|管理|admin|manager/i, projectAdmin],
  [/客服|答疑|support|助手|助理/i, supportBot],
];

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h;
}

const occupationAvatars: Record<string, string> = {
  通用助手: supportBot,
  前端工程师: frontendEngineer,
  后端工程师: backendEngineer,
  测试工程师: qaEngineer,
  产品经理: productManager,
  数据分析师: dataAnalyst,
  'UI 设计师': uiDesigner,
  内容运营专员: contentOps,
  'DevOps 工程师': devopsEngineer,
  项目管理员: projectAdmin,
  群聊答疑专员: supportBot,
  运维工程师: opsEngineer,
  数字分身: digitalTwin,
};

export function agentAvatar(
  agent: Pick<Agent, 'name' | 'description'> & { role?: string | null; slug?: string | null },
): string {
  const occupation = agent.role ? occupationAvatars[agent.role] : undefined;
  if (occupation) return occupation;
  const slug = agent.slug ?? '';
  const identity = `${agent.name} ${slug} ${agent.description}`;
  for (const [pattern, src] of roleAvatars) if (pattern.test(identity)) return src;
  return avatars[hash(slug) % avatars.length] ?? frontendEngineer;
}

/** 圆形插画头像；尺寸由外部用 size-* 决定，默认 40px。 */
export function AgentAvatar({
  agent,
  className,
}: {
  agent: Pick<Agent, 'name' | 'description'> & { role?: string | null; slug?: string | null };
  className?: string;
}) {
  return (
    <img
      src={agentAvatar(agent)}
      alt=""
      aria-hidden="true"
      className={cn('size-10 shrink-0 rounded-full bg-muted object-cover', className)}
    />
  );
}
