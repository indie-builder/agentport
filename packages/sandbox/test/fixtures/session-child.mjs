// Minimal stand-in for dist/runner.js in session-supervisor tests.
// It reads one task line, emits ChatEvents on stdout, and keeps stdin open
// for forwarded question_response commands, like the real runner.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
const first = await lines.next();
const task = JSON.parse(first.value);
const marker = process.env.RUN_MARKER ?? '';
const hang = task.prompt.includes('hang');
const inheritStdio = task.prompt.includes('inherit-stdio');
const detachStdio = task.prompt.includes('detach-stdio');

function write(event) {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(event)}\n`, resolve);
  });
}

// 长驻后代继承 root 的 stdout/stderr：root 退出后管道仍开着，只有后代被杀才会 close。
function spawnDescendant() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'inherit',
    detached: detachStdio,
  });
  process.stderr.write(`desc-pid:${child.pid}\n`);
}

let lateTimer;
if (hang) {
  // Install before the first event so a cancel cannot race the default SIGTERM action.
  process.on('SIGTERM', () => {
    clearTimeout(lateTimer);
    process.stdout.write(
      `${JSON.stringify({
        type: 'run_finished',
        status: 'cancelled',
        sessionId: `session-${task.prompt}`,
      })}\n`,
      () => process.exit(0),
    );
  });
}

await write({ type: 'text_delta', text: `run:${task.prompt}:${marker}` });

if (inheritStdio || detachStdio) spawnDescendant();

if (task.prompt.includes('bloat')) {
  // JSON 转义后约 18MiB，超过 supervisor 的 8MiB 单行上限；之后的成功事件不得被采纳。
  await write({ type: 'assistant_text', text: '"'.repeat(9 * 1024 * 1024) });
}

if (hang) {
  // A cancelled runner must not deliver this late write.
  lateTimer = setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ type: 'text_delta', text: 'late' })}\n`);
  }, 400);
  for await (const line of lines) {
    await write({ type: 'text_delta', text: `input:${line}` });
  }
  process.exit(0);
}

if (task.prompt.includes('linger')) {
  // Stays in this process group after the fixture exits; the supervisor must stop it.
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await write({ type: 'run_finished', status: 'succeeded', sessionId: `session-${task.prompt}` });
  process.exit(0);
}

if (task.prompt.includes('stubborn')) {
  // Ignores SIGTERM so the supervisor cannot confirm the group stopped.
  const grandchild = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: 'ignore' },
  );
  process.stderr.write(`grandchild-pid:${grandchild.pid}\n`);
  // 等孙进程真正装上 SIGTERM handler，避免和 supervisor 的清理信号赛跑。
  await new Promise((resolve) => setTimeout(resolve, 300));
  await write({ type: 'run_finished', status: 'succeeded', sessionId: `session-${task.prompt}` });
  process.exit(0);
}

await write({ type: 'run_finished', status: 'succeeded', sessionId: `session-${task.prompt}` });
process.exit(0);
