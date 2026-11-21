import type { ConnectorNetwork, KnowledgeConnector, SourceItem } from './ingestion.js';
import { sourceNetworkOptions } from './source-http.js';
import type { SourceItem as LeafSourceItem, SourceConfig } from './source-types.js';
import { probeSource, readSource } from './sources.js';

type RangeInput = {
  id?: string;
  kind: string;
  externalId: string;
  ref: string | null;
  paths: string[];
};

function rangeKey(type: string, range: RangeInput): string {
  const parts = [type, range.kind, range.externalId, range.ref ?? ''];
  if (type === 'gitlab' || type === 'github' || type === 'seafile') {
    parts.push(range.paths.join(','));
  }
  return parts.join('|');
}

function toSourceConfig(
  type: string,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  range: RangeInput,
  network: ConnectorNetwork = {},
): SourceConfig {
  const credentials = secrets;
  const base = {
    credentials,
    ...sourceNetworkOptions(network),
  };
  switch (type) {
    case 'feed': {
      const url = range.externalId || (typeof config.url === 'string' ? config.url : '');
      return { ...base, type: 'rss', url, settings: {} };
    }
    case 'gitlab': {
      return {
        ...base,
        type: 'gitlab',
        url: typeof config.baseUrl === 'string' ? config.baseUrl : '',
        settings: {
          project: range.externalId || config.projectId,
          ref: range.ref ?? config.ref,
          paths: range.paths,
        },
      };
    }
    case 'github': {
      const ref = range.ref?.trim();
      return {
        ...base,
        type: 'github',
        url: typeof config.baseUrl === 'string' ? config.baseUrl : '',
        settings: {
          project: range.externalId || config.projectId,
          ...(ref ? { ref } : {}),
          paths: range.paths,
        },
      };
    }
    case 'feishu_wiki':
    case 'feishu_drive': {
      const settings: Record<string, unknown> = { appId: config.appId };
      if (type === 'feishu_wiki') {
        if (range.kind === 'wiki_node') settings.nodeToken = range.externalId;
        else settings.spaceId = range.externalId;
      } else {
        settings.folderToken = range.externalId;
      }
      return {
        ...base,
        type: 'feishu',
        url: typeof config.baseUrl === 'string' ? config.baseUrl : 'https://open.feishu.cn',
        settings,
      };
    }
    case 'lark_wiki':
    case 'lark_drive': {
      const settings: Record<string, unknown> = {
        appId: config.appId,
        region: 'lark',
        exportFiles: true,
      };
      if (type === 'lark_wiki') {
        if (range.kind === 'wiki_node') settings.nodeToken = range.externalId;
        else settings.spaceId = range.externalId;
      } else {
        settings.folderToken = range.externalId;
      }
      return {
        ...base,
        type: 'feishu',
        url: 'https://open.larksuite.com',
        settings,
      };
    }
    case 'notion':
      return {
        ...base,
        type: 'notion',
        url: 'https://api.notion.com',
        settings: { rangeKind: range.kind, resourceId: range.externalId },
      };
    case 'confluence': {
      const siteUrl = typeof config.baseUrl === 'string' ? config.baseUrl : '';
      return {
        ...base,
        type: 'confluence',
        url: siteUrl,
        settings: {
          authMode: config.authMode,
          ...(config.email === undefined ? {} : { email: config.email }),
          ...(config.cloudId === undefined ? {} : { cloudId: config.cloudId }),
          rangeKind: range.kind,
          resourceId: range.externalId,
          siteUrl,
        },
      };
    }
    case 'yuque':
      return {
        ...base,
        type: 'yuque',
        url: 'https://www.yuque.com',
        settings: { repoId: range.externalId },
      };
    case 'dingtalk':
      return {
        ...base,
        type: 'dingtalk',
        url: 'https://api.dingtalk.com',
        settings: {
          clientId: config.clientId,
          operatorUnionId: config.operatorUnionId,
          rangeKind: range.kind,
          resourceId: range.externalId,
        },
      };
    case 'ima':
      return {
        ...base,
        type: 'ima',
        url: 'https://ima.qq.com',
        settings: { clientId: config.clientId, knowledgeBaseId: range.externalId },
      };
    case 'seafile':
      return {
        ...base,
        type: 'seafile',
        url: typeof config.baseUrl === 'string' ? config.baseUrl : '',
        settings: { repoId: range.externalId, paths: range.paths },
      };
    case 'nextcloud':
      return {
        ...base,
        type: 'nextcloud',
        url: typeof config.baseUrl === 'string' ? config.baseUrl : '',
        settings: { username: config.username, path: range.externalId },
      };
    default:
      throw new Error(`不支持的来源类型 ${type}`);
  }
}

