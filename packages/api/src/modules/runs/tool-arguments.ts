const SENSITIVE_KEY =
  /token|secret|password|passwd|passphrase|pwd|credentials?|authorization|cookie|signature|dsn|connection[-_]?string|api[-_]?key|access[-_]?key|private[-_]?key|(?<![a-z0-9])auth(?![a-z0-9])|(?<![a-z0-9])key(?![a-z0-9])/i;
const CREDENTIAL_VALUE =
  /\bbearer\s+\S+|(?<![a-z0-9])sk-[a-z0-9_-]+|(?<![a-z0-9])gh[pousr]_[a-z0-9_]+|(?<![a-z0-9])akia[0-9a-z]{16}(?![a-z0-9])|[a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@]+:[^/\s@]+@|-----BEGIN[^-]{0,64}PRIVATE KEY-----|(?<![a-z0-9])xox[abpsr]-[a-z0-9-]+|(?<![a-z0-9])eyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/i;
const MAX_SCAN = 4096;
const REDACTED = '[已脱敏]';
const OMITTED = '[已省略]';
const MAX_DEPTH = 3;
const MAX_ITEMS = 8;
const MAX_STRING = 200;
const MAX_JSON = 2048;
const RESERVE = 24;

interface Budget {
  remaining: number;
  stopped: boolean;
}

function take(budget: Budget, size: number): boolean {
  if (budget.stopped) return false;
  if (budget.remaining - size < RESERVE) {
    budget.stopped = true;
    return false;
  }
  budget.remaining -= size;
  return true;
}

function summarizeValue(value: unknown, depth: number, budget: Budget): unknown {
  if (typeof value === 'string') {
    if (CREDENTIAL_VALUE.test(value.length > MAX_SCAN ? value.slice(0, MAX_SCAN) : value)) {
      if (!take(budget, JSON.stringify(REDACTED).length + 1)) return OMITTED;
      return REDACTED;
    }
    const text = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    if (!take(budget, JSON.stringify(text).length + 1)) return OMITTED;
    return text;
  }
  if (typeof value === 'number') {
    const normalized = Number.isFinite(value) ? value : null;
    if (!take(budget, String(normalized).length + 1)) return OMITTED;
    return normalized;
  }
  if (typeof value === 'boolean' || value === null) {
    if (!take(budget, String(value).length + 1)) return OMITTED;
    return value;
  }
  if (typeof value !== 'object') return null;
  if (Array.isArray(value)) return summarizeArray(value, depth, budget);
  return summarizeRecord(value as Record<string, unknown>, depth, budget);
}

function summarizeArray(value: unknown[], depth: number, budget: Budget): unknown[] {
  if (depth > MAX_DEPTH) {
    if (!take(budget, JSON.stringify(OMITTED).length + 2)) return [];
    return [OMITTED];
  }
  const out: unknown[] = [];
  const limit = Math.min(value.length, MAX_ITEMS);
  let count = 0;
  for (let index = 0; index < limit; index += 1) {
    if (!take(budget, 2)) break;
    out.push(summarizeValue(value[index], depth + 1, budget));
    count += 1;
  }
  if (count < value.length) {
    const marker = budget.stopped ? OMITTED : `[还有 ${value.length - count} 项]`;
    if (take(budget, JSON.stringify(marker).length + 2)) out.push(marker);
  }
  return out;
}

function summarizeRecord(
  value: Record<string, unknown>,
  depth: number,
  budget: Budget,
): Record<string, unknown> {
  if (depth > MAX_DEPTH) {
    if (!take(budget, '…'.length + 6 + JSON.stringify(OMITTED).length)) return {};
    return { '…': OMITTED };
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  let count = 0;
  for (const [key, item] of entries) {
    if (count >= MAX_ITEMS || !take(budget, key.length + 6)) break;
    if (SENSITIVE_KEY.test(key)) {
      take(budget, REDACTED.length + 2);
      out[key] = REDACTED;
    } else {
      out[key] = summarizeValue(item, depth + 1, budget);
    }
    count += 1;
  }
  if (count < entries.length) {
    const marker = budget.stopped ? OMITTED : `[还有 ${entries.length - count} 项]`;
    if (take(budget, '…'.length + 6 + JSON.stringify(marker).length)) out['…'] = marker;
  }
  return out;
}

export function summarizeToolArguments(
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  if (Object.keys(args).length === 0) return null;
  const budget: Budget = { remaining: MAX_JSON, stopped: false };
  return summarizeRecord(args, 1, budget);
}
