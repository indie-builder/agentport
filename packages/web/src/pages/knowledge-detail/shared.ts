import type { KnowledgeSourceInput } from '@agentport/shared';
import {
  BookMarked,
  BookOpen,
  CircleHelp,
  Cloud,
  Code,
  Feather,
  FolderArchive,
  GitFork,
  LibraryBig,
  MessageSquare,
  NotebookText,
  Rss,
} from 'lucide-react';
import type { KnowledgeSource } from '../../lib/api.js';

/** 按叶权限控制每个主操作、行菜单与子编辑器；展示与否只由这里决定。 */
export type KnowledgeCaps = {
  content: boolean;
  sources: boolean;
  execute: boolean;
  publish: boolean;
  update: boolean;
  import: boolean;
  export: boolean;
};

/** 来源类型以 shared 的输入契约为准，与 api.ts 的 wire 类型保持一致。 */
export type SourceType = KnowledgeSourceInput['type'];

export const sourceProviders: Array<{
  type: SourceType;
  label: string;
  description: string;
  icon: typeof Code;
}> = [
  {
    type: 'github',
    label: 'GitHub',
    description: '读取仓库指定分支与路径下的文本文件',
    icon: Code,
  },
  {
    type: 'gitlab',
    label: 'GitLab',
    description: '读取项目指定分支与路径下的文本文件',
    icon: GitFork,
  },
  {
    type: 'feishu_wiki',
    label: '飞书知识库',
    description: '同步知识空间或知识节点下的文档',
    icon: BookOpen,
  },
  {
    type: 'feishu_drive',
    label: '飞书云盘',
    description: '同步云盘目录中的文件',
    icon: Cloud,
  },
  {
    type: 'lark_wiki',
    label: 'Lark 知识库',
    description: '使用 Lark 应用同步知识空间或知识节点',
    icon: BookOpen,
  },
  {
    type: 'lark_drive',
    label: 'Lark 云盘',
    description: '使用 Lark 应用同步云盘目录中的文件',
    icon: Cloud,
  },
  { type: 'notion', label: 'Notion', description: '同步页面、数据库与数据源', icon: NotebookText },
  {
    type: 'confluence',
    label: 'Confluence',
    description: '同步空间或页面及附件',
    icon: BookMarked,
  },
  { type: 'yuque', label: '语雀', description: '同步知识库文档', icon: Feather },
  {
    type: 'dingtalk',
    label: '钉钉',
    description: '同步知识空间或节点文档',
    icon: MessageSquare,
  },
  { type: 'ima', label: 'IMA', description: '同步指定知识库的媒体与笔记', icon: LibraryBig },
  {
    type: 'seafile',
    label: 'Seafile',
    description: '同步 Seafile 11+ 库内目录文件',
    icon: FolderArchive,
  },
  { type: 'nextcloud', label: 'Nextcloud', description: '同步账号目录文件', icon: Cloud },
  { type: 'feed', label: 'RSS', description: '抓取 Feed 最近窗口内的条目', icon: Rss },
];

/** 未知类型显式标注，不回落到某个具体 provider 误导用户。 */
export function sourceProvider(type: SourceType): (typeof sourceProviders)[number] {
  return (
    sourceProviders.find((provider) => provider.type === type) ?? {
      type,
      label: '未知来源',
      description: '当前界面不支持这个来源类型',
      icon: CircleHelp,
    }
  );
}

export type AuthMode = 'cloud_basic' | 'cloud_scoped' | 'dc_pat';

export const authModeOptions: Array<{ value: AuthMode; label: string }> = [
  { value: 'cloud_basic', label: 'Cloud Basic' },
  { value: 'cloud_scoped', label: 'Cloud Scoped' },
  { value: 'dc_pat', label: 'Data Center PAT' },
];

export function isAuthMode(value: unknown): value is AuthMode {
  return value === 'cloud_basic' || value === 'cloud_scoped' || value === 'dc_pat';
}

type CredentialKey =
  | 'token'
  | 'appSecret'
  | 'apiKey'
  | 'apiToken'
  | 'pat'
  | 'clientSecret'
  | 'appPassword';

/** 凭证只写不读：留空提交不发 secrets，避免把已存密钥覆盖成空串。 */
export function credentialField(
  type: SourceType,
  authMode: AuthMode,
): { key: CredentialKey; label: string; description?: string } | null {
  switch (type) {
    case 'github':
    case 'gitlab':
      return { key: 'token', label: 'Access Token' };
    case 'feishu_wiki':
    case 'feishu_drive':
    case 'lark_wiki':
    case 'lark_drive':
      return { key: 'appSecret', label: 'App Secret' };
    case 'notion':
      return { key: 'apiKey', label: 'Integration Token' };
    case 'confluence':
      return authMode === 'dc_pat'
        ? { key: 'pat', label: 'Personal Access Token' }
        : { key: 'apiToken', label: 'API Token' };
    case 'yuque':
      return { key: 'apiToken', label: 'Token', description: 'Token 权益以语雀账号为准。' };
    case 'dingtalk':
      return { key: 'clientSecret', label: 'Client Secret' };
    case 'ima':
      return { key: 'apiKey', label: 'API Key' };
    case 'seafile':
      return { key: 'apiToken', label: 'API Token' };
    case 'nextcloud':
      return { key: 'appPassword', label: 'App 密码' };
    default:
      return null;
  }
}

