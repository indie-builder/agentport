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
  /** Deployment-trusted `host` or `host:port`; only these may resolve to private addresses. */
  trustedHosts?: readonly string[];
  /** Local fixtures only; validateSourceUrl still refuses loopback in production. */
  allowLoopback?: boolean;
};

export type SourceItem = {
  externalId: string;
  title: string;
  path: string;
  sourceUrl: string;
  content: string;
  /** 二进制原件；解析器按字节与 MIME 处理，文本来源不使用。 */
  bytes?: Uint8Array;
  mimeType: string;
  /** provider 的真实版本标识（如 last_edited_time）；没有可靠版本时留空，由字节哈希判断变化。 */
  revision?: string;
  deleted?: boolean;
  /** feed 是滚动窗口：全文抓取失败时只剩摘要，摄取层据此不许把已有全文降级。 */
  completeness?: 'full' | 'summary';
};

/** 单个外部条目的持久失败：不阻断其它条目，但本轮不能据此推导删除。 */
export type SourceFailure = {
  externalId: string;
  title: string;
  code: string;
  message: string;
  retryable: boolean;
};

export type SourceSnapshot = {
  items: SourceItem[];
  /** 单项失败/不支持：继续读其它条目，但整轮不能算完整枚举。 */
  failures?: SourceFailure[];
  cursor: Record<string, unknown>;
  /** False when the source cannot prove it listed everything (feeds roll items off). */
  complete: boolean;
};
