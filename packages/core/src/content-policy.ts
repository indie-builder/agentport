import { createHash } from 'node:crypto';
import type { ContentPolicy, ContentPolicyDirection } from '@agentport/shared';

type ContentPolicyRule = Pick<
  ContentPolicy,
  | 'id'
  | 'name'
  | 'version'
  | 'direction'
  | 'action'
  | 'matchType'
  | 'pattern'
  | 'caseSensitive'
  | 'agentId'
  | 'priority'
  | 'enabled'
>;

export type ContentPolicyDecision = {
  action: 'allow' | 'redact' | 'block' | 'require_approval';
  text: string;
  policy: ContentPolicyRule | null;
  matchDigest: string | null;
  snippet: string;
};

interface Span {
  start: number;
  end: number;
  replacement: string;
}

const ACTION_RANK = { allow: 0, redact: 1, require_approval: 2, block: 3 } as const;
const SNIPPET_LENGTH = 160;

const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: 'Bearer ***' },
  { pattern: /\bsk-[A-Za-z0-9_-]{10,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bghp_[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED]' },
];

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})?/g;

const PII_PATTERNS: ReadonlyArray<RegExp> = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  /(?<!\d)\d{17}[\dXx](?!\d)/g,
  /(?<!\d)\d{16,19}(?!\d)/g,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternSpans(pattern: RegExp, text: string, replacement: string): Span[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].flatMap((match) =>
    match[0].length === 0 || match.index === undefined
      ? []
      : [{ start: match.index, end: match.index + match[0].length, replacement }],
  );
}

function policySpans(policy: ContentPolicyRule, text: string): Span[] {
  switch (policy.matchType) {
    case 'keyword': {
      if (policy.pattern.length === 0) return [];
      const flags = policy.caseSensitive ? 'g' : 'gi';
      return patternSpans(new RegExp(escapeRegExp(policy.pattern), flags), text, '[REDACTED]');
    }
    case 'regex':
      return patternSpans(
        new RegExp(policy.pattern, policy.caseSensitive ? 'g' : 'gi'),
        text,
        '[REDACTED]',
      );
    case 'secret':
      return SECRET_PATTERNS.flatMap(({ pattern, replacement }) =>
        patternSpans(pattern, text, replacement),
      );
    case 'pii': {
      const spans = PII_PATTERNS.flatMap((pattern) => patternSpans(pattern, text, '[REDACTED]'));
      for (const match of text.matchAll(EMAIL_PATTERN)) {
        if (match[1] !== undefined) {
          spans.push({
            start: match.index,
            end: match.index + match[0].length,
            replacement: '[REDACTED]',
          });
        }
      }
      return spans;
    }
  }
}

function applySpans(text: string, spans: Span[]): string {
  const merged: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      if (span.replacement !== 'Bearer ***') last.replacement = span.replacement;
    } else {
      merged.push({ ...span });
    }
  }
  let lastEnd = 0;
  const parts = merged.map(({ start, end, replacement }) => {
    const part = text.slice(lastEnd, start) + replacement;
    lastEnd = end;
    return part;
  });
  return parts.join('') + text.slice(lastEnd);
}

function digestOf(spans: Span[], text: string): string {
  const matched = spans.map((span) => text.slice(span.start, span.end)).sort();
  return createHash('sha256').update(matched.join('\n')).digest('hex').slice(0, 32);
}

type ProviderRoute = { id: string; baseUrl: string };

export function providerRouteDestination(provider: ProviderRoute): string {
  const digest = createHash('sha256').update(provider.baseUrl).digest('hex').slice(0, 16);
  return `provider:${provider.id}:${digest}`;
}

export function providerRouteMatches(destination: string, provider: ProviderRoute): boolean {
  return destination === providerRouteDestination(provider);
}

export function evaluateContentPolicy(input: {
  text: string;
  policies: ContentPolicyRule[];
  direction?: ContentPolicyDirection;
  agentId?: string | null;
}): ContentPolicyDecision {
  const matches = input.policies.flatMap((policy) => {
    if (!policy.enabled || (input.direction !== undefined && policy.direction !== input.direction))
      return [];
    if (policy.agentId !== null && policy.agentId !== input.agentId) return [];
    const spans = policySpans(policy, input.text);
    return spans.length === 0 ? [] : [{ policy, spans }];
  });
  if (matches.length === 0) {
    return {
      action: 'allow',
      text: input.text,
      policy: null,
      matchDigest: null,
      snippet: input.text.slice(0, SNIPPET_LENGTH),
    };
  }
  const strongest = matches.reduce((best, current) =>
    ACTION_RANK[current.policy.action] > ACTION_RANK[best.policy.action] ? current : best,
  );
  const allSpans = matches.flatMap((match) => match.spans);
  const redacted = applySpans(input.text, allSpans);
  const approvalSafe =
    strongest.policy.action === 'require_approval'
      ? applySpans(
          input.text,
          matches.flatMap((match) => (match.policy.action === 'redact' ? match.spans : [])),
        )
      : redacted;
  return {
    action: strongest.policy.action,
    text: approvalSafe,
    policy: strongest.policy,
    matchDigest: digestOf(allSpans, input.text),
    snippet: redacted.slice(0, SNIPPET_LENGTH),
  };
}
