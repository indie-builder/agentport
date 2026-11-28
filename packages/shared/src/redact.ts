import type { ChatEvent } from './chat.js';
import type { PublicRunQuestion, RunQuestion } from './questions.js';

function mask(secret: string): string {
  return secret.length > 4 ? `${secret.slice(0, 4)}***` : '***';
}

export const BEARER_TOKEN_PATTERN = /(\bBearer\s+)(?=[A-Za-z0-9._~+/=-]{8})([A-Za-z0-9._~+/=-]+)/gi;
export const PROVIDER_KEY_PATTERNS = [
  /\bsk-(?=[A-Za-z0-9_-]{10})[A-Za-z0-9_-]+/g,
  /\bghp_(?=[A-Za-z0-9_-]{16})[A-Za-z0-9_-]+/g,
] as const;
export const SECRET_PATTERNS = {
  bearer: BEARER_TOKEN_PATTERN,
  providerKeys: PROVIDER_KEY_PATTERNS,
} as const;

const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]*)=("[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi;
const BASE64URL = /[A-Za-z0-9_-]+/g;

function looksRandom(token: string): boolean {
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token);
}

export function redactSecrets(text: string): string {
  const withBearer = text.replace(
    BEARER_TOKEN_PATTERN,
    (_match, prefix: string, token: string) => `${prefix}${mask(token)}`,
  );
  const withProviderKeys = PROVIDER_KEY_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, mask),
    withBearer,
  );
  return withProviderKeys
    .replace(ASSIGNMENT, (_match, key: string, value: string) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
      const body = quote ? value.slice(1, -1) : value;
      return `${key}=${quote}${mask(body)}${quote}`;
    })
    .replace(BASE64URL, (match) =>
      match.length >= 32 && looksRandom(match) ? mask(match) : match,
    );
}

export function redactJson(json: string): string {
  try {
    return JSON.stringify(redactJsonValue(JSON.parse(json)));
  } catch {
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
    case 'run_warning':
    case 'run_unavailable':
      return { ...event, message: redactSecrets(event.message) };
    case 'run_finished':
      return event.error === undefined ? event : { ...event, error: redactSecrets(event.error) };
    default:
      return event;
  }
}

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
