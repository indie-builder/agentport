/**
 * 极简 5 段 cron 解析（分 时 日 月 周，UTC），只覆盖平台定时任务需要的子集：
 * `*`、数字、范围 `a-b`、列表 `a,b,c`、步长 `* /n` 与 `a-b/n`。不引入第三方库。
 * 周字段 0 与 7 都表示周日。不支持 L/W/# 等扩展语法，遇到就抛错。
 */

interface Field {
  min: number;
  max: number;
}

const FIELDS: Field[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week
];

function parseField(raw: string, field: Field): Set<number> {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const [rangeRaw, stepPart] = part.split('/');
    const rangePart = rangeRaw ?? '';
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`非法步长: ${part}`);
    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = field.min;
      end = field.max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(rangePart);
      end = stepPart === undefined ? start : field.max;
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < field.min ||
      end > field.max ||
      start > end
    ) {
      throw new Error(`非法 cron 段: ${part}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}
interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
}

export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 需要 5 段：分 时 日 月 周');
  const [minutes, hours, days, months, weekdaysRaw] = parts.map((raw, i) =>
    parseField(raw, FIELDS[i]!),
  );
  const weekdays = weekdaysRaw!;
  // 周日既可能是 0 也可能是 7，统一归一到 0。
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return { minutes: minutes!, hours: hours!, days: days!, months: months!, weekdays };
}

/** 从 `from` 之后（不含）开始找下一次触发时间；一年内找不到则视为不可调度。 */
export function nextCronRun(expression: string, from: Date = new Date()): Date {
  const cron = parseCron(expression);
  const cursor = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const limit = from.getTime() + 366 * 24 * 60 * 60_000;
  while (cursor.getTime() <= limit) {
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    const weekday = cursor.getUTCDay();
    const hour = cursor.getUTCHours();
    const minute = cursor.getUTCMinutes();
    const dayOk = cron.days.has(day) && cron.months.has(month) && cron.weekdays.has(weekday);
    if (dayOk && cron.hours.has(hour) && cron.minutes.has(minute)) return cursor;
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error('cron 在一年内没有可触发时间');
}
