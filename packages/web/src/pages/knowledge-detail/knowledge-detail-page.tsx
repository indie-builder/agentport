import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { BaseInfoDialog } from '../../components/knowledge-base-info.js';
import { KnowledgeEvaluations } from '../../components/knowledge-evaluations.js';
import { ExpertUsage } from '../../components/knowledge-expert-usage.js';
import { FaqTab } from '../../components/knowledge-faq.js';
import { KnowledgeOverview } from '../../components/knowledge-overview.js';
import { SearchTab } from '../../components/knowledge-search.js';
import { KnowledgeSettingsDialog } from '../../components/knowledge-settings.js';
import { WikiTab } from '../../components/knowledge-wiki.js';
import { Page, PageBody, PageHeader, PageTopbar } from '../../components/page.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { can } from '../../lib/access.js';
import { knowledgeTabs as tabs } from '../../lib/detail-tabs.js';
import { meQuery, useKnowledgeBase } from '../../lib/queries.js';
import type { knowledgeDetailSearchSchema } from '../../routes/-search.js';
import { DocumentsTab } from './documents-tab.js';
import { JobsTab } from './jobs-tab.js';
import type { KnowledgeCaps } from './shared.js';
import { SourcesTab } from './sources-tab.js';

type TabId = (typeof tabs)[number]['id'];
type DetailSearch = z.infer<typeof knowledgeDetailSearchSchema>;