export type SourceFieldKey =
  | 'appId'
  | 'baseUrl'
  | 'email'
  | 'cloudId'
  | 'username'
  | 'operatorUnionId'
  | 'clientId';
export type SourceFieldState = Record<SourceFieldKey, string>;

export const emptySourceFields: SourceFieldState = {
  appId: '',
  baseUrl: '',
  email: '',
  cloudId: '',
  username: '',
  operatorUnionId: '',
  clientId: '',
};

type SourceFieldSpec = {
  key: SourceFieldKey;
  label: string;
  /** 连接身份字段：创建后不可改，编辑时只读，避免旧凭证被带到新站点。 */
  identity?: boolean;
  required?: boolean | ((authMode: AuthMode) => boolean);
  /** 仅在该认证模式显示（Confluence 条件字段）。 */
  visible?: (authMode: AuthMode) => boolean;
  placeholder?: string;
};

/** 新增来源的连接字段集中在这里，按类型渲染，不为每个 provider 复制一套表单。 */
export const sourceFieldSpecs: Partial<Record<SourceType, SourceFieldSpec[]>> = {
  lark_wiki: [{ key: 'appId', label: 'App ID', identity: true }],
  lark_drive: [{ key: 'appId', label: 'App ID', identity: true }],
  confluence: [
    {
      key: 'baseUrl',
      label: '站点 URL',
      identity: true,
      placeholder: 'https://example.atlassian.net',
    },
    {
      key: 'email',
      label: 'Email',
      identity: true,
      required: (mode) => mode !== 'dc_pat',
      visible: (mode) => mode !== 'dc_pat',
    },
    {
      key: 'cloudId',
      label: 'Cloud ID',
      identity: true,
      required: (mode) => mode === 'cloud_scoped',
      visible: (mode) => mode === 'cloud_scoped',
    },
  ],
  dingtalk: [
    { key: 'clientId', label: 'Client ID', identity: true },
    { key: 'operatorUnionId', label: '操作者 Union ID', identity: true },
  ],
  ima: [{ key: 'clientId', label: 'Client ID', identity: true }],
  seafile: [
    {
      key: 'baseUrl',
      label: '实例 URL',
      identity: true,
      placeholder: 'https://seafile.example.com',
    },
  ],
  nextcloud: [
    {
      key: 'baseUrl',
      label: '实例 URL',
      identity: true,
      placeholder: 'https://cloud.example.com',
    },
    { key: 'username', label: '用户名', identity: true },
  ],
};

export function sourceFieldRequired(spec: SourceFieldSpec, authMode: AuthMode): boolean {
  return typeof spec.required === 'function' ? spec.required(authMode) : (spec.required ?? true);
}

