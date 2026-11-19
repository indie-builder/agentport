import type { ConversationSummary, PersonalOutputItem } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { FileText, MessagesSquare } from 'lucide-react';
import { FilterSelect } from '../../components/filter-select.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageToolbar,
  PageTopbar,
} from '../../components/page.js';
import { SearchInput } from '../../components/search-input.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { can } from '../../lib/access.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';
import {
  meQuery,
  usePersonalWorkConversations,
  usePersonalWorkOutputs,
} from '../../lib/queries.js';

type WorkTab = 'conversations' | 'outputs';
type ConversationSource = 'all' | 'manual' | 'scheduled';

const WORK_TABS = [
  { value: 'conversations', label: '会话' },
  { value: 'outputs', label: '成果' },
] as const;

const CONVERSATION_SOURCE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'manual', label: '手动对话' },
  { value: 'scheduled', label: '定时任务' },
] as const;

/**
 * 后端 ConversationSummary 暂未单独返回 source 字段；
 * 按定时任务建会话时的统一标题前缀「定时: 」（兼容全角冒号）区分手动对话与定时任务。
 */
const SCHEDULED_TITLE_PREFIX = /^定时[:：]\s*/;

function isScheduledConversation(conversation: ConversationSummary): boolean {
  return SCHEDULED_TITLE_PREFIX.test(conversation.title.trim());
}

function OutputRow({ item }: { item: PersonalOutputItem }) {
  return (
    <li>
      <Link
        to="/chat"
        search={{
          conversation: item.conversationId,
          outputRun: item.runId,
          outputPath: item.path,
        }}
        className="flex items-center gap-3 border-b border-line py-3 text-sm text-fg transition-colors duration-150 ease-out-soft last:border-b-0 hover:bg-hover"
      >
        <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate" title={item.path}>
            {item.path}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {`${item.conversationTitle} · ${formatBytes(item.size)}`}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatDateTime(item.createdAt)}
        </span>
      </Link>
    </li>
  );
}

