import type { PluginFileInput } from '@agentport/shared';
import { ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './motion-collapsible.js';
import { InlineEmpty } from './states.js';
import { Button } from './ui/button.js';

interface FolderNode {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  files: PluginFileInput[];
}

/** 根下默认展开这两个目录；更深的层级跟随当前选中文件展开。 */
const DEFAULT_OPEN = ['skills', 'agents'];

/** 技能目录的入口文件先行，其余仍是目录先于文件。 */
const ENTRY_FILE = 'SKILL.md';

const ROW_CLASS =
  'h-auto w-full min-w-0 justify-start rounded-[var(--radius-icon)] px-2 py-1.5 text-left font-normal';

function basename(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function buildTree(files: PluginFileInput[]): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: new Map(), files: [] };
  for (const file of files) {
    const segments = file.path.split('/');
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      const path = folder.path === '' ? segment : `${folder.path}/${segment}`;
      let child = folder.folders.get(segment);
      if (child === undefined) {
        child = { name: segment, path, folders: new Map(), files: [] };
        folder.folders.set(segment, child);
      }
      folder = child;
    }
    folder.files.push(file);
  }
  return root;
}

function sortedFolders(folder: FolderNode): FolderNode[] {
  return [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function sortedFiles(folder: FolderNode): PluginFileInput[] {
  return [...folder.files].sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
}

function ancestorsOf(path: string): string[] {
  const segments = path.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

function initialOpen(selectedPath: string | undefined): Record<string, boolean> {
  const open: Record<string, boolean> = {};
  for (const path of DEFAULT_OPEN) open[path] = true;
  for (const path of selectedPath === undefined ? [] : ancestorsOf(selectedPath)) open[path] = true;
  return open;
}

interface TreeProps {
  open: Record<string, boolean>;
  selectedPath?: string;
  onSelect: (path: string) => void;
  onToggle: (path: string, open: boolean) => void;
}

function FileRow({
  file,
  selectedPath,
  onSelect,
}: {
  file: PluginFileInput;
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
}) {
  const selected = selectedPath === file.path;
  return (
    <li className="min-w-0">
      <Button
        variant="ghost"
        title={file.path}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(file.path)}
        className={cn(
          ROW_CLASS,
          selected
            ? 'bg-selected font-medium text-selected-foreground hover:bg-selected hover:text-selected-foreground'
            : 'text-muted-foreground hover:bg-hover hover:text-muted-foreground',
        )}
      >
        <span aria-hidden="true" className="size-4 shrink-0" />
        <FileText aria-hidden="true" />
        <span className="min-w-0 truncate">{basename(file.path)}</span>
      </Button>
    </li>
  );
}

function FolderRow({ folder, props }: { folder: FolderNode; props: TreeProps }) {
  const { open, onToggle } = props;
  const expanded = open[folder.path] === true;
  return (
    <li className="min-w-0">
      <Collapsible open={expanded} onOpenChange={(next) => onToggle(folder.path, next)}>
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              title={folder.path}
              className={cn(
                ROW_CLASS,
                // ghost 的 aria-expanded 默认铺灰底；这里只用 hover 与选中文件表达状态。
                'text-fg hover:bg-hover aria-expanded:bg-transparent aria-expanded:hover:bg-hover',
              )}
            />
          }
        >
          <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
            <ChevronRight
              className={cn('transition-transform duration-150 ease-out-soft', expanded && 'rotate-90')}
            />
          </span>
          {expanded ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}
          <span className="min-w-0 truncate">{folder.name}</span>
        </CollapsibleTrigger>
        <CollapsibleContent animated>
          <Children folder={folder} props={props} nested />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function Children({
  folder,
  props,
  nested = false,
}: {
  folder: FolderNode;
  props: TreeProps;
  nested?: boolean;
}) {
  const files = sortedFiles(folder);
  const entry = files.find((file) => basename(file.path) === ENTRY_FILE);
  const rest = entry === undefined ? files : files.filter((file) => file !== entry);
  return (
    <ul
      className={cn(
        'flex min-w-0 flex-col',
        // 缩进固定一个令牌 step，引导线落在父级 chevron 槽的中心。
        nested && 'ms-4 border-s border-line',
      )}
    >
      {entry === undefined ? null : (
        <FileRow file={entry} selectedPath={props.selectedPath} onSelect={props.onSelect} />
      )}
      {sortedFolders(folder).map((child) => (
        <FolderRow key={child.path} folder={child} props={props} />
      ))}
      {rest.map((file) => (
        <FileRow
          key={file.path}
          file={file}
          selectedPath={props.selectedPath}
          onSelect={props.onSelect}
        />
      ))}
    </ul>
  );
}

/**
 * 真实插件路径的只读文件树。选中文件由调用方从 URL 传入；树只在本次会话里维护展开状态，
 * 选中路径变化时自动展开全部祖先，避免深文件需要用户自己找。
 */
export function PluginFileTree({
  files,
  selectedPath,
  onSelect,
  idPrefix,
}: {
  files: PluginFileInput[];
  selectedPath?: string;
  onSelect: (path: string) => void;
  idPrefix?: string;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [open, setOpen] = useState<Record<string, boolean>>(() => initialOpen(selectedPath));

  useEffect(() => {
    if (selectedPath === undefined) return;
    const ancestors = ancestorsOf(selectedPath);
    setOpen((previous) => {
      if (ancestors.every((path) => previous[path] === true)) return previous;
      const next = { ...previous };
      for (const path of ancestors) next[path] = true;
      return next;
    });
  }, [selectedPath]);

  if (files.length === 0) return <InlineEmpty>没有可查看的文件。</InlineEmpty>;

  const props: TreeProps = {
    open,
    ...(selectedPath === undefined ? {} : { selectedPath }),
    onSelect,
    onToggle: (path, next) => setOpen((previous) => ({ ...previous, [path]: next })),
  };

  return (
    <nav
      aria-label="插件文件"
      {...(idPrefix === undefined ? {} : { id: `${idPrefix}-plugin-files` })}
      className="min-w-0"
    >
      <Children folder={tree} props={props} />
    </nav>
  );
}
