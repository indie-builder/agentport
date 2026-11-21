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

function spawnDescendant() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'inherit',
    detached: detachStdio,
  });
  process.stderr.write(`desc-pid:${child.pid}\n`);
}

let lateTimer;
if (hang) {
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
  await write({ type: 'assistant_text', text: '"'.repeat(9 * 1024 * 1024) });
}

if (hang) {
  lateTimer = setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ type: 'text_delta', text: 'late' })}\n`);
  }, 400);
  for await (const line of lines) {
    await write({ type: 'text_delta', text: `input:${line}` });
  }
  process.exit(0);
}

if (task.prompt.includes('linger')) {
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await write({ type: 'run_finished', status: 'succeeded', sessionId: `session-${task.prompt}` });
  process.exit(0);
}

if (task.prompt.includes('stubborn')) {
  const grandchild = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: 'ignore' },
  );
  process.stderr.write(`grandchild-pid:${grandchild.pid}\n`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await write({ type: 'run_finished', status: 'succeeded', sessionId: `session-${task.prompt}` });
  process.exit(0);
}

await write({ type: 'run_finished', status: 'succeeded', sessionId: `session-${task.prompt}` });
process.exit(0);
