import type { PersonalOutputItem } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FileText, MessagesSquare } from 'lucide-react';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageSection,
  PageTopbar,
} from '../../components/page.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { buttonVariants } from '../../components/ui/button.js';
import { can } from '../../lib/access.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';
import {
  meQuery,
  usePersonalWorkConversations,
  usePersonalWorkOutputs,
} from '../../lib/queries.js';

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
  const canReadConversations = can(me.data, 'conversations.read');
  const conversations = usePersonalWorkConversations(canReadConversations);
  const outputs = usePersonalWorkOutputs(canReadConversations);

  return (
    <Page>
      <PageTopbar>
        <PageHeader title="会话与成果" />
      </PageTopbar>

      <PageBody>
        <PageSection title="我的会话" divided={false} className="gap-2">
          {conversations.isPending ? <LoadingState rows={3} layout="list" /> : null}
          {conversations.isError ? (
            <ErrorState error={conversations.error} onRetry={() => void conversations.refetch()} />
          ) : null}
          {conversations.data && conversations.data.length === 0 ? (
            <PageNote
              title="还没有会话"
              description="在对话中与专家开始一轮协作。"
              action={
                <Link to="/chat" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  开始对话
                </Link>
              }
            />
          ) : null}
          {conversations.data && conversations.data.length > 0 ? (
            <ul>
              {conversations.data.map((conversation) => (
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
        </PageSection>

        <PageSection title="我的成果" className="gap-2">
          {outputs.isPending ? <LoadingState rows={3} layout="list" /> : null}
          {outputs.isError ? (
            <ErrorState error={outputs.error} onRetry={() => void outputs.refetch()} />
          ) : null}
          {outputs.data && outputs.data.items.length === 0 ? (
            <PageNote
              title="还没有成果"
              description="专家在会话中发布文件后会出现在这里。"
              action={
                <Link to="/chat" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  开始对话
                </Link>
              }
            />
          ) : null}
          {outputs.data && outputs.data.items.length > 0 ? (
            <ul>
              {outputs.data.items.map((item) => (
                <OutputRow key={`${item.conversationId}:${item.runId}:${item.path}`} item={item} />
              ))}
            </ul>
          ) : null}
          {outputs.data?.truncated ? <PageNote title="仅显示部分成果" /> : null}
        </PageSection>
      </PageBody>
    </Page>
  );
}
