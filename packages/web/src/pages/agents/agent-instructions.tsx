import type { PermissionId } from '@agentport/shared';
import { type ComponentType, useState } from 'react';
import { HooksPanel } from '../../components/agent/hooks-panel.js';
import { WorkflowsPanel } from '../../components/agent/workflow-panel.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { OutputStylesPanel, RulesPanel } from '../../components/memory/memory-panel.js';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { hasAnyGrant } from '../../lib/access.js';
import type { AgentInstruction } from '../../lib/detail-tabs.js';
import { useEditStateNotify } from '../../lib/use-edit-state-notify.js';
import { availableInstructions } from './shared.js';

const writePermissions: Record<AgentInstruction, PermissionId> = {
  rules: 'agents.rules.write',
  styles: 'agents.styles.write',
  workflows: 'agents.workflows.write',
  hooks: 'agents.hooks.write',
};

type InstructionPanelProps = {
  agentId: string;
  canWrite: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
};

const instructionPanels: Record<AgentInstruction, ComponentType<InstructionPanelProps>> = {
  rules: RulesPanel,
  styles: OutputStylesPanel,
  workflows: WorkflowsPanel,
  hooks: HooksPanel,
};

export function AgentInstructions({
  agentId,
  permissions,
  instruction,
  isSubAgent = false,
  onInstructionChange,
  onDirtyChange,
  onPendingChange,
}: {
  agentId: string;
  permissions: readonly PermissionId[];
  instruction: AgentInstruction;
  isSubAgent?: boolean;
  onInstructionChange: (next: AgentInstruction) => void;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const options = availableInstructions(permissions, isSubAgent);
  const Panel = instructionPanels[instruction];
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [pendingInstruction, setPendingInstruction] = useState<AgentInstruction | null>(null);

  useEditStateNotify(dirty, pending, onDirtyChange, onPendingChange);

  const apply = (next: AgentInstruction): void => {
    setPendingInstruction(null);
    onInstructionChange(next);
  };
  const switchInstruction = (next: AgentInstruction): void => {
    if (next === instruction || pending) return;
    if (dirty) setPendingInstruction(next);
    else apply(next);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {options.length > 1 ? (
        <Tabs
          value={instruction}
          onValueChange={(next) => switchInstruction(next as AgentInstruction)}
        >
          <TabsList aria-label="指令类型">
            {options.map((item) => (
              <TabsTrigger
                key={item.id}
                value={item.id}
                aria-disabled={pending}
                title={pending ? '正在保存，稍后可切换' : undefined}
                className={
                  pending ? 'cursor-not-allowed aria-disabled:pointer-events-auto' : undefined
                }
              >
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      ) : null}
      <div className="min-w-0 cds-card-surface rounded-card bg-surface px-6 py-5">
        <Panel
          agentId={agentId}
          canWrite={hasAnyGrant(permissions, writePermissions[instruction])}
          onDirtyChange={setDirty}
          onPendingChange={setPending}
        />
      </div>
      <ConfirmDialog
        open={pendingInstruction !== null}
        onClose={() => setPendingInstruction(null)}
        title="放弃未保存的修改并切换？"
        description="当前指令还有未保存的内容，切换后会丢失。"
        confirmLabel="放弃并切换"
        confirmDisabled={pending}
        onConfirm={async () => {
          if (pendingInstruction) apply(pendingInstruction);
        }}
      />
    </div>
  );
}
