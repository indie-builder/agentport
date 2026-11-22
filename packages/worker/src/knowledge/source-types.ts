export type SourceConfig = {
  type:
    | 'rss'
    | 'gitlab'
    | 'github'
    | 'feishu'
    | 'notion'
    | 'confluence'
    | 'yuque'
    | 'dingtalk'
    | 'ima'
    | 'seafile'
    | 'nextcloud';
  url: string;
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
  trustedHosts?: readonly string[];
  allowLoopback?: boolean;
};

export type SourceItem = {
  externalId: string;
  title: string;
  path: string;
  sourceUrl: string;
  content: string;
  bytes?: Uint8Array;
  mimeType: string;
  revision?: string;
  deleted?: boolean;
  completeness?: 'full' | 'summary';
};

export type SourceFailure = {
  externalId: string;
  title: string;
  code: string;
  message: string;
  retryable: boolean;
};

export type SourceSnapshot = {
  items: SourceItem[];
  failures?: SourceFailure[];
  cursor: Record<string, unknown>;
  complete: boolean;
};
