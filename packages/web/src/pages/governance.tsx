import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import type { z } from 'zod';
import { Page, PageBody, PageHeader, PageToolbar, PageTopbar } from '../components/page.js';
import { Button } from '../components/ui/button.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { SegmentedToggle } from '../components/view-toggle.js';
import { can } from '../lib/access.js';
import { meQuery } from '../lib/queries.js';
import { useOptimisticValue } from '../lib/use-optimistic-value.js';
import { governanceTabSchema } from '../routes/-search.js';
import { AlertsSection } from './governance/alerts-section.js';
import { BudgetsSection } from './governance/budgets-section.js';
import { COST_GROUPS, COST_WINDOWS, CostSection } from './governance/cost-section.js';
import { DepartmentsSection } from './governance/departments-section.js';
import { GrantsSection } from './governance/grants-section.js';
import { HandoverSection } from './governance/handover-section.js';

const TABS: readonly { value: z.infer<typeof governanceTabSchema>; label: string }[] = [
  { value: 'cost', label: '成本' },
  { value: 'budgets', label: '预算' },
  { value: 'departments', label: '部门' },
  { value: 'grants', label: '授权' },
  { value: 'handover', label: '交接' },
  { value: 'alerts', label: '告警' },
];

export function GovernancePage() {
  const search = useSearch({ from: '/_shell/governance' });
  const navigate = useNavigate({ from: '/governance' });
  const me = useQuery(meQuery);
  const canManage = can(me.data, 'governance.manage');
  const tab = search.tab ?? 'cost';
  const days = search.days ?? 30;
  const groupBy = search.groupBy ?? 'user';
  const [optimisticDays, commitDays] = useOptimisticValue(String(days));
  const [creatingBudget, setCreatingBudget] = useState(false);
  const [creatingDepartment, setCreatingDepartment] = useState(false);
  const createBudgetRef = useRef<HTMLButtonElement | null>(null);

  const headerActions =
    tab === 'budgets' && canManage ? (
      <Button ref={createBudgetRef} onClick={() => setCreatingBudget(true)}>
        <Plus data-icon="inline-start" aria-hidden="true" /> 新建预算
      </Button>
    ) : tab === 'departments' && canManage ? (
      <Button onClick={() => setCreatingDepartment(true)}>
        <Plus data-icon="inline-start" aria-hidden="true" /> 新建部门
      </Button>
    ) : undefined;

  return (
    <Page>
      <Tabs
        value={tab}
        onValueChange={(next, details) => {
          details.cancel();
          const parsed = governanceTabSchema.safeParse(next);
          if (!parsed.success || parsed.data === tab) return;
          void navigate({
            to: '/governance',
            search: { ...search, tab: parsed.data },
            replace: true,
          });
        }}
        className="min-h-0 flex-1"
      >
        <PageTopbar>
          <PageHeader
            title="治理"
            {...(headerActions === undefined ? {} : { actions: headerActions })}
          />
          <PageToolbar>
            <TabsList variant="line" aria-label="治理分区">
              {TABS.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {tab === 'cost' ? (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Select
                  value={optimisticDays}
                  items={COST_WINDOWS.map((value) => ({
                    value: String(value),
                    label: `${value} 天`,
                  }))}
                  onValueChange={(next, details) => {
                    if (next === null) {
                      details.cancel();
                      return;
                    }
                    commitDays(next, () =>
                      navigate({
                        to: '/governance',
                        search: { ...search, days: Number(next) as 7 | 30 | 90 },
                        replace: true,
                      }),
                    );
                  }}
                >
                  <SelectTrigger className="w-28" aria-label="统计窗口">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {COST_WINDOWS.map((value) => (
                        <SelectItem key={value} value={String(value)}>
                          {value} 天
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <SegmentedToggle
                  label="成本分组"
                  value={groupBy}
                  options={COST_GROUPS}
                  onChange={(next) =>
                    void navigate({
                      to: '/governance',
                      search: { ...search, groupBy: next },
                      replace: true,
                    })
                  }
                />
              </div>
            ) : null}
          </PageToolbar>
        </PageTopbar>

        <PageBody>
          <TabsContent value={tab} className="min-w-0">
            {tab === 'cost' ? <CostSection days={days} groupBy={groupBy} /> : null}
            {tab === 'budgets' ? (
              <BudgetsSection
                canManage={canManage}
                creating={creatingBudget}
                onCreatingChange={setCreatingBudget}
                createButtonRef={createBudgetRef}
              />
            ) : null}
            {tab === 'departments' ? (
              <DepartmentsSection
                canManage={canManage}
                creating={creatingDepartment}
                onCreatingChange={setCreatingDepartment}
              />
            ) : null}
            {tab === 'grants' ? <GrantsSection canManage={canManage} /> : null}
            {tab === 'handover' ? <HandoverSection canManage={canManage} /> : null}
            {tab === 'alerts' ? <AlertsSection canManage={canManage} /> : null}
          </TabsContent>
        </PageBody>
      </Tabs>
    </Page>
  );
}
