import type { SearchItem } from '@agentport/shared';
import { Bot, Cable, FileText, LibraryBig, MessagesSquare, Puzzle, Sparkles } from 'lucide-react';

export const SEARCH_KIND_META = {
  agent: { label: '专家', icon: Bot },
  conversation: { label: '会话', icon: MessagesSquare },
  knowledge: { label: '知识库', icon: LibraryBig },
  server: { label: '连接器', icon: Cable },
  skill: { label: '技能', icon: Sparkles },
  plugin: { label: '插件', icon: Puzzle },
  output: { label: '成果', icon: FileText },
} as const;

export const SEARCH_KIND_ORDER = Object.keys(SEARCH_KIND_META) as Array<SearchItem['kind']>;

export function searchItemHref(item: SearchItem): string {
  switch (item.kind) {
    case 'agent':
      return `/agents/${item.id}`;
    case 'conversation':
      return `/chat?${new URLSearchParams({ conversation: item.id }).toString()}`;
    case 'knowledge':
      return `/knowledge/${item.id}`;
    case 'server':
      return `/servers?${new URLSearchParams({ q: item.title }).toString()}`;
    case 'skill':
      return `/skills?${new URLSearchParams({ q: item.title }).toString()}`;
    case 'plugin':
      return `/plugins/${item.id}`;
    case 'output': {
      const params = new URLSearchParams();
      if (item.conversationId !== undefined) params.set('conversation', item.conversationId);
      if (item.runId !== undefined) params.set('outputRun', item.runId);
      if (item.path !== undefined) params.set('outputPath', item.path);
      return params.size === 0 ? '/chat' : `/chat?${params.toString()}`;
    }
  }
}
