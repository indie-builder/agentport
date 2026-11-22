import { rm } from 'node:fs/promises';
import type { Options, SDKMessage, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import { sdkEnv } from './upstream.js';

type HermeticQueryOverrides = Pick<
  Options,
  | 'model'
  | 'env'
  | 'mcpServers'
  | 'allowedTools'
  | 'maxTurns'
  | 'maxBudgetUsd'
  | 'abortController'
  | 'outputFormat'
>;

export function hermeticQueryOptions({
  cwd,
  anthropicBaseUrl,
  ...overrides
}: { cwd: string; anthropicBaseUrl: string | undefined } & HermeticQueryOverrides): Options {
  return {
    cwd,
    env: sdkEnv(cwd, anthropicBaseUrl),
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    settings: { autoMemoryEnabled: false },
    permissionMode: 'dontAsk',
    persistSession: false,
    ...overrides,
  };
}

export type OneShotSdkOutcome =
  | { status: 'aborted' }
  | { status: 'no_result' }
  | { status: 'failure'; message: string }
  | { status: 'success' };

export const ONE_SHOT_NO_RESULT_MESSAGE = 'SDK 没有返回结果';
export const ONE_SHOT_NO_STRUCTURED_OUTPUT_MESSAGE = '模型没有返回结构化结果';

export async function runOneShotSdkQuery(opts: {
  signal: AbortSignal;
  cwd: string;
  create: (controller: AbortController) => AsyncGenerator<SDKMessage, void>;
  onSuccessFrame?: (message: SDKResultSuccess) => void;
}): Promise<OneShotSdkOutcome> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal.addEventListener('abort', onAbort, { once: true });
  if (opts.signal.aborted) controller.abort();
  let messages: AsyncGenerator<SDKMessage, void> | undefined;

  try {
    messages = opts.create(controller);
    let failure: string | null = null;
    let sawResult = false;
    for await (const message of messages) {
      if (message.type !== 'result') continue;
      sawResult = true;
      if (message.subtype !== 'success') {
        failure = [message.subtype, ...message.errors].filter(Boolean).join(': ');
      } else if (message.is_error) {
        failure = `success: ${message.result}`;
      } else {
        opts.onSuccessFrame?.(message);
      }
    }
    if (opts.signal.aborted || controller.signal.aborted) return { status: 'aborted' };
    if (!sawResult) return { status: 'no_result' };
    if (failure !== null) return { status: 'failure', message: failure };
    return { status: 'success' };
  } catch (err) {
    if (opts.signal.aborted || controller.signal.aborted) return { status: 'aborted' };
    throw err;
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    // 先停 CLI 再删目录：只 abort 时 CLI 退出较慢，会在删除后重建 projects/*.jsonl。
    // 官方 Query.return() 才会 await cleanup（关 transport、等子进程退出）；close() 是同步不等。
    controller.abort();
    await messages?.return(undefined).catch(() => undefined);
    await rm(opts.cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
