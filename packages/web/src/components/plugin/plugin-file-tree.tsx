import type { PluginFileInput } from '@agentport/shared';
import {
  Tree,
  TreeGroup,
  TreeItem,
  type TreeItemData,
  TreeItemIndicator,
  TreeItemLabel,
} from '@ui-sdk/react/tree';
import { ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from '../../lib/cn.js';
import { InlineEmpty } from '../states.js';

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
  'flex w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-icon)] border border-transparent px-2 py-1.5 text-left text-sm font-normal whitespace-nowrap select-none outline-none transition-colors duration-150 ease-out-soft group-focus-visible/tree-row:ring-2 group-focus-visible/tree-row:ring-ring';

const GROUP_CLASS =
  'ms-4 border-s border-line overflow-hidden transition-[height,opacity] duration-150 ease-out-soft h-(--tree-group-height) data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0';

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

function toTreeItems(folder: FolderNode): TreeItemData[] {
  const files = sortedFiles(folder);
  const entry = files.find((file) => basename(file.path) === ENTRY_FILE);
  const rest = entry === undefined ? files : files.filter((file) => file !== entry);
  return [
    ...(entry === undefined ? [] : [{ value: entry.path, label: basename(entry.path) }]),
    ...sortedFolders(folder).map((child) => ({
      value: child.path,
      label: child.name,
      children: toTreeItems(child),
    })),
    ...rest.map((file) => ({ value: file.path, label: basename(file.path) })),
  ];
}

function FileTreeRows({
  items,
  onSelect,
}: {
  items: TreeItemData[];
  onSelect: (path: string) => void;
}) {
  return items.map((item) => {
    const folder = item.children !== undefined;
    return (
      <TreeItem
        key={item.value}
        value={item.value}
        className="group/tree-row min-w-0 outline-none"
        onKeyDown={(event) => {
          if (event.key !== ' ' || event.defaultPrevented) return;
          event.preventDefault();
          if (folder) {
            event.currentTarget.click();
          } else {
            onSelect(item.value);
          }
        }}
      >
        <TreeItemLabel
          title={item.value}
          className={
            folder
              ? cn(ROW_CLASS, 'text-fg hover:bg-hover')
              : (state) =>
                  cn(
                    ROW_CLASS,
                    state.current
                      ? 'bg-selected font-medium text-selected-foreground hover:bg-selected'
                      : 'text-muted-foreground hover:bg-hover',
                  )
          }
        >
          {(state) => (
            <>
              {folder ? (
                <TreeItemIndicator className="flex size-4 shrink-0 items-center justify-center">
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      'transition-transform duration-150 ease-out-soft',
                      state.expanded && 'rotate-90',
                    )}
                  />
                </TreeItemIndicator>
              ) : (
                <span aria-hidden="true" className="size-4 shrink-0" />
              )}
              {folder ? (
                state.expanded ? (
                  <FolderOpen aria-hidden="true" />
                ) : (
                  <Folder aria-hidden="true" />
                )
              ) : (
                <FileText aria-hidden="true" />
              )}
              <span className="min-w-0 truncate">{item.label}</span>
            </>
          )}
        </TreeItemLabel>
        {item.children === undefined ? null : (
          <TreeGroup className={GROUP_CLASS}>
            <FileTreeRows items={item.children} onSelect={onSelect} />
          </TreeGroup>
        )}
      </TreeItem>
    );
  });
}

/**
 * 真实插件路径的只读文件树。选中文件由调用方从 URL 传入；展开状态由树维护，
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
  const { items, filePaths } = useMemo(() => {
    const root = buildTree(files);
    return {
      items: toTreeItems(root),
      filePaths: new Set(files.map((file) => file.path)),
    };
  }, [files]);

  if (files.length === 0) return <InlineEmpty>没有可查看的文件。</InlineEmpty>;

  return (
    <Tree
      aria-label="插件文件"
      {...(idPrefix === undefined ? {} : { id: `${idPrefix}-plugin-files` })}
      className="min-w-0"
      items={items}
      mode="none"
      current={selectedPath ?? null}
      defaultExpanded={DEFAULT_OPEN}
      announcement={({ type }) =>
        type === 'expanded' ? '已展开' : type === 'collapsed' ? '已收起' : null
      }
      onAction={(value) => {
        if (filePaths.has(value)) onSelect(value);
      }}
    >
      <FileTreeRows items={items} onSelect={onSelect} />
    </Tree>
  );
}
