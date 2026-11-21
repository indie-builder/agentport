import { readPluginMarkdown } from '@agentport/core/plugin-display';
import type { PluginFileInput, PluginWithAgentCount } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Resizable, ResizableHandle, ResizablePanel } from '@ui-sdk/react/resizable';
import {
  Bot,
  ChevronRight,
  Download,
  EllipsisVertical,
  Package,
  PanelLeftDashed,
  Plug,
  Terminal,
  Workflow,
  Wrench,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { BackLink } from '../../components/back-link.js';
import { CodeBlockCopyAllowed } from '../../components/code-block.js';
import { Collapsible, CollapsibleContent } from '../../components/motion-collapsible.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageSection,
  PageTopbar,
} from '../../components/page.js';
import {
  isPluginMarkdown,
  PluginDocument,
  pluginFileTitle,
} from '../../components/plugin/plugin-document.js';
import { PluginFileTree } from '../../components/plugin/plugin-file-tree.js';
import { ReaderToolbar } from '../../components/reader-toolbar.js';
import { RecordRows } from '../../components/record-rows.js';
import { ErrorState, InlineEmpty, LoadingState } from '../../components/states.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../../components/ui/breadcrumb.js';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { can } from '../../lib/access.js';
import { ApiError, errorMessage } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { formatDate } from '../../lib/format.js';
import { meQuery, usePlugin } from '../../lib/queries.js';
import { useMediaQuery } from '../../lib/use-media-query.js';

type Mode = 'read' | 'source';
type Tab = 'intro' | 'content';

/** 与 Tailwind 的 lg 断点一致：宽屏分栏，窄屏堆叠。 */
const WIDE = '(min-width: 64rem)';
const DETAIL_COLUMN = 'mx-auto w-full max-w-[960px]';
const FILES_PANEL_ID = 'plugin-detail-files-panel';

function rootReadme(files: PluginFileInput[]): PluginFileInput | undefined {
  return files.find((file) => /^readme\.md$/i.test(file.path));
}

function defaultFile(files: PluginFileInput[]): PluginFileInput | undefined {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return (
    rootReadme(files) ??
    sorted.find((file) => /^skills\/.+\/SKILL\.md$/.test(file.path)) ??
    sorted[0]
  );
}

