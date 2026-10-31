import type { ConnectorNetwork, KnowledgeConnector, SourceItem } from './ingestion.js';
import {
  type SourceItem as LeafSourceItem,
  probeSource,
  readSource,
  type SourceConfig,
} from './sources.js';

/**
 * 把 sources.ts 的「读一次快照」适配成 ingestion 的连接器协议。
 *
 * 一个 range 就是一次独立读取：各自有游标、各自证明是否完整枚举。
 * 全部 range 都读完才把 complete 汇总上报，摄取层只在这时推导删除。
 * 数据来源：feed 每个 range 是一个订阅地址；gitlab/github 每个 range 是一个 repo/ref；
 * 飞书/Lark wiki 每个 range 是一个 space 或 node；drive 每个 range 是一个 folder；
 * 其余来源的 range 形状见各叶模块契约。
 */

type RangeInput = {
  id?: string;
  kind: string;
  externalId: string;
  ref: string | null;
  paths: string[];
};

/** 游标按 range 分开存，同一个来源内增删 range 不会互相覆盖。 */
function rangeKey(type: string, range: RangeInput): string {
  const parts = [type, range.kind, range.externalId, range.ref ?? ''];
  // paths 是范围的一部分：缩小 paths 后不能沿用旧游标误判完整。
  if (type === 'gitlab' || type === 'github' || type === 'seafile') {
    parts.push(range.paths.join(','));
  }
  return parts.join('|');
}

/** 原始来源行 + 单个 range → sources.ts 的读取配置。 */
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
    ...(network.trustedHosts?.length ? { trustedHosts: network.trustedHosts } : {}),
    ...(network.allowLoopback === true ? { allowLoopback: true } : {}),
  };
  switch (type) {
    case 'feed': {
      // 每个 range 是一个订阅源；config.url 只在迁移旧数据时兜底。
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
          // ref 属于每个仓库范围：空值交给 readGithub 用该仓库的 default_branch。
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
      // Lark 是独立的飞书应用；固定接口域名并走同一实现的导出原件分支。
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

/** ZIP 清单的 sourceId 上限；超过时该条目不可移植，按单项失败处理而不是截断。 */
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
    // 同一外部 ID 可能出现在两个同 base 的连接里；sourceId 带上连接 ID 才不会互相覆盖。
    sourceId,
    sourceUrl: item.sourceUrl || null,
    sourcePath: item.path || null,
    title: item.title,
    mimeType: item.mimeType,
    // 来源没有可靠版本时用 externalId；内容是否更新仍由摄取层按字节哈希决定。
    revision: item.revision ?? item.externalId,
    content: item.bytes ? Buffer.from(item.bytes) : { markdown: item.content },
    ...(item.deleted === true ? { deleted: true } : {}),
    ...(item.completeness ? { completeness: item.completeness } : {}),
    ...(rangeId ? { rangeId } : {}),
  };
}

/** 单项失败也用同一传输协议交给摄取层：不影响其它条目，但整轮不完整。 */
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

/** 数据库来源类型共用一个实现；类型在构造时绑定，因为 sync 入参不含 type。 */
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
            // 超长 ID 无法导出 ZIP：不截断也不改写 ID，按单项失败交给摄取层。
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
        // 中间检查点一律 complete=false：还有 range 没读，不能据此推导删除。
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
