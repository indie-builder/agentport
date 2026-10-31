import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { MemoryReviews, type MemoryReviewView } from '../components/memory-review.js';
import { Page, PageHeader } from '../components/page.js';
import { PersonalMemoryPanel } from '../components/personal-memory-panel.js';
import { can } from '../lib/access.js';
import { useFormBlocker } from '../lib/form.js';
import { meQuery } from '../lib/queries.js';

export function PersonalMemoryPage() {
  const me = useQuery(meQuery);
  const canWrite = can(me.data, 'personal_memory.write');
  const canReview = can(me.data, 'personal_memory.review');
  const canConverse = can(me.data, 'conversations.read');
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
        canReview={canReview}
        canConverse={canConverse}
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
      <PageHeader title="记忆提案" />
      <MemoryReviews
        agentId={search.agent ?? null}
        onAgentChange={(next) =>
          void navigate({
            to: '/personal/reviews',
            search: (current) => ({ ...current, agent: next ?? undefined }),
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
        createRequested={search.create === true}
        onCreateRequestedChange={(next) =>
          void navigate({
            to: '/personal/reviews',
            search: (current) => ({
              ...current,
              create: next ? true : undefined,
            }),
          })
        }
        view={search.view ?? null}
        onViewChange={(next: MemoryReviewView | null) =>
          void navigate({
            to: '/personal/reviews',
            search: (current) => ({ ...current, view: next ?? undefined }),
          })
        }
      />
    </Page>
  );
}