function parseJsonObject(content: string | undefined) {
  if (content === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(content);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function mcpServerNames(servers: unknown) {
  return servers !== null && typeof servers === 'object' && !Array.isArray(servers)
    ? Object.keys(servers)
    : [];
}

function firstHeading(body: string): string | undefined {
  return /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body)?.[1]?.trim();
}

function readmeForPage(file: PluginFileInput, name: string): PluginFileInput {
  const parsed = readPluginMarkdown(file.content, pluginFileTitle(file.path));
  if (parsed.issue !== undefined) return file;
  const opening = /^(?:[ \t]*\r?\n)*[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/.exec(
    parsed.body,
  );
  if (opening?.[1]?.trim() !== name) return file;
  return { ...file, content: parsed.body.slice(opening[0].length) };
}

interface DetailSearch {
  tab: Tab;
  file?: string | undefined;
  mode?: Mode | undefined;
}

function detailSearch({ tab, file, mode }: DetailSearch): DetailSearch {
  return { tab, ...(file === undefined ? {} : { file }), ...(mode === undefined ? {} : { mode }) };
}

export function PluginDetailPage() {
  const { pluginId } = useParams({ from: '/_shell/plugins/$pluginId' });
  const search = useSearch({ from: '/_shell/plugins/$pluginId' });
  const plugin = usePlugin(pluginId);
  const navigate = useNavigate();

  if (!plugin.data) {
    const notFound = plugin.error instanceof ApiError && plugin.error.status === 404;
    return (
      <Page>
        <PageTopbar className={DETAIL_COLUMN}>
          <BackLink to="/plugins" label="返回插件列表" showLabel />
          <PageHeader title={notFound ? '插件不存在' : '插件详情'} />
        </PageTopbar>
        <PageBody className={DETAIL_COLUMN}>
          {plugin.isPending ? (
            <LoadingState rows={6} />
          ) : notFound ? (
            <PageNote tone="danger" title="这个插件不在了" description="它可能已被删除。" />
          ) : (
            <ErrorState error={plugin.error} onRetry={() => void plugin.refetch()} />
          )}
        </PageBody>
      </Page>
    );
  }

  return (
    <PluginDetailContent
      plugin={plugin.data}
      tab={search.tab ?? 'intro'}
      file={search.file}
      mode={search.mode}
      onNavigate={(next) => {
        void navigate({
          to: '/plugins/$pluginId',
          params: { pluginId },
          search: detailSearch(next),
          resetScroll: false,
        });
      }}
      refetchError={plugin.isRefetchError ? plugin.error : null}
      onRetry={() => void plugin.refetch()}
    />
  );
}

function PluginDetailContent({
  plugin,
  tab,
  file,
  mode,
  onNavigate,
  refetchError,
  onRetry,
}: {
  plugin: PluginWithAgentCount;
  tab: Tab;
  file: string | undefined;
  mode: Mode | undefined;
  onNavigate: (next: DetailSearch) => void;
  refetchError: unknown;
  onRetry: () => void;
}) {
  const me = useQuery(meQuery);
  const canExport = can(me.data, 'plugins.export');
  const { capabilities, files } = plugin;
  const hasFiles = files.length > 0;
  const activeTab = hasFiles ? tab : 'intro';
  const filesTab = useRef<HTMLButtonElement>(null);
  const [introVisited, setIntroVisited] = useState(activeTab === 'intro');
  if (activeTab === 'intro' && !introVisited) setIntroVisited(true);
  const [contentVisited, setContentVisited] = useState(activeTab === 'content');
  if (activeTab === 'content' && !contentVisited) setContentVisited(true);

  const capabilityGroups = useMemo(() => {
    const skills = capabilities.skills.map((name) => {
      const item = files.find((file) => file.path === `skills/${name}/SKILL.md`);
      return {
        name,
        path: item?.path,
        description: item && readPluginMarkdown(item.content, name).description,
      };
    });
    const commands = files
      .filter((item) => /^commands\/[^/]+\.md$/i.test(item.path))
      .map((item) => {
        const name = pluginFileTitle(item.path);
        const parsed = readPluginMarkdown(item.content, name);
        return {
          name,
          path: item.path,
          description: parsed.description || firstHeading(parsed.body),
        };
      });
    const agents = capabilities.agents.map((name) => {
      const item = files.find((file) => file.path === `agents/${name}.md`);
      return {
        name,
        path: item?.path,
        description: item && readPluginMarkdown(item.content, name).description,
      };
    });
    const manifestFile = files.find((file) => file.path === '.claude-plugin/plugin.json');
    const manifest = parseJsonObject(manifestFile?.content);
    const hooksFile = files.find((file) => file.path === 'hooks/hooks.json');
    const hooks = [
      ...(hooksFile ? [{ name: 'hooks.json', path: hooksFile.path, description: '钩子配置' }] : []),
      ...(manifest?.hooks !== undefined
        ? [{ name: 'plugin.json', path: manifestFile?.path, description: '内联钩子' }]
        : []),
    ];
    if (capabilities.hasHooks && hooks.length === 0) {
      hooks.push({ name: '钩子', path: undefined, description: '钩子配置' });
    }
    const mcpFile = files.find((file) => file.path === '.mcp.json');
    const mcp = parseJsonObject(mcpFile?.content);
    const mcpServers = mcpServerNames(mcp?.mcpServers ?? mcp);
    const inlineMcpServers = mcpServerNames(manifest?.mcpServers);
    return [
      { title: '技能', icon: Wrench, rows: skills },
      { title: '命令', icon: Terminal, rows: commands },
      { title: '代理', icon: Bot, rows: agents },
      { title: '钩子', icon: Workflow, rows: hooks },
      {
        title: 'MCP',
        icon: Plug,
        rows: capabilities.mcpServers.map((name) => ({
          name,
          path: mcpServers.includes(name)
            ? mcpFile?.path
            : inlineMcpServers.includes(name)
              ? manifestFile?.path
              : undefined,
          description: 'MCP 服务',
        })),
      },
    ].filter((group) => group.rows.length > 0);
  }, [capabilities, files]);
  const executableCount = files.filter((item) => item.executable).length;
  const mcpCount = capabilities.mcpServers.length;
  const readme = rootReadme(files);

  const selectFile = (path: string): void => {
    onNavigate({ tab: 'content', file: path });
  };
  const openFileFromOverview = (path: string): void => {
    filesTab.current?.focus();
    selectFile(path);
  };
  const selectMode = (next: Mode): void => {
    const path =
      plugin.files.find((item) => item.path === file)?.path ?? defaultFile(plugin.files)?.path;
    if (path !== undefined) onNavigate({ tab: 'content', file: path, mode: next });
  };
  const changeTab = (next: Tab): void => {
    if (next === 'intro') {
      onNavigate({ tab: 'intro', file, mode });
      return;
    }
    onNavigate({ tab: 'content', file: file ?? defaultFile(plugin.files)?.path, mode });
  };

  const description = plugin.description.trim() ? plugin.description : '';
  const subtitle = description ? `${plugin.slug} · ${description}` : plugin.slug;

  return (
    <Page>
      <Tabs<Tab>
        value={activeTab}
        onValueChange={changeTab}
        className="min-h-0 min-w-0 flex-1 gap-4"
      >
        <PageTopbar className={DETAIL_COLUMN}>
          <BackLink to="/plugins" label="返回插件列表" showLabel />
          <PageHeader
            leading={
              <div className="grid size-11 place-items-center rounded-lg border bg-surface text-fg">
                <Package aria-hidden="true" />
              </div>
            }
            title={plugin.name}
            eyebrow={plugin.version ? <Badge variant="outline">{plugin.version}</Badge> : null}
            subtitle={<span title={subtitle}>{subtitle}</span>}
            actions={
              canExport ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="ghost" size="icon" aria-label="更多操作">
                        <EllipsisVertical aria-hidden="true" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" sideOffset={4} className="w-44">
                    <DropdownMenuItem render={<a href={`/api/plugins/${plugin.id}/export`} />}>
                      <Download />
                      导出 ZIP
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : undefined
            }
          />
          <div className="border-b">
            <TabsList variant="line" aria-label="插件视图">
              <TabsTrigger value="intro">概览</TabsTrigger>
              {hasFiles ? (
                <TabsTrigger ref={filesTab} value="content">
                  文件{' '}
                  <span className="text-xs tabular-nums text-muted-foreground">{files.length}</span>
                </TabsTrigger>
              ) : null}
            </TabsList>
          </div>
          {refetchError ? (
            <PageNote
              tone="danger"
              title="刷新失败，已保留加载的内容"
              description={errorMessage(refetchError)}
              action={
                <Button variant="outline" size="sm" onClick={onRetry}>
                  重试
                </Button>
              }
            />
          ) : null}
        </PageTopbar>
        <PageBody className={`${DETAIL_COLUMN} gap-0 overflow-hidden`}>
          <TabsContent
            value="intro"
            keepMounted
            className="@container min-h-0 flex-1 overflow-y-auto"
          >
            {introVisited ? (
              <div className="grid grid-cols-1 items-start gap-10 pb-4 @4xl:grid-cols-[minmax(0,1fr)_280px]">
                <div className="flex min-w-0 flex-col gap-6">
                  {description ? (
                    <p className="max-w-[68ch] whitespace-pre-wrap break-words text-sm">
                      {description}
                    </p>
                  ) : null}
                  {capabilityGroups.length > 0 ? (
                    capabilityGroups.map(({ title, icon: Icon, rows }) => (
                      <PageSection key={title} title={title} divided={false} className="gap-2">
                        <ul className="overflow-hidden rounded-lg border divide-y">
                          {rows.map(({ name, description: summary, path }) => {
                            const Row = path === undefined ? 'div' : 'button';
                            return (
                              <li key={path === undefined ? name : `${name}:${path}`}>
                                <Row
                                  {...(path === undefined
                                    ? {}
                                    : {
                                        type: 'button' as const,
                                        onClick: () => openFileFromOverview(path),
                                      })}
                                  className={cn(
                                    'grid min-h-11 w-full min-w-0 grid-cols-[auto_minmax(0,150px)_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 text-left',
                                    path !== undefined &&
                                      'transition-colors duration-150 ease-out-soft hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                                  )}
                                >
                                  <Icon className="size-4" aria-hidden="true" />
                                  <span className="truncate font-medium" title={name}>
                                    {name}
                                  </span>
                                  <span className="truncate text-muted-foreground" title={summary}>
                                    {summary}
                                  </span>
                                  <ChevronRight
                                    className={
                                      path === undefined
                                        ? 'invisible size-4'
                                        : 'size-4 text-muted-foreground'
                                    }
                                    aria-hidden="true"
                                  />
                                </Row>
                              </li>
                            );
                          })}
                        </ul>
                      </PageSection>
                    ))
                  ) : (
                    <p className="text-muted-foreground">
                      未检测到技能、命令、代理、钩子或 MCP 服务。
                    </p>
                  )}
                  {readme ? (
                    <PageSection title="说明" divided={false}>
                      <PluginDocument
                        file={readmeForPage(readme, plugin.name)}
                        mode="read"
                        files={files}
                        onSelectFile={openFileFromOverview}
                      />
                    </PageSection>
                  ) : null}
                </div>
                <aside aria-label="插件信息" className="flex min-w-0 max-w-[320px] flex-col gap-6">
                  <PageSection
                    title="包含"
                    titleClassName="text-xs font-normal text-muted-foreground"
                    divided={false}
                    className="gap-2"
                  >
                    <RecordRows
                      rows={[
                        ...capabilityGroups.map(({ title, rows }) => ({
                          label: title,
                          value: rows.length,
                        })),
                        { label: '文件', value: files.length },
                        { label: '关联专家', value: plugin.agentCount },
                      ]}
                    />
                  </PageSection>
                  <PageSection
                    title="来源"
                    titleClassName="text-xs font-normal text-muted-foreground"
                    divided={false}
                    className="gap-2"
                  >
                    <RecordRows
                      rows={[
                        plugin.sourceId
                          ? { label: '市场来源', value: plugin.sourceId }
                          : { label: '导入方式', value: '本地 ZIP 导入' },
                        { label: '运行时名', value: plugin.runtimeName, mono: true },
                      ]}
                    />
                  </PageSection>
                  <PageSection
                    title="版本"
                    titleClassName="text-xs font-normal text-muted-foreground"
                    divided={false}
                    className="gap-2"
                  >
                    <RecordRows
                      rows={[
                        { label: '版本号', value: plugin.version || '未标注' },
                        { label: '更新于', value: formatDate(plugin.updatedAt) },
                        { label: '导入于', value: formatDate(plugin.createdAt) },
                      ]}
                    />
                  </PageSection>
                  <PageSection
                    title="标识"
                    titleClassName="text-xs font-normal text-muted-foreground"
                    divided={false}
                    className="gap-2"
                  >
                    <RecordRows rows={[{ label: 'slug', value: plugin.slug, mono: true }]} />
                  </PageSection>
                  {capabilities.hasHooks || executableCount > 0 || mcpCount > 0 ? (
                    <PageSection
                      title="运行影响"
                      titleClassName="text-xs font-normal text-muted-foreground"
                      divided={false}
                      className="gap-2"
                    >
                      <div className="flex flex-wrap gap-2">
                        {capabilities.hasHooks ? <Badge>包含钩子</Badge> : null}
                        {executableCount > 0 ? (
                          <Badge>可执行文件 {executableCount} 个</Badge>
                        ) : null}
                        {mcpCount > 0 ? <Badge>MCP {mcpCount} 个</Badge> : null}
                      </div>
                    </PageSection>
                  ) : null}
                </aside>
              </div>
            ) : null}
          </TabsContent>

          {hasFiles ? (
            <TabsContent value="content" keepMounted className="min-h-0 flex-1 overflow-hidden">
              {contentVisited ? (
                <PluginContent
                  files={files}
                  file={file}
                  mode={mode ?? 'read'}
                  onSelectFile={selectFile}
                  onSelectMode={selectMode}
                />
              ) : null}
            </TabsContent>
          ) : null}
        </PageBody>
      </Tabs>
    </Page>
  );
}

function PluginContent({
  files,
  file,
  mode,
  onSelectFile,
  onSelectMode,
}: {
  files: PluginFileInput[];
  file: string | undefined;
  mode: Mode;
  onSelectFile: (path: string) => void;
  onSelectMode: (mode: Mode) => void;
}) {
  const wide = useMediaQuery(WIDE);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesOpenWide, setFilesOpenWide] = useState(true);
  const open = wide ? filesOpenWide : filesOpen;
  const filesButton = useRef<HTMLButtonElement>(null);
  const filesPane = useRef<HTMLDivElement>(null);
  const focusFilesOnOpen = useRef(false);
  const docScroll = useRef<HTMLDivElement>(null);

  const requested = file === undefined ? undefined : files.find((item) => item.path === file);
  const stale = file !== undefined && requested === undefined;
  const selected = requested ?? defaultFile(files);
  const selectedPath = selected?.path;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 换文件（路径变化）才回顶部；只切阅读/源码时保留阅读位置。
  useEffect(() => {
    const scroller = docScroll.current;
    if (scroller !== null) scroller.scrollTop = 0;
  }, [selectedPath]);

  useEffect(() => {
    if (!open || !focusFilesOnOpen.current) return;
    focusFilesOnOpen.current = false;
    let attempts = 0;
    const focusCurrentFile = () => {
      const pane = filesPane.current;
      const current = pane?.querySelector<HTMLElement>('[aria-current="page"]');
      if (current) {
        current.focus();
        return;
      }
      attempts += 1;
      if (attempts < 6) {
        timer = setTimeout(focusCurrentFile, 16);
        return;
      }
      const fallback =
        pane?.querySelector<HTMLElement>('[role="treeitem"]') ??
        pane?.querySelector<HTMLElement>('[role="tree"]');
      fallback?.focus();
    };
    let timer = setTimeout(focusCurrentFile, 16);
    return () => clearTimeout(timer);
  }, [open]);

  if (selected === undefined) return <InlineEmpty>没有可查看的文件。</InlineEmpty>;

  const toggleLabel = open ? '收起文件列表' : '展开文件列表';
  const documentPane = (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="max-w-[75ch] shrink-0 ps-4 pb-4">
        <ReaderToolbar
          identity={
            <Breadcrumb aria-label="文件路径">
              <BreadcrumbList className="gap-1 text-xs">
                {selected.path.split('/').map((segment, index, segments) => (
                  <Fragment key={segments.slice(0, index + 1).join('/')}>
                    {index > 0 ? <BreadcrumbSeparator /> : null}
                    <BreadcrumbItem className="min-w-0 break-all">
                      {index === segments.length - 1 ? (
                        <BreadcrumbPage className="break-all">{segment}</BreadcrumbPage>
                      ) : (
                        <span className="break-all text-muted-foreground">{segment}</span>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
          }
          {...(selected.executable ? { meta: <Badge variant="outline">可执行</Badge> } : {})}
          {...(isPluginMarkdown(selected.path) ? { mode, onModeChange: onSelectMode } : {})}
          copy={{ value: selected.content, label: `复制 ${selected.path}` }}
          actions={
            <Button
              ref={filesButton}
              variant="ghost"
              size="icon"
              aria-label={toggleLabel}
              title={toggleLabel}
              aria-expanded={open}
              aria-controls={FILES_PANEL_ID}
              onClick={(event) => {
                if (open) event.currentTarget.focus();
                else focusFilesOnOpen.current = event.detail === 0;
                if (wide) setFilesOpenWide(!open);
                else setFilesOpen(!open);
              }}
              className="text-muted-foreground hover:text-fg"
            >
              <PanelLeftDashed aria-hidden="true" />
            </Button>
          }
        />
      </div>
      <div
        ref={docScroll}
        data-slot="plugin-content-scroll"
        className="min-h-0 flex-1 overflow-y-auto ps-4 pb-4"
      >
        <div className="flex min-w-0 max-w-[75ch] flex-col gap-4">
          {stale ? (
            <PageNote title="找不到这个文件" description={`插件里没有 ${file}，已显示默认文件。`} />
          ) : null}

          <CodeBlockCopyAllowed.Provider value={false}>
            <PluginDocument file={selected} mode={mode} files={files} onSelectFile={onSelectFile} />
          </CodeBlockCopyAllowed.Provider>
        </div>
      </div>
    </div>
  );
  const fileTree = (
    <PluginFileTree
      files={files}
      selectedPath={selected.path}
      onSelect={(path) => {
        if (!wide) {
          setFilesOpen(false);
          filesButton.current?.focus();
        }
        onSelectFile(path);
      }}
      idPrefix="plugin-detail-files"
    />
  );

  return wide ? (
    <div className="flex h-full min-h-0 flex-col">
      {!open ? <div id={FILES_PANEL_ID} hidden /> : null}
      <Resizable
        orientation="horizontal"
        autoSaveId="plugin-detail-content"
        className="min-h-0 flex-1"
      >
        {open ? (
          <ResizablePanel
            id="files"
            defaultSize="240px"
            minSize="180px"
            maxSize="360px"
            className="min-h-0"
          >
            <div
              ref={filesPane}
              id={FILES_PANEL_ID}
              className="h-full min-h-0 overflow-y-auto pb-4 pe-4"
            >
              {fileTree}
            </div>
          </ResizablePanel>
        ) : null}
        {open ? <ResizableHandle className="w-px border-r" aria-label="调整文件树宽度" /> : null}
        <ResizablePanel id="document" minSize="320px" className="min-h-0">
          {documentPane}
        </ResizablePanel>
      </Resizable>
    </div>
  ) : (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={filesPane} id={FILES_PANEL_ID} className="shrink-0">
        <Collapsible open={filesOpen} onOpenChange={setFilesOpen}>
          <CollapsibleContent animated>
            <div className="max-h-[40vh] overflow-y-auto border-b py-2">{fileTree}</div>
          </CollapsibleContent>
        </Collapsible>
      </div>
      {documentPane}
    </div>
  );
}
