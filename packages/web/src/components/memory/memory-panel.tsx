import { useState } from 'react';
import { type MemoryView, memoryViews } from '../../lib/detail-tabs.js';
import { useEditStateNotify } from '../../lib/use-edit-state-notify.js';
import { ConfirmDialog } from '../confirm-dialog.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.js';
import { MemoryOverview } from './memory-overview.js';
import { MemoryPolicyPanel } from './memory-policy.js';
import { MemoryFilesPanel } from './panel/memory-files-panel.js';
import { type DraftCallbacks, useSwitchGuard } from './panel/shared.js';

export { OutputStylesPanel } from './panel/output-styles-panel.js';
export { RulesPanel } from './panel/rules-panel.js';

export function MemoryPanel({
  agentId,
  canWrite = true,
  view: viewProp,
  onViewChange,
  onDirtyChange,
  onPendingChange,
}: {
  agentId: string;
  canWrite?: boolean;
  view?: MemoryView | undefined;
  onViewChange?: ((next: MemoryView) => void) | undefined;
} & DraftCallbacks) {
  const [localView, setLocalView] = useState<MemoryView>('overview');
  const view = viewProp ?? localView;
  const [filesDirty, setFilesDirty] = useState(false);
  const [filesPending, setFilesPending] = useState(false);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [policyPending, setPolicyPending] = useState(false);
  const dirty = filesDirty || policyDirty;
  const pending = filesPending || policyPending;

  useEditStateNotify(dirty, pending, onDirtyChange, onPendingChange);

  const viewGuard = useSwitchGuard<MemoryView>(dirty, pending, (next) => {
    setLocalView(next);
    onViewChange?.(next);
  });

  const switchView = (next: MemoryView): void => {
    if (next !== view) viewGuard.request(next);
  };

  return (
    <div className="flex flex-col gap-4">
      <Tabs
        className="gap-4"
        value={view}
        onValueChange={(next) => {
          if (next === 'overview' || next === 'files' || next === 'policy') switchView(next);
        }}
      >
        <TabsList aria-label="专家记忆视图">
          {memoryViews.map((item) => (
            <TabsTrigger
              key={item.id}
              value={item.id}
              aria-disabled={pending}
              title={pending ? '正在保存，稍后可切换' : undefined}
              className={
                pending
                  ? 'cursor-not-allowed hover:text-muted-foreground aria-disabled:pointer-events-auto'
                  : undefined
              }
            >
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <MemoryOverview agentId={agentId} onOpenFiles={() => switchView('files')} />
        </TabsContent>
        <TabsContent value="files">
          <MemoryFilesPanel
            agentId={agentId}
            canWrite={canWrite}
            onDirtyChange={setFilesDirty}
            onPendingChange={setFilesPending}
          />
        </TabsContent>
        <TabsContent value="policy">
          <MemoryPolicyPanel
            agentId={agentId}
            canWrite={canWrite}
            onDirtyChange={setPolicyDirty}
            onPendingChange={setPolicyPending}
          />
        </TabsContent>
      </Tabs>
      <ConfirmDialog
        open={viewGuard.pendingAction !== null}
        onClose={viewGuard.cancel}
        title="放弃未保存的修改？"
        description="当前视图还有未保存的内容，切换后会丢失。"
        confirmLabel="放弃并继续"
        confirmDisabled={pending}
        tone="default"
        onConfirm={viewGuard.confirm}
      />
    </div>
  );
}
