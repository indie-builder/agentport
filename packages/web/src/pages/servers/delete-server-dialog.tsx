import type { Server } from '@agentport/shared';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { RequiredMark } from '../../components/required-mark.js';
import { Field, FieldDescription, FieldLabel } from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import { useAgents, useDeleteServer, useTools } from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';

export function DeleteServerDialog({
  server,
  onClose,
  getReturnFocus,
}: {
  server: Server;
  onClose: () => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const remove = useDeleteServer();
  const agents = useAgents();
  const tools = useTools(server.kind === 'generated' ? server.id : null);
  const [typed, setTyped] = useState('');

  const bound = (agents.data ?? []).filter((agent) => (agent.serverIds ?? []).includes(server.id));
  const toolCount = tools.data?.length ?? 0;
  const loading = agents.isPending || (server.kind === 'generated' && tools.isPending);
  const unknown = agents.isError || (server.kind === 'generated' && tools.isError);
  const risky = bound.length > 0 || toolCount > 0;
  const confirmed = !risky || typed.trim() === server.name;

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      finalFocus={getReturnFocus}
      title={`删除 server「${server.name}」`}
      description="删除后无法恢复；绑定它的智能体会立即失去这个工具来源。"
      confirmLabel="删除"
      confirmDisabled={loading || unknown || !confirmed}
      onConfirm={async () => {
        await remove.mutateAsync(server.id);
        toastSuccess('Server 已删除');
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-item bg-danger-soft p-3">
          <p className="text-xs text-danger">影响范围</p>
          {loading ? (
            <p className="mt-1 text-sm text-muted-foreground">正在读取绑定关系…</p>
          ) : unknown ? (
            <p className="mt-1 text-sm text-danger">
              读取不到完整的绑定关系，暂时无法安全删除。请刷新后重试，或先到智能体页确认。
            </p>
          ) : (
            <>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm text-fg">
                <li>
                  工具 <span className="font-mono tabular-nums">{toolCount}</span> 个
                  {toolCount > 0 ? '，会一并删除' : ''}
                </li>
                <li>
                  智能体 <span className="font-mono tabular-nums">{bound.length}</span> 个
                  {bound.length > 0 ? '，会失去这些工具' : ''}
                </li>
              </ul>
              {bound.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-0.5 border-t border-line pt-2 text-sm text-fg">
                  {bound.map((agent) => (
                    <li key={agent.id}>· {agent.name}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>

        {bound.length > 0 ? (
          <Link
            to="/agents"
            className="inline-block self-start text-xs font-medium text-fg underline decoration-line-strong underline-offset-2"
          >
            先去解绑
          </Link>
        ) : null}

        {risky && !loading && !unknown ? (
          <Field className="gap-1.5">
            <FieldLabel htmlFor="delete-server-confirm">
              输入 <span className="font-mono">{server.name}</span> 以确认
              <RequiredMark />
            </FieldLabel>
            <Input
              id="delete-server-confirm"
              value={typed}
              autoComplete="off"
              aria-required
              aria-describedby="delete-server-confirm-hint"
              onChange={(event) => setTyped(event.target.value)}
            />
            <FieldDescription id="delete-server-confirm-hint">
              名称必须完全一致；误删后绑定的智能体不会自动恢复。
            </FieldDescription>
          </Field>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