const MAX_SOURCE_ID_LENGTH = 500;

function itemSourceId(connectionId: string, externalId: string): string {
  return `${connectionId}:${externalId}`;
}

function toItem(
  item: LeafSourceItem,
  connectionId: string,
  rangeId: string | undefined,
): SourceItem {
  const sourceId = itemSourceId(connectionId, item.externalId);
  return {
    sourceId,
    sourceUrl: item.sourceUrl || null,
    sourcePath: item.path || null,
    title: item.title,
    mimeType: item.mimeType,
    revision: item.revision ?? item.externalId,
    content: item.bytes ? Buffer.from(item.bytes) : { markdown: item.content },
    ...(item.deleted === true ? { deleted: true } : {}),
    ...(item.completeness ? { completeness: item.completeness } : {}),
    ...(rangeId ? { rangeId } : {}),
  };
}

function toFailure(
  failure: {
    externalId: string;
    title: string;
    code: string;
    message: string;
    retryable: boolean;
  },
  connectionId: string,
  rangeId: string | undefined,
): SourceItem {
  return {
    sourceId: itemSourceId(connectionId, failure.externalId),
    sourceUrl: null,
    sourcePath: null,
    title: failure.title,
    mimeType: 'application/octet-stream',
    revision: failure.externalId,
    content: { markdown: '' },
    ...(rangeId ? { rangeId } : {}),
    failure: {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
    },
  };
}

function createConnector(type: string): KnowledgeConnector {
  return {
    async probe(input) {
      await probeSource(
        toSourceConfig(type, input.config, input.secrets, input.range, input.network ?? {}),
        input.signal,
      );
    },
    async *sync(input) {
      const network = input.network ?? {};
      const previous = input.cursor;
      const cursors: Record<string, unknown> = {};
      let complete = true;
      for (const range of input.ranges) {
        const key = rangeKey(type, range);
        const snapshot = await readSource(
          toSourceConfig(type, input.config, input.secrets, range, network),
          previous[key] as Record<string, unknown> | undefined,
          input.signal,
        );
        cursors[key] = snapshot.cursor;
        let rangeComplete = snapshot.complete;
        for (const item of snapshot.items) {
          if (itemSourceId(input.connectionId, item.externalId).length > MAX_SOURCE_ID_LENGTH) {
            rangeComplete = false;
            yield toFailure(
              {
                externalId: item.externalId,
                title: item.title,
                code: 'invalid_response',
                message: `来源条目标识超过 ${MAX_SOURCE_ID_LENGTH} 字符，无法生成可移植的来源 ID`,
                retryable: false,
              },
              input.connectionId,
              range.id,
            );
            continue;
          }
          yield toItem(item, input.connectionId, range.id);
        }
        for (const failure of snapshot.failures ?? [])
          yield toFailure(failure, input.connectionId, range.id);
        complete &&= rangeComplete;
        await input.onCheckpoint({ ...cursors }, { complete: false });
      }
      await input.onCheckpoint({ ...cursors }, { complete });
    },
  };
}

export const knowledgeConnectors = {
  feishu_wiki: createConnector('feishu_wiki'),
  feishu_drive: createConnector('feishu_drive'),
  lark_wiki: createConnector('lark_wiki'),
  lark_drive: createConnector('lark_drive'),
  gitlab: createConnector('gitlab'),
  github: createConnector('github'),
  feed: createConnector('feed'),
  notion: createConnector('notion'),
  confluence: createConnector('confluence'),
  yuque: createConnector('yuque'),
  dingtalk: createConnector('dingtalk'),
  ima: createConnector('ima'),
  seafile: createConnector('seafile'),
  nextcloud: createConnector('nextcloud'),
} satisfies Record<string, KnowledgeConnector>;