export function KnowledgeDetailPage() {
  const { baseId } = useParams({ from: '/_shell/knowledge/$baseId' });
  const search = useSearch({ from: '/_shell/knowledge/$baseId' });
  const navigate = useNavigate();
  const base = useKnowledgeBase(baseId);
  const me = useQuery(meQuery);
  const tab: TabId = search.panel ?? 'documents';
  const caps: KnowledgeCaps = {
    content: can(me.data, 'knowledge.content.manage'),
    sources: can(me.data, 'knowledge.sources.manage'),
    execute: can(me.data, 'knowledge.execute'),
    publish: can(me.data, 'knowledge.publish'),
    update: can(me.data, 'knowledge.update'),
    import: can(me.data, 'knowledge.import'),
    export: can(me.data, 'knowledge.export'),
  };
  const canReadAgents = can(me.data, 'agents.read');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTrigger, setSettingsTrigger] = useState<HTMLElement | null>(null);
  const [editingOpen, setEditingOpen] = useState(false);
  const [editTrigger, setEditTrigger] = useState<HTMLElement | null>(null);
  const [expertsOpen, setExpertsOpen] = useState(false);

  const go = (patch: Partial<DetailSearch>, replace = false): void => {
    const next = Object.fromEntries(
      Object.entries({ ...search, ...patch }).filter(([, value]) => value !== undefined),
    ) as DetailSearch;
    void navigate({
      to: '/knowledge/$baseId',
      params: { baseId },
      search: next,
      replace,
    });
  };

  return (
    <Tabs
      value={tab}
      onValueChange={(next) =>
        go(
          {
            panel: next === 'documents' ? undefined : next,
            ...(next === 'jobs' ? {} : { document: undefined }),
          },
          true,
        )
      }
      className="h-full min-h-0"
    >
      <Page>
        <PageTopbar>
          <PageHeader
            title={base.data?.name ?? '知识库'}
            leading={
              <Link
                to="/knowledge"
                aria-label="返回知识库列表"
                className={buttonVariants({ variant: 'outline', size: 'icon' })}
              >
                <ArrowLeft />
              </Link>
            }
            eyebrow={
              base.data ? (
                <StatusBadge tone={base.data.status === 'active' ? 'success' : 'outline'}>
                  {base.data.status === 'active' ? '启用' : '已停用'}
                </StatusBadge>
              ) : undefined
            }
            actions={
              <>
                {base.data && canReadAgents ? (
                  <Popover open={expertsOpen} onOpenChange={setExpertsOpen}>
                    <PopoverTrigger render={<Button variant="outline" />}>
                      使用此库的专家
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-80" aria-label="使用此库的专家">
                      <ExpertUsage base={base.data} enabled={expertsOpen} />
                    </PopoverContent>
                  </Popover>
                ) : null}
                {base.data && caps.update ? (
                  <Button
                    variant="outline"
                    onClick={(event) => {
                      setEditTrigger(event.currentTarget);
                      setEditingOpen(true);
                    }}
                  >
                    编辑信息
                  </Button>
                ) : null}
                {base.data && caps.update ? (
                  <Button
                    variant="outline"
                    onClick={(event) => {
                      setSettingsTrigger(event.currentTarget);
                      setSettingsOpen(true);
                    }}
                  >
                    设置
                  </Button>
                ) : null}
              </>
            }
            className="min-w-0"
          />
          {base.data !== undefined ? (
            <TabsList variant="line" aria-label="知识库分区" className="gap-4 border-b">
              {tabs.map((item) => (
                <TabsTrigger key={item.id} value={item.id}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          ) : null}
        </PageTopbar>
        <PageBody>
          {base.isPending ? <LoadingState rows={2} /> : null}
          {base.isError && base.data === undefined ? (
            <ErrorState error={base.error} onRetry={() => void base.refetch()} />
          ) : null}
          {base.data !== undefined ? (
            <>
              {base.isError ? (
                <ErrorState
                  title="知识库信息没有刷新成功"
                  error={base.error}
                  onRetry={() => void base.refetch()}
                />
              ) : null}
              <TabsContent value="overview">
                <KnowledgeOverview
                  base={base.data}
                  canCreate={can(me.data, 'knowledge.create')}
                  canUpload={caps.content}
                  canReadAgents={canReadAgents}
                  onOpenJobs={() => go({ panel: 'jobs', document: undefined })}
                  onOpenDocuments={() => go({ panel: 'documents' })}
                  onDuplicated={(nextBaseId) =>
                    void navigate({
                      to: '/knowledge/$baseId',
                      params: { baseId: nextBaseId },
                      search: {},
                    })
                  }
                />
              </TabsContent>
              <TabsContent value="documents">
                <DocumentsTab
                  baseId={baseId}
                  caps={caps}
                  asrEnabled={base.data?.asrProfileId != null}
                  folderId={search.folder}
                  onFolderChange={(folderId) => go({ folder: folderId }, true)}
                  documentId={search.document}
                  onDocumentChange={(document) => go({ document }, true)}
                  onViewJobs={(documentId) => go({ panel: 'jobs', document: documentId })}
                />
              </TabsContent>
              <TabsContent value="sources">
                <SourcesTab
                  baseId={baseId}
                  caps={caps}
                  sourceId={search.source}
                  onSelectSource={(source) => go({ source })}
                  onOpenDocument={(document) =>
                    go({ panel: 'documents', source: undefined, folder: undefined, document })
                  }
                />
              </TabsContent>
              <TabsContent value="search">
                <SearchTab
                  baseId={baseId}
                  canExecute={caps.execute}
                  state={search}
                  onChange={(patch, replace) => go(patch, replace)}
                />
              </TabsContent>
              <TabsContent value="evaluations">
                <KnowledgeEvaluations baseId={baseId} canExecute={caps.execute} />
              </TabsContent>
              <TabsContent value="faqs">
                <FaqTab baseId={baseId} caps={caps} />
              </TabsContent>
              <TabsContent value="wiki">
                <WikiTab
                  baseId={baseId}
                  caps={caps}
                  pageId={search.page}
                  onSelect={(page) => go({ page })}
                />
              </TabsContent>
              <TabsContent value="jobs">
                <JobsTab
                  baseId={baseId}
                  canExecute={caps.execute}
                  canUpload={caps.content}
                  documentId={search.document}
                  onClearDocument={() => go({ document: undefined }, true)}
                  onGoDocuments={() => go({ panel: undefined, document: undefined })}
                  onOpenDocument={(document) =>
                    go({ panel: 'documents', source: undefined, folder: undefined, document })
                  }
                  onOpenSource={(source) => go({ panel: 'sources', source, document: undefined })}
                />
              </TabsContent>
            </>
          ) : null}
        </PageBody>
        {base.data && editingOpen ? (
          <BaseInfoDialog
            base={base.data}
            finalFocus={() => (editTrigger?.isConnected ? editTrigger : null)}
            onClose={() => setEditingOpen(false)}
          />
        ) : null}
        {base.data && settingsOpen ? (
          <KnowledgeSettingsDialog
            base={base.data}
            finalFocus={() => (settingsTrigger?.isConnected ? settingsTrigger : null)}
            onClose={() => setSettingsOpen(false)}
          />
        ) : null}
      </Page>
    </Tabs>
  );
}
