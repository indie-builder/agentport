import { readPluginMarkdown } from '@agentport/core/plugin-display';
import type { Plugin, PluginFileInput } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Resizable, ResizableHandle, ResizablePanel } from '@ui-sdk/react/resizable';
import { ArrowLeft, Download, FolderOpen, PanelLeftDashed } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { BusinessIllustration } from '../../components/business-illustration.js';
import { CodeBlockCopyAllowed } from '../../components/code-block.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/motion-collapsible.js';
import { Page, PageBody, PageHeader, PageNote, PageTopbar } from '../../components/page.js';
import {
  isPluginMarkdown,
  PluginDocument,
  pluginFileTitle,
} from '../../components/plugin/plugin-document.js';
import { PluginFileTree } from '../../components/plugin/plugin-file-tree.js';
import { ReaderToolbar } from '../../components/reader-toolbar.js';
import { EmptyState, ErrorState, InlineEmpty, LoadingState } from '../../components/states.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../../components/ui/breadcrumb.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { can } from '../../lib/access.js';
import { ApiError } from '../../lib/api.js';
import { meQuery, usePlugin } from '../../lib/queries.js';
import { useMediaQuery } from '../../lib/use-media-query.js';

type Mode = 'read' | 'source';
type Tab = 'intro' | 'content';

/** 与 Tailwind 的 lg 断点一致：宽屏分栏，窄屏堆叠。 */
const WIDE = '(min-width: 64rem)';

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

  if (plugin.isPending) {
    return (
      <Page>
        <PageTopbar>
          <PageHeader title="插件详情" />
        </PageTopbar>
        <PageBody>
          <LoadingState rows={6} />
        </PageBody>
      </Page>
    );
  }

  if (!plugin.data) {
    if (plugin.error instanceof ApiError && plugin.error.status === 404) {
      return (
        <Page>
          <PageTopbar>
            <PageHeader title="插件不存在" />
          </PageTopbar>
          <PageBody>
            <PageNote
              tone="danger"
              title="这个插件不在了"
              description="它可能已被删除。返回插件列表查看当前可用的插件。"
              action={
                <Link to="/plugins" className={buttonVariants({ variant: 'outline' })}>
                  返回插件列表
                </Link>
              }
            />
          </PageBody>
        </Page>
      );
    }
    return (
      <Page>
        <PageTopbar>
          <PageHeader title="插件详情" />
        </PageTopbar>
        <PageBody>
          <ErrorState error={plugin.error} onRetry={() => void plugin.refetch()} />
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
  plugin: Plugin;
  tab: Tab;
  file: string | undefined;
  mode: Mode | undefined;
  onNavigate: (next: DetailSearch) => void;
  refetchError: unknown;
  onRetry: () => void;
}) {
  const me = useQuery(meQuery);
  const canExport = can(me.data, 'plugins.export');
  const readme = rootReadme(plugin.files);
  const description = plugin.description ? (
    <p className="min-w-0 max-w-[75ch] whitespace-pre-wrap break-words text-sm text-muted-foreground">
      {plugin.description}
    </p>
  ) : null;
  const [introVisited, setIntroVisited] = useState(tab === 'intro');
  if (tab === 'intro' && !introVisited) setIntroVisited(true);
  const [contentVisited, setContentVisited] = useState(tab === 'content');
  if (tab === 'content' && !contentVisited) setContentVisited(true);

  const selectFile = (path: string): void => onNavigate({ tab: 'content', file: path });
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

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          leading={
            <Link
              to="/plugins"
              aria-label="返回插件列表"
              className={buttonVariants({ variant: 'outline', size: 'icon' })}
            >
              <ArrowLeft aria-hidden="true" />
            </Link>
          }
          title={plugin.name}
          eyebrow={plugin.version ? <Badge variant="outline">{plugin.version}</Badge> : null}
          actions={
            canExport ? (
              <a
                href={`/api/plugins/${plugin.id}/export`}
                className={buttonVariants({ variant: 'outline' })}
              >
                <Download data-icon="inline-start" aria-hidden="true" />
                导出 ZIP
              </a>
            ) : undefined
          }
        />
      </PageTopbar>

      {refetchError ? (
        <ErrorState error={refetchError} onRetry={onRetry} title="刷新失败，已保留加载的内容" />
      ) : null}

      {plugin.files.length === 0 ? (
        <PageBody>
          {description}
          <EmptyState
            illustration={<BusinessIllustration name="documents" />}
            title="这个插件没有支持文件"
            description="插件目录里没有可查看的文件。"
            action={
              <Link to="/plugins" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                返回插件列表
              </Link>
            }
          />
        </PageBody>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(next) => changeTab(next === 'content' ? 'content' : 'intro')}
          className="min-h-0 min-w-0 flex-1 gap-4"
        >
          <PageTopbar>
            <TabsList variant="line" aria-label="插件视图">
              <TabsTrigger value="intro">简介</TabsTrigger>
              <TabsTrigger value="content">内容</TabsTrigger>
            </TabsList>
          </PageTopbar>
          <PageBody className="overflow-hidden gap-0">
            {/* 两个面板都常驻：ui-sdk 用 hidden 管非活动面板，阅读位置因此随 DOM 保留。 */}
            <TabsContent value="intro" keepMounted className="min-h-0 flex-1 overflow-y-auto">
              {introVisited && description ? <div className="pb-4">{description}</div> : null}
              {introVisited ? (
                readme ? (
                  <article className="min-w-0 max-w-[75ch] pb-4">
                    <PluginDocument
                      file={readmeForPage(readme, plugin.name)}
                      mode="read"
                      files={plugin.files}
                      onSelectFile={selectFile}
                    />
                  </article>
                ) : (
                  <InlineEmpty>
                    <span className="flex flex-col items-center gap-2">
                      <span>未提供插件说明。</span>
                      <Button variant="outline" size="sm" onClick={() => changeTab('content')}>
                        查看插件内容
                      </Button>
                    </span>
                  </InlineEmpty>
                )
              ) : null}
            </TabsContent>

            <TabsContent value="content" keepMounted className="min-h-0 flex-1 overflow-hidden">
              {contentVisited ? (
                <PluginContent
                  plugin={plugin}
                  file={file}
                  mode={mode ?? 'read'}
                  onSelectFile={selectFile}
                  onSelectMode={selectMode}
                />
              ) : null}
            </TabsContent>
          </PageBody>
        </Tabs>
      )}
    </Page>
  );
}

