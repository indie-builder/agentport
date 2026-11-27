import type { PublicRunQuestion, RunStep } from '@agentport/shared';
import { isRecord } from './record.js';

export function messageText(content: unknown): string | null {
  if (Array.isArray(content)) {
    const parts = (content as unknown[]).flatMap((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    );
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return isRecord(content) && typeof content.text === 'string' ? content.text : null;
}

export function mergeToolSteps(steps: RunStep[]): RunStep[] {
  const merged: RunStep[] = [];
  const byToolUse = new Map<string, Extract<RunStep, { kind: 'tool' }>>();
  for (const step of steps) {
    if (step.kind !== 'tool' || step.toolUseId === null) {
      merged.push(step);
      continue;
    }
    const existing = byToolUse.get(step.toolUseId);
    if (!existing) {
      const copy = { ...step };
      byToolUse.set(step.toolUseId, copy);
      merged.push(copy);
      continue;
    }
    if (step.result !== undefined) existing.result = step.result;
    if (step.content !== null && step.content !== undefined) existing.content = step.content;
    if (step.question !== undefined) existing.question = step.question;
  }
  return merged;
}

function questionOf(content: Record<string, unknown>): PublicRunQuestion | undefined {
  const question = content.question;
  return isRecord(question) ? (question as PublicRunQuestion) : undefined;
}

export function toStep(message: {
  id?: string;
  role: string;
  content: unknown;
  createdAt: Date;
}): RunStep | null {
  const content = isRecord(message.content) ? message.content : null;
  const at = message.createdAt.toISOString();
  const text = messageText(message.content);
  const messageId = message.id === undefined ? {} : { messageId: message.id };

  if (message.role === 'user' && text !== null) {
    return { kind: 'user', at, text, ...messageId };
  }
  if (message.role === 'assistant' && content?.type === 'text' && text !== null) {
    return { kind: 'assistant', at, text, ...messageId };
  }
  if (message.role === 'tool' && content?.type === 'tool_use') {
    const question = questionOf(content);
    return {
      kind: 'tool',
      at,
      name: typeof content.name === 'string' ? content.name : null,
      toolUseId: typeof content.id === 'string' ? content.id : null,
      content: content.input,
      parentToolUseId: typeof content.parentToolUseId === 'string' ? content.parentToolUseId : null,
      ...(question === undefined ? {} : { question }),
    };
  }
  if (message.role === 'tool' && content?.type === 'tool_result') {
    const question = questionOf(content);
    return {
      kind: 'tool',
      at,
      name: typeof content.name === 'string' ? content.name : null,
      toolUseId: typeof content.toolUseId === 'string' ? content.toolUseId : null,
      content: null,
      result: content.content,
      parentToolUseId: typeof content.parentToolUseId === 'string' ? content.parentToolUseId : null,
      ...(question === undefined ? {} : { question }),
    };
  }
  return null;
}
