import type { ConnectorNetwork, KnowledgeConnector, SourceItem } from './ingestion.js';
import { type SourceItem as LeafSourceItem, readSource, type SourceConfig } from './sources.js';

/**
 * 把 sources.ts 的「读一次快照」适配成 ingestion 的连接器协议。
 *
 * 一个 range 就是一次独立读取：各自有游标、各自证明是否完整枚举。
 * 全部 range 都读完才把 complete 汇总上报，摄取层只在这时推导删除。
 * 数据来源：feed 每个 range 是一个订阅地址；gitlab/github 每个 range 是一个 repo/ref；
 * 飞书 wiki 每个 range 是一个 space 或 node；drive 每个 range 是一个 folder。
 */

type RangeInput = { kind: string; externalId: string; ref: string | null; paths: string[] };

/** 游标按 range 分开存，同一个来源内增删 range 不会互相覆盖。 */
function rangeKey(type: string, range: RangeInput): string {
  const parts = [type, range.kind, range.externalId, range.ref ?? ''];
  // gitlab/github 的 paths 是范围的一部分：缩小 paths 后不能沿用旧游标误判完整。
  if (type === 'gitlab' || type === 'github') parts.push(range.paths.join(','));
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
    default:
      throw new Error(`不支持的来源类型 ${type}`);
  }
}

function toItem(item: LeafSourceItem, connectionId: string): SourceItem {
  return {
    // 同一外部 ID 可能出现在两个同 base 的连接里；sourceId 带上连接 ID 才不会互相覆盖。
    sourceId: `${connectionId}:${item.externalId}`,
    sourceUrl: item.sourceUrl || null,
    sourcePath: item.path || null,
    title: item.title,
    mimeType: item.mimeType,
    // 快照按 externalId 判等即可：内容是否更新由摄取层按内容哈希决定。
    revision: item.externalId,
    content: { markdown: item.content },
    ...(item.deleted === true ? { deleted: true } : {}),
  };
}

/** 四种数据库来源类型共用一个实现；类型在构造时绑定，因为 sync 入参不含 type。 */
function createConnector(type: string): KnowledgeConnector {
  return {
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
        complete &&= snapshot.complete;
        for (const item of snapshot.items) yield toItem(item, input.connectionId);
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
  gitlab: createConnector('gitlab'),
  github: createConnector('github'),
  feed: createConnector('feed'),
} satisfies Record<string, KnowledgeConnector>;