export function PersonalWorkPage() {
  const me = useQuery(meQuery);
  const search = useSearch({ from: '/_shell/personal/work' });
  const navigate = useNavigate({ from: '/personal/work' });
  const tab: WorkTab = search.tab ?? 'conversations';
  const query = search.q ?? '';
  const source: ConversationSource = search.source ?? 'all';
  const canReadConversations = can(me.data, 'conversations.read');
  const conversations = usePersonalWorkConversations(
    canReadConversations && tab === 'conversations',
  );
  const outputs = usePersonalWorkOutputs(canReadConversations && tab === 'outputs');

  const normalizedQuery = query.trim().toLowerCase();
  const filteredConversations = (conversations.data ?? []).filter((conversation) => {
    if (source === 'scheduled' && !isScheduledConversation(conversation)) return false;
    if (source === 'manual' && isScheduledConversation(conversation)) return false;
    if (normalizedQuery === '') return true;
    const title = (conversation.title || '未命名会话').toLowerCase();
    const agent = conversation.agentName.toLowerCase();
    return title.includes(normalizedQuery) || agent.includes(normalizedQuery);
  });
  const filteredOutputs = (outputs.data?.items ?? []).filter((item) => {
    if (normalizedQuery === '') return true;
    return (
      item.path.toLowerCase().includes(normalizedQuery) ||
      item.conversationTitle.toLowerCase().includes(normalizedQuery)
    );
  });

  const noPermission = me.data !== undefined && !canReadConversations;

  return (
    <Page>
      {noPermission ? (
        <>
          <PageTopbar>
            <PageHeader title="会话与成果" />
          </PageTopbar>
          <PageBody>
            <PageNote
              title="当前账号无会话读取权限"
              description="缺少 conversations.read 权限，无法查看会话与成果。"
            />
          </PageBody>
        </>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(next) => {
            if (next === tab) return;
            if (!WORK_TABS.some((item) => item.value === next)) return;
            void navigate({
              to: '/personal/work',
              search: next === 'conversations' ? {} : { tab: next as WorkTab },
            });
          }}
          className="min-h-0 flex-1 gap-4"
        >
          <PageTopbar>
            <PageHeader title="会话与成果" />
            <PageToolbar>
              <TabsList variant="line" aria-label="切换会话与成果">
                {WORK_TABS.map((item) => (
                  <TabsTrigger key={item.value} value={item.value}>
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {tab === 'conversations' ? (
                <>
                  <SearchInput
                    label="搜索会话"
                    placeholder="搜索标题或专家…"
                    value={query}
                    onChange={(next) =>
                      void navigate({
                        to: '/personal/work',
                        search: (current) => ({ ...current, q: next || undefined }),
                        replace: true,
                      })
                    }
                    className="w-56 min-w-0"
                  />
                  <FilterSelect
                    value={source}
                    onValueChange={(next) =>
                      void navigate({
                        to: '/personal/work',
                        search: (current) => ({
                          ...current,
                          source: next === 'all' ? undefined : (next as 'manual' | 'scheduled'),
                        }),
                      })
                    }
                    options={CONVERSATION_SOURCE_OPTIONS}
                    label="按来源筛选会话"
                    className="w-full sm:w-36"
                  />
                  <div className="ml-auto flex items-center gap-3">
                    {conversations.data ? (
                      <p role="status" className="text-xs text-muted-foreground">
                        共 {filteredConversations.length} 条会话
                      </p>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <SearchInput
                    label="搜索成果"
                    placeholder="搜索文件名或来源会话…"
                    value={query}
                    onChange={(next) =>
                      void navigate({
                        to: '/personal/work',
                        search: (current) => ({ ...current, q: next || undefined }),
                        replace: true,
                      })
                    }
                    className="w-56 min-w-0"
                  />
                  <div className="ml-auto flex items-center gap-3">
                    {outputs.data ? (
                      <p role="status" className="text-xs text-muted-foreground">
                        共 {filteredOutputs.length} 份成果
                      </p>
                    ) : null}
                  </div>
                </>
              )}
            </PageToolbar>
          </PageTopbar>

          <PageBody>
            <TabsContent value="conversations" className="min-w-0">
              {tab === 'conversations' ? (
                <>
                  {conversations.isPending ? <LoadingState rows={3} layout="list" /> : null}
                  {conversations.isError ? (
                    <ErrorState
                      error={conversations.error}
                      onRetry={() => void conversations.refetch()}
                    />
                  ) : null}
                  {conversations.data && conversations.data.length === 0 ? (
                    <PageNote
                      title="当前无会话记录"
                      description="与专家发起对话后会显示在这里。"
                      action={
                        <Link
                          to="/chat"
                          className={buttonVariants({ variant: 'outline', size: 'sm' })}
                        >
                          开始对话
                        </Link>
                      }
                    />
                  ) : null}
                  {conversations.data &&
                  conversations.data.length > 0 &&
                  filteredConversations.length === 0 ? (
                    <PageNote
                      title="当前筛选下无匹配会话"
                      description="调整关键词或来源筛选后重试。"
                      action={
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void navigate({
                              to: '/personal/work',
                              search: {},
                            })
                          }
                        >
                          清除筛选
                        </Button>
                      }
                    />
                  ) : null}
                  {filteredConversations.length > 0 ? (
                    <ul>
                      {filteredConversations.map((conversation) => (
                        <li key={conversation.id}>
                          <Link
                            to="/chat"
                            search={{ conversation: conversation.id }}
                            className="flex items-center gap-3 border-b border-line py-3 text-sm text-fg transition-colors duration-150 ease-out-soft last:border-b-0 hover:bg-hover"
                          >
                            <MessagesSquare
                              aria-hidden="true"
                              className="size-4 shrink-0 text-muted-foreground"
                            />
                            <span className="min-w-0 flex-1 truncate">
                              {conversation.title || '未命名会话'}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {conversation.agentName}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {formatDateTime(conversation.updatedAt)}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </TabsContent>
            <TabsContent value="outputs" className="min-w-0">
              {tab === 'outputs' ? (
                <>
                  {outputs.isPending ? <LoadingState rows={3} layout="list" /> : null}
                  {outputs.isError ? (
                    <ErrorState error={outputs.error} onRetry={() => void outputs.refetch()} />
                  ) : null}
                  {outputs.data && outputs.data.items.length === 0 ? (
                    <PageNote
                      title="当前无已发布成果"
                      description="专家在会话中发布文件后会显示在这里。"
                      action={
                        <Link
                          to="/chat"
                          className={buttonVariants({ variant: 'outline', size: 'sm' })}
                        >
                          开始对话
                        </Link>
                      }
                    />
                  ) : null}
                  {outputs.data && outputs.data.items.length > 0 && filteredOutputs.length === 0 ? (
                    <PageNote
                      title="当前搜索下无匹配成果"
                      description="更换文件名或来源会话关键词后重试。"
                      action={
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void navigate({
                              to: '/personal/work',
                              search: { tab: 'outputs' },
                            })
                          }
                        >
                          清除搜索
                        </Button>
                      }
                    />
                  ) : null}
                  {filteredOutputs.length > 0 ? (
                    <ul>
                      {filteredOutputs.map((item) => (
                        <OutputRow
                          key={`${item.conversationId}:${item.runId}:${item.path}`}
                          item={item}
                        />
                      ))}
                    </ul>
                  ) : null}
                  {outputs.data?.truncated ? <PageNote title="仅显示部分成果" /> : null}
                </>
              ) : null}
            </TabsContent>
          </PageBody>
        </Tabs>
      )}
    </Page>
  );
}
