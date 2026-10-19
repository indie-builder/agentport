import { type ChatEvent, chatEventSchema } from '@agentport/shared';
import { Bot, ChevronDown, CircleStop, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '../components/page.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Select } from '../components/ui/select.js';
import { Textarea } from '../components/ui/textarea.js';
import { api, errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { useAgents } from '../lib/queries.js';

type ToolItem = {
  kind: 'tool';
  toolUseId: string;
  name: string;
  input?: string;
  result?: string;
};

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | ToolItem
  | { kind: 'notice'; text: string; tone: 'ok' | 'error' | 'muted' };

function applyEvent(items: Item[], event: ChatEvent): Item[] {
  switch (event.type) {
    case 'text_delta': {
      const last = items[items.length - 1];
      if (last?.kind === 'text') {
        return [...items.slice(0, -1), { kind: 'text', text: last.text + event.text }];
      }
      return [...items, { kind: 'text', text: event.text }];
    }
    case 'tool_start':
      return [...items, { kind: 'tool', toolUseId: event.toolUseId, name: event.name }];
    case 'tool_input':
      return items.map((item) =>
        item.kind === 'tool' && item.toolUseId === event.toolUseId
          ? { ...item, input: event.json }
          : item,
      );
    case 'tool_result':
      return items.map((item) =>
        item.kind === 'tool' && item.toolUseId === event.toolUseId
          ? { ...item, result: event.content }
          : item,
      );
    case 'run_finished': {
      const parts: string[] = [event.status];
      if (event.turns !== undefined) parts.push(`${event.turns} turns`);
      if (event.costUsd !== undefined) parts.push(`$${event.costUsd.toFixed(4)}`);
      if (event.error) parts.push(event.error);
      return [
        ...items,
        {
          kind: 'notice',
          tone:
            event.status === 'succeeded' ? 'ok' : event.status === 'cancelled' ? 'muted' : 'error',
          text: parts.join(' · '),
        },
      ];
    }
    case 'error':
      return [...items, { kind: 'notice', tone: 'error', text: event.message }];
    case 'run_started':
      return items;
  }
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export function ChatPage() {
  const agents = useAgents();
  const [agentId, setAgentId] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const agent = agents.data?.find((a) => a.id === agentId) ?? null;

  // 卸载时断开流；切换 agent 由 switchAgent 负责，避免把旧事件写进新会话。
  useEffect(() => {
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  });

  const switchAgent = (id: string) => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setAgentId(id);
    setItems([]);
    setRunId(null);
    setConversationId(null);
  };

  const openStream = (newRunId: string) => {
    sourceRef.current?.close();
    const source = new EventSource(`/api/chat/${newRunId}/events`);
    sourceRef.current = source;
    let finished = false;

    source.onmessage = (message) => {
      let raw: unknown;
      try {
        raw = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = chatEventSchema.safeParse(raw);
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.type === 'run_started') setConversationId(event.conversationId);
      setItems((prev) => applyEvent(prev, event));
      if (event.type === 'run_finished' || event.type === 'error') {
        finished = true;
        source.close();
        sourceRef.current = null;
        setRunId(null);
      }
    };
    source.onerror = () => {
      // 服务端在 run_finished 后主动结束流；此后任何重连都是无意义的。
      if (finished || sourceRef.current !== source) return;
      source.close();
      sourceRef.current = null;
      setRunId(null);
      setItems((prev) => [...prev, { kind: 'notice', tone: 'error', text: '事件流已断开' }]);
    };
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !agent || sending) return;
    setSending(true);
    setItems((prev) => [...prev, { kind: 'user', text }]);
    setInput('');
    try {
      const accepted = await api.sendChat({
        agentId: agent.id,
        message: text,
        ...(conversationId ? { conversationId } : {}),
      });
      setConversationId(accepted.conversationId);
      setRunId(accepted.runId);
      openStream(accepted.runId);
    } catch (error) {
      toast.error(errorMessage(error));
      setItems((prev) => [...prev, { kind: 'notice', tone: 'error', text: errorMessage(error) }]);
    } finally {
      setSending(false);
    }
  };

  const cancel = () => {
    if (!runId) return;
    api.cancelRun(runId).catch((error) => toast.error(errorMessage(error)));
  };

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      <PageHeader
        title="Chat"
        description="选择 agent，消息与工具调用会实时流式返回"
        actions={
          <div className="w-56">
            <Select
              aria-label="选择 agent"
              value={agentId}
              onChange={(e) => switchAgent(e.target.value)}
            >
              <option value="">选择 agent…</option>
              {agents.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
        }
      />

      {agents.isPending ? <LoadingState rows={3} /> : null}
      {agents.isError ? (
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
      ) : null}
      {agents.data && agents.data.length === 0 ? (
        <EmptyState
          title="还没有 agent"
          description="先在 Agents 页面创建一个 agent，并给它绑定 MCP Server。"
        />
      ) : null}

      {agents.data && agents.data.length > 0 ? (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
            {!agent ? (
              <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                先选择一个 agent。
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <Bot className="size-6 text-zinc-600" />
                <div className="text-sm text-zinc-300">{agent.name}</div>
                <div className="max-w-sm text-xs text-zinc-500">
                  {agent.systemPrompt || '该 agent 没有 system prompt。'}
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-3xl space-y-3">
                {items.map((item, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 消息是只追加的流式日志，顺序即身份
                  <ItemView key={i} item={item} />
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          <form
            className="mt-3 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Textarea
              aria-label="消息"
              rows={2}
              placeholder={agent ? 'Enter 发送，Shift+Enter 换行' : '先选择 agent'}
              disabled={!agent}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {runId ? (
              <Button variant="outline" onClick={cancel}>
                <CircleStop className="size-4" /> 停止
              </Button>
            ) : (
              <Button type="submit" disabled={!agent || !input.trim() || sending}>
                <Send className="size-4" /> 发送
              </Button>
            )}
          </form>
        </>
      ) : null}
    </div>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100">
            {item.text}
          </div>
        </div>
      );
    case 'text':
      return (
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">{item.text}</div>
      );
    case 'tool':
      return <ToolView item={item} />;
    case 'notice':
      return (
        <div
          className={cn(
            'text-xs',
            item.tone === 'ok'
              ? 'text-emerald-400'
              : item.tone === 'error'
                ? 'text-red-400'
                : 'text-zinc-500',
          )}
        >
          {item.text}
        </div>
      );
  }
}

function ToolView({ item }: { item: ToolItem }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 text-xs">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Badge variant="accent">tool</Badge>
        <code className="text-zinc-200">{item.name}</code>
        {item.result !== undefined ? (
          <span className="ml-auto text-[11px] text-emerald-500/80">done</span>
        ) : (
          <span className="ml-auto text-[11px] text-amber-500/80">running</span>
        )}
      </div>
      {item.input !== undefined ? (
        <details className="border-t border-zinc-800">
          <summary className="flex cursor-pointer list-none items-center gap-1 px-2.5 py-1.5 text-zinc-500 hover:text-zinc-300">
            <ChevronDown className="size-3" /> 输入
          </summary>
          <pre className="max-h-64 overflow-auto border-t border-zinc-800/70 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-300">
            {pretty(item.input)}
          </pre>
        </details>
      ) : null}
      {item.result !== undefined ? (
        <details className="border-t border-zinc-800">
          <summary className="flex cursor-pointer list-none items-center gap-1 px-2.5 py-1.5 text-zinc-500 hover:text-zinc-300">
            <ChevronDown className="size-3" /> 结果
          </summary>
          <pre className="max-h-64 overflow-auto border-t border-zinc-800/70 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-300">
            {pretty(item.result)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