function PluginContent({
  plugin,
  file,
  mode,
  onSelectFile,
  onSelectMode,
}: {
  plugin: Plugin;
  file: string | undefined;
  mode: Mode;
  onSelectFile: (path: string) => void;
  onSelectMode: (mode: Mode) => void;
}) {
  const wide = useMediaQuery(WIDE);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesOpenWide, setFilesOpenWide] = useState(true);
  const filesButton = useRef<HTMLButtonElement>(null);
  const docScroll = useRef<HTMLDivElement>(null);

  const requested =
    file === undefined ? undefined : plugin.files.find((item) => item.path === file);
  const stale = file !== undefined && requested === undefined;
  const selected = requested ?? defaultFile(plugin.files);
  const selectedPath = selected?.path;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 换文件（路径变化）才回顶部；只切阅读/源码时保留阅读位置。
  useEffect(() => {
    const scroller = docScroll.current;
    if (scroller !== null) scroller.scrollTop = 0;
  }, [selectedPath]);

  if (selected === undefined) return <InlineEmpty>没有可查看的文件。</InlineEmpty>;

  const parsed = isPluginMarkdown(selected.path)
    ? readPluginMarkdown(selected.content, pluginFileTitle(selected.path))
    : undefined;
  const heading = parsed === undefined ? undefined : firstHeading(parsed.body);
  const showTitle =
    parsed !== undefined &&
    heading !== parsed.name &&
    parsed.name !== pluginFileTitle(selected.path);

  const documentBody = (
    <div className="flex min-w-0 flex-col gap-4">
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
        {...(parsed ? { mode, onModeChange: onSelectMode } : {})}
        copy={{ value: selected.content, label: `复制 ${selected.path}` }}
      />

      {showTitle || parsed?.description ? (
        <div className="flex min-w-0 flex-col gap-2">
          {showTitle ? (
            <h2 className="min-w-0 break-words text-md font-medium text-fg">{parsed.name}</h2>
          ) : null}
          {parsed?.description ? (
            <p className="max-w-[75ch] break-words text-sm text-muted-foreground">
              {parsed.description}
            </p>
          ) : null}
        </div>
      ) : null}

      {stale ? (
        <PageNote title="找不到这个文件" description={`插件里没有 ${file}，已显示默认文件。`} />
      ) : null}

      <CodeBlockCopyAllowed.Provider value={false}>
        <PluginDocument
          file={selected}
          mode={mode}
          files={plugin.files}
          onSelectFile={onSelectFile}
        />
      </CodeBlockCopyAllowed.Provider>
    </div>
  );

  const documentPane = (
    <div
      ref={docScroll}
      data-slot="plugin-content-scroll"
      className="h-full min-h-0 overflow-y-auto pb-4"
    >
      <div className="max-w-[75ch]">{documentBody}</div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {wide ? (
        <>
          <div className="flex shrink-0 items-center pb-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label={filesOpenWide ? '收起文件列表' : '展开文件列表'}
              title={filesOpenWide ? '收起文件列表' : '展开文件列表'}
              aria-expanded={filesOpenWide}
              aria-controls="plugin-detail-files-panel"
              onClick={() => setFilesOpenWide((open) => !open)}
              className="text-muted-foreground hover:text-fg"
            >
              <PanelLeftDashed />
            </Button>
          </div>
          {filesOpenWide ? (
            <Resizable
              orientation="horizontal"
              autoSaveId="plugin-detail-content"
              className="min-h-0 flex-1"
            >
              <ResizablePanel
                id="files"
                defaultSize="240px"
                minSize="180px"
                maxSize="360px"
                className="min-h-0"
              >
                <div
                  id="plugin-detail-files-panel"
                  className="h-full min-h-0 overflow-y-auto pb-4 pe-4"
                >
                  <PluginFileTree
                    files={plugin.files}
                    {...(selectedPath === undefined ? {} : { selectedPath })}
                    onSelect={onSelectFile}
                    idPrefix="plugin-detail-files"
                  />
                </div>
              </ResizablePanel>
              <ResizableHandle className="w-px border-r" aria-label="调整文件树宽度" />
              <ResizablePanel id="document" minSize="320px" className="min-h-0">
                {documentPane}
              </ResizablePanel>
            </Resizable>
          ) : (
            <div className="min-h-0 flex-1">{documentPane}</div>
          )}
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <Collapsible open={filesOpen} onOpenChange={setFilesOpen}>
            <div className="border-b py-2">
              <CollapsibleTrigger ref={filesButton} render={<Button variant="ghost" size="sm" />}>
                <FolderOpen aria-hidden="true" />
                文件
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent animated>
              <div className="max-h-[40vh] overflow-y-auto border-b py-2">
                <PluginFileTree
                  files={plugin.files}
                  {...(selectedPath === undefined ? {} : { selectedPath })}
                  onSelect={(path) => {
                    setFilesOpen(false);
                    filesButton.current?.focus();
                    onSelectFile(path);
                  }}
                  idPrefix="plugin-detail-files"
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
          <div
            ref={docScroll}
            data-slot="plugin-content-scroll"
            className="min-h-0 flex-1 overflow-y-auto pb-4"
          >
            {documentBody}
          </div>
        </div>
      )}
    </div>
  );
}