export function sourceFieldId(key: SourceFieldKey): string {
  return `source-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** Seafile 只有精确的 / 表示全库；其余输入按库内相对目录保存。 */
function normalizeSeafilePaths(paths: string[]): string[] {
  if (paths.some((path) => path.trim() === '/')) return [];
  return paths.map((path) => path.trim().replace(/^\/+|\/+$/g, ''));
}

function seafilePathInvalid(paths: string[]): boolean {
  return paths.some(
    (path) => /[\\\0]/.test(path) || path.split('/').some((segment) => segment === '..'),
  );
}

/**
 * //、/// 或空串 normalize 后为空；它们不是全库，必须按字段错误拦下，
 * 否则过滤成空数组会被后端当成全库而静默放大同步范围。
 */
export function seafilePathIssue(paths: string[]): string | null {
  if (paths.some((path) => path.trim() === '/')) return null;
  if (paths.length === 0 || paths.some((path) => path.trim().replace(/^\/+|\/+$/g, '') === '')) {
    return '每个 Seafile 范围都需要目录根；全库请填 /';
  }
  if (paths.some((path) => seafilePathInvalid([path]))) {
    return 'Seafile 路径不能包含反斜杠或 ..';
  }
  return null;
}

/** clientId 只用于列表 key；已有范围沿用服务端 id，保证 key 稳定、删行不串焦点。 */
export type RangeKind = KnowledgeSourceInput['ranges'][number]['kind'];
export type RangeDraft = Omit<KnowledgeSourceInput['ranges'][number], 'kind'> & {
  clientId: string;
  kind: RangeKind;
};

/** 提交前去掉 clientId，不把本地 key 混进来源 config。 */
export function toRangeInput({ clientId: _clientId, ...range }: RangeDraft) {
  return {
    ...range,
    externalId: range.externalId.trim(),
    paths: range.kind === 'seafile_repo' ? normalizeSeafilePaths(range.paths) : range.paths,
  };
}

export const rangeKinds: Record<SourceType, RangeKind[]> = {
  github: ['github_repo'],
  feishu_wiki: ['wiki_space', 'wiki_node'],
  feishu_drive: ['drive_folder'],
  lark_wiki: ['wiki_space', 'wiki_node'],
  lark_drive: ['drive_folder'],
  notion: ['notion_page', 'notion_database', 'notion_data_source'],
  confluence: ['confluence_space', 'confluence_page'],
  yuque: ['yuque_repo'],
  dingtalk: ['dingtalk_workspace', 'dingtalk_node'],
  ima: ['ima_kb'],
  seafile: ['seafile_repo'],
  nextcloud: ['nextcloud_path'],
  gitlab: ['gitlab_project'],
  feed: ['feed'],
};

export const rangeKindLabel: Record<RangeKind, string> = {
  wiki_space: '知识空间',
  wiki_node: '知识节点',
  drive_folder: '云盘目录',
  gitlab_project: 'GitLab 项目',
  github_repo: '仓库',
  feed: 'Feed',
  notion_page: '页面',
  notion_database: '数据库',
  notion_data_source: '数据源',
  confluence_space: '空间',
  confluence_page: '页面',
  yuque_repo: '知识库',
  dingtalk_workspace: '知识空间',
  dingtalk_node: '节点',
  ima_kb: '知识库',
  seafile_repo: '知识库',
  nextcloud_path: '目录',
};

export function rangeExternalLabel(kind: RangeKind): string {
  return {
    wiki_space: '空间 ID',
    wiki_node: '节点 Token',
    drive_folder: '目录 Token',
    gitlab_project: 'Project ID',
    github_repo: '仓库',
    feed: 'Feed 地址',
    notion_page: '页面 UUID',
    notion_database: '数据库 UUID',
    notion_data_source: '数据源 UUID',
    confluence_space: '空间 ID',
    confluence_page: '页面 ID',
    yuque_repo: '知识库 ID',
    dingtalk_workspace: '知识空间 ID',
    dingtalk_node: '节点 ID',
    ima_kb: '知识库 ID',
    seafile_repo: '库 ID',
    nextcloud_path: '目录路径',
  }[kind];
}

/** 空范围行；clientId 在创建时生成一次，后续 render 不变。 */
export function newRangeDraft(kind: RangeKind): RangeDraft {
  return {
    clientId: crypto.randomUUID(),
    kind,
    externalId: '',
    ref: null,
    // Seafile 新行显式以 / 表示全库；清空输入不被当成全库。
    paths: kind === 'seafile_repo' ? ['/'] : [],
    enabled: true,
  };
}

/** 至少一个范围，且至少一个启用；空行也算缺 ID。 */
export function rangeIssue(type: SourceType, ranges: RangeDraft[]): string | null {
  if (ranges.length === 0) return '至少需要一个范围';
  if (ranges.some((range) => range.externalId.trim() === '')) return '每个范围都需要外部 ID';
  // GitLab 的来源级 config.ref 由范围回填；空 ref 会静默改到默认分支。
  if (type === 'gitlab' && ranges.some((range) => !range.ref?.trim())) {
    return '每个 GitLab 范围都需要 Ref';
  }
  if (type === 'yuque' && ranges.some((range) => !/^[1-9]\d*$/.test(range.externalId.trim()))) {
    return '语雀知识库 ID 需为正整数';
  }
  if (type === 'nextcloud' && ranges.some((range) => !range.externalId.trim().startsWith('/'))) {
    return 'Nextcloud 目录路径需以 / 开头';
  }
  if (type === 'seafile') {
    const pathIssue = ranges
      .map((range) => seafilePathIssue(range.paths))
      .find((value) => value !== null);
    if (pathIssue) return pathIssue;
  }
  if (!ranges.some((range) => range.enabled)) return '至少需要一个启用的范围';
  return null;
}

/** 来源弹层的草稿签名：关闭确认只比较真实字段，不依赖输入框注册顺序。 */
export function sourceDraftSignature(input: {
  type: SourceType;
  name: string;
  secret: string;
  fields: SourceFieldState;
  authMode: AuthMode;
  cron: string;
  syncDeletions: boolean;
  status: KnowledgeSource['status'];
  ranges: RangeDraft[];
}): string {
  return JSON.stringify(input);
}

/** 列表行的目标摘要：仓库@ref / 来源范围 / Feed，并带上 cron。 */
export function sourceTargetSummary(source: KnowledgeSource): string {
  const summary = source.ranges
    .map((range) => {
      const kind = range.kind as RangeKind;
      if (kind === 'github_repo') return `${range.externalId}@${range.ref ?? '默认分支'}`;
      if (kind === 'gitlab_project') {
        return range.ref ? `${range.externalId}@${range.ref}` : range.externalId;
      }
      if (kind === 'seafile_repo') {
        return `${range.externalId}:${range.paths.join(', ') || '/'}`;
      }
      return `${rangeKindLabel[kind]} ${range.externalId}`;
    })
    .join(' · ');
  return source.syncCron ? `${summary} · cron ${source.syncCron}` : summary;
}

/** 已有来源的 config 只读展示：缺省或非字符串一律按空值处理。 */
export function configString(source: KnowledgeSource | undefined, key: string): string {
  const value = source?.config[key];
  return typeof value === 'string' ? value : '';
}
