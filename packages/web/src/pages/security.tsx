import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Page, PageBody, PageHeader, PageToolbar, PageTopbar } from '../components/page.js';
import { Button } from '../components/ui/button.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { can } from '../lib/access.js';
import { meQuery, useSecurityApprovals, useSecurityViolations } from '../lib/queries.js';
import { ApprovalsSection } from './security/approvals-section.js';
import { EventsSection } from './security/events-section.js';
import { PoliciesSection } from './security/policies-section.js';
import { TABS } from './security/shared.js';
import { ViolationsSection } from './security/violations-section.js';

function TabPendingCountBadge({ count, hasMore }: { count: number; hasMore: boolean }) {
  if (count <= 0) return null;
  return (
    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-pill bg-warning-soft px-1.5 font-mono text-2xs font-medium leading-none text-warning tabular-nums">
      {hasMore ? `${count}+` : count}
    </span>
  );
}

function PendingApprovalsBadge() {
  const approvals = useSecurityApprovals('pending');
  const count = approvals.data?.pages.reduce((sum, page) => sum + page.items.length, 0) ?? 0;
  return <TabPendingCountBadge count={count} hasMore={Boolean(approvals.hasNextPage)} />;
}

function OpenViolationsBadge() {
  const violations = useSecurityViolations('open');
  const count = violations.data?.pages.reduce((sum, page) => sum + page.items.length, 0) ?? 0;
  return <TabPendingCountBadge count={count} hasMore={Boolean(violations.hasNextPage)} />;
}

export function SecurityPage() {
  const search = useSearch({ from: '/_shell/security' });
  const navigate = useNavigate({ from: '/security' });
  const me = useQuery(meQuery);
  const canRead = can(me.data, 'security.read');
  const canManage = can(me.data, 'security.manage');
  const tab = search.tab ?? 'policies';
  const [creatingPolicy, setCreatingPolicy] = useState(false);

  return (
    <Page>
      <Tabs
        value={tab}
        onValueChange={(next, details) => {
          details.cancel();
          if (next === tab || !TABS.some((item) => item.value === next)) return;
          void navigate({
            to: '/security',
            search: { ...search, tab: next as (typeof TABS)[number]['value'] },
            replace: true,
          });
        }}
        className="min-h-0 flex-1 gap-4"
      >
        <PageTopbar>
          <PageHeader
            title="安全运营"
            {...(tab === 'policies' && canManage
              ? {
                  actions: (
                    <Button onClick={() => setCreatingPolicy(true)}>
                      <Plus data-icon="inline-start" aria-hidden="true" />
                      新建策略
                    </Button>
                  ),
                }
              : {})}
          />
          <PageToolbar>
            <TabsList variant="line" aria-label="安全运营分区">
              {TABS.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                  {canRead && item.value === 'approvals' ? <PendingApprovalsBadge /> : null}
                  {canRead && item.value === 'violations' ? <OpenViolationsBadge /> : null}
                </TabsTrigger>
              ))}
            </TabsList>
          </PageToolbar>
        </PageTopbar>

        <PageBody>
          <TabsContent value={tab} className="min-w-0">
            {tab === 'policies' ? (
              <PoliciesSection
                canManage={canManage}
                creating={creatingPolicy}
                onCreatingChange={setCreatingPolicy}
              />
            ) : null}
            {tab === 'approvals' ? <ApprovalsSection canManage={canManage} /> : null}
            {tab === 'events' ? <EventsSection /> : null}
            {tab === 'violations' ? <ViolationsSection canManage={canManage} /> : null}
          </TabsContent>
        </PageBody>
      </Tabs>
    </Page>
  );
}
