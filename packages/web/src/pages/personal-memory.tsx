import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { MemoryReviews } from '../components/memory-review.js';
import { Page, PageHeader } from '../components/page.js';
import { PersonalMemoryPanel } from '../components/personal-memory-panel.js';
import { can } from '../lib/access.js';
import { useFormBlocker } from '../lib/form.js';
import { meQuery } from '../lib/queries.js';

export function PersonalMemoryPage() {
  const me = useQuery(meQuery);
  const canWrite = can(me.data, 'personal_memory.write');
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [draftResetKey, setDraftResetKey] = useState(0);
  const blocker = useFormBlocker(dirty, pending);

  return (
    <Page>
      <PageHeader title="个人记忆" />
      <PersonalMemoryPanel
        key={draftResetKey}
        canWrite={canWrite}
        onDirtyChange={setDirty}
        onPendingChange={setPending}
      />
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="放弃未保存的个人记忆？"
        description="离开后，当前草稿会丢失。可以先保存再继续。"
        confirmLabel="放弃并离开"
        confirmDisabled={pending}
        onConfirm={async () => {
          setDraftResetKey((value) => value + 1);
          blocker.proceed();
        }}
      />
    </Page>
  );
}

export function PersonalReviewsPage() {
  const me = useQuery(meQuery);
  const search = useSearch({ from: '/_shell/personal/reviews' });
  const navigate = useNavigate({ from: '/personal/reviews' });
  const canReview = can(me.data, 'personal_memory.review');
  const canWrite = can(me.data, 'personal_memory.write');
  const canReadConversations = can(me.data, 'conversations.read');
  const canReadAgents = can(me.data, 'agents.read');

  return (
    <Page>
      <PageHeader title="历史回顾" />
      <MemoryReviews
        agentId={search.agent ?? null}
        onAgentChange={(next) =>
          void navigate({
            to: '/personal/reviews',
            search: { agent: next ?? undefined },
          })
        }
        canReview={canReview}
        canWrite={canWrite}
        canReadConversations={canReadConversations}
        canReadAgents={canReadAgents}
        runId={search.run ?? null}
        onRunChange={(next) =>
          void navigate({
            to: '/personal/reviews',
            search: (current) => ({
              ...current,
              run: next ?? undefined,
            }),
          })
        }
      />
    </Page>
  );
}
