import type { ChatEvent } from './chat.js';
import type { PublicRunQuestion, RunQuestion } from './questions.js';

/** 沙盒输出中的常见凭证只保留前 4 位，供日志、API 与消息展示共用。 */
function mask(secret: string): string {
  return secret.length > 4 ? `${secret.slice(0, 4)}***` : '***';
}

// 有界 lookahead 保住长度阈值，+ 避免数 MB 连续串耗尽 V8 回溯栈。
const BEARER = /(\bBearer\s+)(?=[A-Za-z0-9._~+/=-]{8})([A-Za-z0-9._~+/=-]+)/gi;
const PROVIDER_KEY = /\b(?:sk-|ghp_)[A-Za-z0-9_-]+/g;
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]*)=("[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi;
const BASE64URL = /[A-Za-z0-9_-]+/g;

/** UUID、全小写 hash 也会命中 base64url；要求大小写与数字同时出现。 */
function looksRandom(token: string): boolean {
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token);
}

export function redactSecrets(text: string): string {
  return text
    .replace(BEARER, (_match, prefix: string, token: string) => `${prefix}${mask(token)}`)
    .replace(PROVIDER_KEY, (match) => {
      const prefixLength = match.startsWith('sk-') ? 3 : 4;
      return match.length - prefixLength >= 16 ? mask(match) : match;
    })
    .replace(ASSIGNMENT, (_match, key: string, value: string) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
      const body = quote ? value.slice(1, -1) : value;
      return `${key}=${quote}${mask(body)}${quote}`;
    })
    .replace(BASE64URL, (match) =>
      match.length >= 32 && looksRandom(match) ? mask(match) : match,
    );
}

/** 工具入参是 JSON 字符串：逐字符串值脱敏，避免正则把 JSON 的结束引号当成值的一部分。 */
export function redactJson(json: string): string {
  try {
    return JSON.stringify(redactJsonValue(JSON.parse(json)));
  } catch {
    // 截断的入参本来就不是合法 JSON，退回文本脱敏。
    return redactSecrets(json);
  }
}

function redactJsonValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactJsonValue(item)]),
  );
}

/**
 * 公开事件里原生文本字段的唯一脱敏点。
 * `question_updated` 已是 publicRunQuestion 投影，不能再处理：它的 answers 以题序号为键，
 * 二次投影会按脱敏后的问题文本找不到答案。
 */
export function redactChatEvent(event: ChatEvent): ChatEvent {
  switch (event.type) {
    case 'assistant_text':
    case 'text_delta':
      return { ...event, text: redactSecrets(event.text) };
    case 'tool_input':
      return { ...event, json: redactJson(event.json) };
    case 'tool_result':
      return {
        ...event,
        content: redactSecrets(event.content),
        ...(event.todos === undefined
          ? {}
          : {
              todos: event.todos.map((todo) => ({
                ...todo,
                content: redactSecrets(todo.content),
                activeForm: redactSecrets(todo.activeForm),
              })),
            }),
      };
    case 'error':
    case 'run_unavailable':
      return { ...event, message: redactSecrets(event.message) };
    case 'run_finished':
      return event.error === undefined ? event : { ...event, error: redactSecrets(event.error) };
    default:
      return event;
  }
}

/** 仅从内部原记录投影一次；绝不能用于已经公开的 question_updated 或 SDK 输入。 */
export function publicRunQuestion(question: RunQuestion): PublicRunQuestion {
  return {
    ...question,
    questions: question.questions.map((item) => ({
      ...item,
      question: redactSecrets(item.question),
      header: redactSecrets(item.header),
      options: item.options.map((option, index) => ({
        value: String(index),
        label: redactSecrets(option.label),
        description: redactSecrets(option.description),
      })),
    })),
    answers:
      question.answers === null
        ? null
        : Object.fromEntries(
            question.questions.map((item, index) => [
              String(index),
              redactSecrets(question.answers?.[item.question] ?? ''),
            ]),
          ),
    closeReason: question.closeReason === null ? null : redactSecrets(question.closeReason),
  };
}
