import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const SCRATCH = '/tmp/session-fixture';
const PROGRESS = `${SCRATCH}/progress`;
const CANCELLED = `${SCRATCH}/cancelled`;
const PERSIST = '/home/node/.claude/session-fixture.json';
const ORPHAN_PROGRESS = `${SCRATCH}/orphan-progress`;
const ORPHAN_STOP = `${SCRATCH}/orphan-stop.json`;
const GROUP_PROGRESS = `${SCRATCH}/group-progress`;
const GROUP_STOP = `${SCRATCH}/group-stop.json`;
const ORPHAN_META = `${SCRATCH}/orphan.json`;
const BUSY_PROGRESS = '/mnt/outputs/session-busy-progress';
const BUSY_PROGRESS_TMP = `${BUSY_PROGRESS}.tmp`;
const LONG = 'fixture:long';
const ORPHAN = 'fixture:orphan';
const BUSY = 'fixture:busy';

mkdirSync(SCRATCH, { recursive: true });

function emit(event, flushed) {
  const line = `${JSON.stringify(event)}\n`;
  if (flushed === undefined) process.stdout.write(line);
  else process.stdout.write(line, flushed);
}

function safeTag(prompt) {
  const tag = prompt.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 96);
  return tag === '' ? 'empty' : tag;
}

function writePersist(state) {
  try {
    writeFileSync(PERSIST, JSON.stringify(state));
  } catch (error) {
    process.stderr.write(`[fixture] persist failed: ${error.message}\n`);
  }
}

function nextCount() {
  try {
    return Number(readFileSync(`${SCRATCH}/count`, 'utf8')) + 1;
  } catch {
    return 1;
  }
}

/** 直接读 /proc 的 ppid：runner 退出后，残留子进程应回挂到容器 PID1。 */
function procPpid() {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return process.ppid;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      readFileSync(path);
      return true;
    } catch {
      sleepSync(5);
    }
  }
  return false;
}

/**
 * 子进程只做两件事：周期写心跳，收到 SIGTERM 时把 /proc 里当时的 ppid 记下来再退出。
 * ppid=1 是「runner 已退出并回挂 PID1」的真实证据；stdout/stderr 故意继承 runner 的管道，
 * 让 runner 显式 exit 后管道仍被后代占着，复现「等 close 就与后代互等」的场景。
 */
function heartbeatScript(progress, stop) {
  return `
const { readFileSync, writeFileSync } = require('node:fs');
const progress = ${JSON.stringify(progress)};
const stop = ${JSON.stringify(stop)};
function ppid() {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return process.ppid;
  }
}
let tick = 0;
function beat() {
  tick += 1;
  writeFileSync(progress, JSON.stringify({ pid: process.pid, ppid: ppid(), tick, at: Date.now() }));
}
process.once('SIGTERM', () => {
  try {
    writeFileSync(stop, JSON.stringify({ pid: process.pid, ppid: ppid(), tick, at: Date.now() }));
  } catch {}
  process.exit(0);
});
beat();
setInterval(beat, 15);
`;
}

function startBusy() {
  let tick = 0;
  const beat = () => {
    tick += 1;
    try {
      // 宿主同时读该文件；先写同目录临时文件再 rename，避免读到截断的半截 JSON。
      writeFileSync(
        BUSY_PROGRESS_TMP,
        JSON.stringify({ pid: process.pid, ppid: procPpid(), tick, at: Date.now() }),
      );
      renameSync(BUSY_PROGRESS_TMP, BUSY_PROGRESS);
    } catch (error) {
      process.stderr.write(`[fixture] busy output failed: ${error.message}\n`);
    }
  };
  beat();
  progressTimer = setInterval(beat, 15);
}

/**
 * 先让两个子进程各写一次，runner 再退出：detached 一个另开会话，另一个留在原进程组。
 * 两者都继承 stdout/stderr（stdin 忽略），runner 退出后仍占着管道；收尾必须从 exit 开始。
 */
function startOrphans(tag) {
  const detached = spawn(process.execPath, ['-e', heartbeatScript(ORPHAN_PROGRESS, ORPHAN_STOP)], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  detached.unref();
  const grouped = spawn(process.execPath, ['-e', heartbeatScript(GROUP_PROGRESS, GROUP_STOP)], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  grouped.unref();
  const ready =
    waitForFile(ORPHAN_PROGRESS, 5_000) && waitForFile(GROUP_PROGRESS, 5_000);
  writeFileSync(
    ORPHAN_META,
    JSON.stringify({
      rootPid: process.pid,
      detachedPid: detached.pid,
      groupPid: grouped.pid,
      ready,
      at: Date.now(),
    }),
  );
  finished = true;
  emit(
    {
      type: 'run_finished',
      status: 'succeeded',
      sessionId: `fixture-${tag}`,
      costUsd: 0,
      turns: 1,
    },
    () => process.exit(0),
  );
}

let task = null;
let progressTimer = null;
let finished = false;

function start(input) {
  const prompt = String(input.prompt ?? '');
  const tag = safeTag(prompt);
  const count = nextCount();
  const state = { prompt, pid: process.pid, count, at: Date.now() };
  writeFileSync(`${SCRATCH}/count`, String(count));
  writeFileSync(`${SCRATCH}/run-${tag}.json`, JSON.stringify(state));
  appendFileSync(`${SCRATCH}/events.log`, `${JSON.stringify({ event: 'start', ...state })}\n`);
  writePersist(state);

  emit({
    type: 'assistant_text',
    text: `fixture:${prompt}`,
    sdkUuid: `fixture-${tag}`,
    blockIndex: 0,
    streamBlockId: `fixture-${tag}`,
  });

  if (prompt.includes(LONG)) {
    let tick = 0;
    progressTimer = setInterval(() => {
      tick += 1;
      writeFileSync(PROGRESS, JSON.stringify({ pid: process.pid, tick, at: Date.now() }));
    }, 15);
    return;
  }

  if (prompt.includes(ORPHAN)) {
    startOrphans(tag);
    return;
  }

  if (prompt.includes(BUSY)) {
    startBusy();
    return;
  }

  finished = true;
  emit(
    {
      type: 'run_finished',
      status: 'succeeded',
      sessionId: `fixture-${tag}`,
      costUsd: 0,
      turns: 1,
    },
    () => process.exit(0),
  );
}

function shutdown(reason) {
  if (finished) return;
  finished = true;
  if (progressTimer !== null) clearInterval(progressTimer);
  try {
    writeFileSync(CANCELLED, JSON.stringify({ reason, at: Date.now() }));
  } catch {
  }
  emit({ type: 'run_finished', status: 'cancelled', failureKind: 'cancelled' }, () =>
    process.exit(0),
  );
  setTimeout(() => process.exit(0), 250).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (raw === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed.type === 'cancel' || parsed.type === 'run_cancel' || parsed.type === 'stop') {
      shutdown('command');
      continue;
    }
    if (task === null) {
      task = parsed.task ?? parsed;
      start(task);
    }
  }
});
