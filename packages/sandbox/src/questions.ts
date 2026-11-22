import {
  errorText,
  type NativeQuestion,
  nativeQuestionInputSchema,
  type SandboxInputCommand,
  sandboxInputCommandSchema,
} from '@agentport/shared';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

interface QuestionChannelEvents {
  requested(event: { requestId: string; toolUseId: string; questions: NativeQuestion[] }): void;
  closed(requestId: string): void;
}

interface QuestionChannel {
  canUseTool: CanUseTool;
  close(): void;
}

interface PendingQuestion {
  rawQuestions: unknown;
  questions: NativeQuestion[];
  resolve(result: PermissionResult): void;
  signal: AbortSignal;
  onAbort: () => void;
}

const DENY_OTHER = '本次运行只允许通过原生提问向用户澄清；其他工具调用必须先获得授权。';
const DENY_SUBAGENT = '子智能体不能向用户提问。';
const DENY_CLOSED = '运行已结束，问题已关闭。';
const DENY_DECLINED = '用户暂不回答这个问题。';
const DENY_MISMATCH = '回答与问题不匹配，问题已关闭。';
const DENY_ABORTED = '运行已取消，问题已关闭。';

export function createQuestionChannel(input: {
  readLine: () => Promise<string | null>;
  events: QuestionChannelEvents;
  log?: (message: string) => void;
  onUserMessage?: (command: { text: string; uuid: string }) => void;
}): QuestionChannel {
  const pending = new Map<string, PendingQuestion>();
  let stopped = false;
  const log = input.log ?? (() => undefined);

  const settle = (
    requestId: string,
    result: PermissionResult,
    notify: { closed: boolean },
  ): boolean => {
    const entry = pending.get(requestId);
    if (entry === undefined) return false;
    pending.delete(requestId);
    entry.signal.removeEventListener('abort', entry.onAbort);
    if (notify.closed) input.events.closed(requestId);
    entry.resolve(result);
    return true;
  };

  const denyAll = (message: string): void => {
    for (const requestId of [...pending.keys()]) {
      settle(requestId, { behavior: 'deny', message }, { closed: true });
    }
  };

  const close = (): void => {
    if (stopped) return;
    stopped = true;
    denyAll(DENY_CLOSED);
  };

  const respond = (command: Extract<SandboxInputCommand, { type: 'question_response' }>): void => {
    const entry = pending.get(command.requestId);
    if (entry === undefined) {
      log(`ignored a response for unknown or settled question ${command.requestId}`);
      return;
    }
    if ('decline' in command.response) {
      settle(command.requestId, { behavior: 'deny', message: DENY_DECLINED }, { closed: true });
      return;
    }
    const expected = new Set(entry.questions.map((question) => question.question));
    const keys = Object.keys(command.response.answers);
    if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
      log(`closed question ${command.requestId}: answers do not match its questions`);
      settle(command.requestId, { behavior: 'deny', message: DENY_MISMATCH }, { closed: true });
      return;
    }
    settle(
      command.requestId,
      {
        behavior: 'allow',
        updatedInput: { questions: entry.rawQuestions, answers: command.response.answers },
      },
      { closed: false },
    );
  };

  void (async () => {
    for (;;) {
      let line: string | null;
      try {
        line = await input.readLine();
      } catch (err) {
        log(`stdin command read failed: ${errorText(err)}`);
        line = null;
      }
      if (line === null) {
        close();
        return;
      }
      if (stopped) return;
      let command: SandboxInputCommand;
      try {
        command = sandboxInputCommandSchema.parse(JSON.parse(line));
      } catch {
        log('ignored a malformed stdin command');
        continue;
      }
      if (command.type === 'user_message') {
        if (input.onUserMessage === undefined) {
          log('ignored a user_message command: no instruction runtime attached');
        } else {
          input.onUserMessage({ text: command.text, uuid: command.uuid });
        }
        continue;
      }
      respond(command);
    }
  })();

  const canUseTool: CanUseTool = (toolName, toolInput, options) => {
    if (toolName !== 'AskUserQuestion') {
      return Promise.resolve({ behavior: 'deny', message: DENY_OTHER });
    }
    // SDK 文档：子智能体不可用提问；这里再 fail closed，不依赖上游是否拦截。
    if (options.agentID !== undefined) {
      return Promise.resolve({ behavior: 'deny', message: DENY_SUBAGENT });
    }
    if (stopped) return Promise.resolve({ behavior: 'deny', message: DENY_CLOSED });

    const parsed = nativeQuestionInputSchema.safeParse(toolInput);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message ?? '提问参数不合法';
      return Promise.resolve({ behavior: 'deny', message: `无法向用户展示这个问题：${issue}` });
    }
    if (pending.has(options.requestId)) {
      return Promise.resolve({ behavior: 'deny', message: '重复的提问请求。' });
    }

    return new Promise<PermissionResult>((resolve) => {
      const onAbort = (): void => {
        settle(options.requestId, { behavior: 'deny', message: DENY_ABORTED }, { closed: true });
      };
      pending.set(options.requestId, {
        rawQuestions: (toolInput as { questions: unknown }).questions,
        questions: parsed.data.questions,
        resolve,
        signal: options.signal,
        onAbort,
      });
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
      input.events.requested({
        requestId: options.requestId,
        toolUseId: options.toolUseID,
        questions: parsed.data.questions,
      });
    });
  };

  return { canUseTool, close };
}
