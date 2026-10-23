/**
 * 把一个已完成的运行沉淀成技能草稿（「录制学习」）。纯函数：只读运行步骤，
 * 不执行任何东西、不落盘，由调用方决定是否插入为技能。
 */

export interface DraftStep {
  kind: 'user' | 'assistant' | 'tool';
  text?: string;
  name?: string | null;
}

export interface SkillDraft {
  slug: string;
  name: string;
  description: string;
  body: string;
}

/** 生成合法的技能 slug：小写、仅 [a-z0-9-_]、以字母数字开头、≤64。 */
export function slugify(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base =
    cleaned && /^[a-z0-9]/.test(cleaned) ? cleaned : `skill-${cleaned}`.replace(/^-+|-+$/g, '');
  return (base || fallback).slice(0, 64);
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? text).trim();
}

export function buildSkillDraft(input: {
  agentName: string;
  runId: string;
  steps: DraftStep[];
}): SkillDraft {
  const userStep = input.steps.find((s) => s.kind === 'user' && s.text?.trim());
  const assistantText = input.steps
    .filter((s) => s.kind === 'assistant' && s.text?.trim())
    .map((s) => s.text!.trim())
    .join('\n\n')
    .trim();
  const tools = [
    ...new Set(input.steps.filter((s) => s.kind === 'tool' && s.name).map((s) => s.name!)),
  ];

  const prompt = userStep?.text?.trim() ?? '';
  const task = firstLine(prompt) || `运行 ${input.runId}`;
  const name = `${input.agentName} · ${task}`.slice(0, 120);
  const description =
    (task.length > 140 ? `${task.slice(0, 137)}…` : task) || '从一次运行沉淀的技能';

  const sections = [`## 适用场景`, prompt || '（原始任务已不可用）'];
  if (tools.length > 0) {
    sections.push(`## 使用到的工具`, tools.map((t) => `- \`${t}\``).join('\n'));
  }
  if (assistantText) {
    sections.push(
      `## 参考做法`,
      assistantText.length > 4000 ? `${assistantText.slice(0, 4000)}…` : assistantText,
    );
  }
  const body = `# ${name}\n\n${sections.join('\n\n')}\n`;

  return {
    slug: slugify(`${input.agentName}-${task}`, `run-${input.runId.slice(-8)}`),
    name,
    description,
    body,
  };
}
