import { useState } from 'react';
import { DialogShell } from '../../components/dialog-shell.js';
import { SearchInput } from '../../components/search-input.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Dialog } from '../../components/ui/dialog.js';
import {
  useAgentMembers,
  useDeleteAgentMember,
  useIdentities,
  useSetAgentMember,
  useTransferAgent,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useDebouncedValue } from '../../lib/use-debounced-value.js';

export function AgentMembersDialog({
  agentId,
  agentName,
  onClose,
}: {
  agentId: string;
  agentName: string;
  onClose: () => void;
}) {
  const members = useAgentMembers(agentId);
  const [query, setQuery] = useState('');
  const settled = useDebouncedValue(query.trim(), 300);
  const identities = useIdentities(agentId, { q: settled, limit: 20 });
  const setMember = useSetAgentMember();
  const removeMember = useDeleteAgentMember();
  const existing = new Set((members.data?.members ?? []).map((member) => member.businessId));

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogShell
        title={`管理「${agentName}」的成员`}
        description="成员可使用或维护该专家；范围仍由成员所属角色的授权决定。"
        className="max-w-xl sm:max-w-xl"
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">负责人</span>
            <span className="font-mono text-xs">{members.data?.ownerBusinessId ?? '—'}</span>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">成员</h3>
            {members.isPending ? <LoadingState rows={2} /> : null}
            {members.isError ? (
              <ErrorState error={members.error} onRetry={() => void members.refetch()} />
            ) : null}
            {members.data && members.data.members.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有成员。</p>
            ) : null}
            {(members.data?.members ?? []).map((member) => (
              <div
                key={member.businessId}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{member.name || member.businessId}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {member.businessId}
                    {member.accountActive ? '' : ' · 离线'}
                  </div>
                </div>
                <label
                  htmlFor={`agent-member-${member.businessId}-use`}
                  className="flex items-center gap-1.5"
                >
                  <Checkbox
                    id={`agent-member-${member.businessId}-use`}
                    checked={member.canUse}
                    disabled={setMember.isPending}
                    onCheckedChange={(checked) =>
                      setMember.mutate(
                        {
                          agentId,
                          businessId: member.businessId,
                          canUse: Boolean(checked),
                          canMaintain: member.canMaintain,
                        },
                        { onError: toastError },
                      )
                    }
                  />
                  可使用
                </label>
                <label
                  htmlFor={`agent-member-${member.businessId}-maintain`}
                  className="flex items-center gap-1.5"
                >
                  <Checkbox
                    id={`agent-member-${member.businessId}-maintain`}
                    checked={member.canMaintain}
                    disabled={setMember.isPending}
                    onCheckedChange={(checked) =>
                      setMember.mutate(
                        {
                          agentId,
                          businessId: member.businessId,
                          canUse: member.canUse,
                          canMaintain: Boolean(checked),
                        },
                        { onError: toastError },
                      )
                    }
                  />
                  可维护
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  disabled={removeMember.isPending}
                  aria-label={`移除成员 ${member.name || member.businessId}`}
                  onClick={() =>
                    removeMember.mutate(
                      { agentId, businessId: member.businessId },
                      { onError: toastError },
                    )
                  }
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2 border-t pt-4">
            <h3 className="text-sm font-medium">添加成员</h3>
            <SearchInput
              label="搜索可添加的人员"
              placeholder="搜索业务 ID 或姓名…"
              value={query}
              onChange={setQuery}
            />
            {identities.isPending && settled.length > 0 ? <LoadingState rows={2} /> : null}
            {identities.isError ? (
              <ErrorState error={identities.error} onRetry={() => void identities.refetch()} />
            ) : null}
            {(identities.data?.items ?? []).map((candidate) => (
              <div
                key={candidate.businessId}
                className="flex flex-wrap items-center gap-2 border-y py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{candidate.name || candidate.businessId}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {candidate.businessId}
                    {candidate.accountActive ? '' : ' · 离线'}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={existing.has(candidate.businessId) || setMember.isPending}
                  onClick={() =>
                    setMember.mutate(
                      {
                        agentId,
                        businessId: candidate.businessId,
                        canUse: true,
                        canMaintain: false,
                      },
                      {
                        onSuccess: () => toastSuccess(`已添加 ${candidate.name}`),
                        onError: toastError,
                      },
                    )
                  }
                >
                  {existing.has(candidate.businessId) ? '已是成员' : '添加'}
                </Button>
              </div>
            ))}
          </div>
        </div>
      </DialogShell>
    </Dialog>
  );
}

export function TransferAgentDialog({
  agentId,
  agentName,
  currentOwner,
  onClose,
}: {
  agentId: string;
  agentName: string;
  currentOwner: string;
  onClose: () => void;
}) {
  const transfer = useTransferAgent();
  const [query, setQuery] = useState('');
  const settled = useDebouncedValue(query.trim(), 300);
  const identities = useIdentities(agentId, { q: settled, limit: 20 });
  const [target, setTarget] = useState<string | null>(null);

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogShell
        title={`转交「${agentName}」`}
        description="新负责人必须是活跃账户并具备创建专家的权限；原负责人不会自动保留成员权限。"
        className="max-w-lg sm:max-w-lg"
        closeDisabled={transfer.isPending}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">当前负责人</span>
            <span className="font-mono text-xs">{currentOwner || '—'}</span>
          </div>
          <SearchInput
            label="搜索新负责人"
            placeholder="搜索业务 ID 或姓名…"
            value={query}
            onChange={setQuery}
          />
          {identities.isPending && settled.length > 0 ? <LoadingState rows={2} /> : null}
          {identities.isError ? (
            <ErrorState error={identities.error} onRetry={() => void identities.refetch()} />
          ) : null}
          {(identities.data?.items ?? []).map((candidate) => (
            <label
              key={candidate.businessId}
              htmlFor={`agent-transfer-target-${candidate.businessId}`}
              className="flex items-center gap-2 border-y py-2 text-sm"
            >
              <Checkbox
                id={`agent-transfer-target-${candidate.businessId}`}
                checked={target === candidate.businessId}
                onCheckedChange={() => setTarget(candidate.businessId)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{candidate.name || candidate.businessId}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {candidate.businessId}
                  {candidate.accountActive ? '' : ' · 离线'}
                </span>
              </span>
            </label>
          ))}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" disabled={transfer.isPending} onClick={onClose}>
              取消
            </Button>
            <Button
              disabled={target === null || target === currentOwner || transfer.isPending}
              aria-busy={transfer.isPending}
              onClick={() => {
                if (!target) return;
                transfer.mutate(
                  { agentId, ownerBusinessId: target },
                  {
                    onSuccess: () => {
                      toastSuccess('负责人已转交');
                      onClose();
                    },
                    onError: toastError,
                  },
                );
              }}
            >
              {transfer.isPending ? '正在转交…' : '转交'}
            </Button>
          </div>
        </div>
      </DialogShell>
    </Dialog>
  );
}
