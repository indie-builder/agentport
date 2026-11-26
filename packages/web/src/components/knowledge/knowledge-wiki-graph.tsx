import { Network } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { KnowledgeWikiGraph as WikiGraph } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { SearchInput } from '../search-input.js';
import { type EmptyFilterChip, EmptyState } from '../states.js';
import { Button } from '../ui/button.js';

const WIDTH = 760;
const HEIGHT = 520;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;

function labelOf(title: string): string {
  return title.length > 16 ? `${title.slice(0, 15)}…` : title;
}

function graphLayout(count: number): {
  slots: Array<{ x: number; y: number; cos: number; sin: number }>;
  nodeRadius: number;
} {
  const nodeRadius = count <= 24 ? 5 : count <= 90 ? 4 : 3;
  const spacing = nodeRadius * 2 + 8;
  const maxRadius = HEIGHT / 2 - 40;
  const single = Math.min(CENTER_X, CENTER_Y) - 70;
  let radii = [single];
  if (Math.floor((2 * Math.PI * single) / spacing) < count) {
    for (let rings = 2; rings <= 8; rings += 1) {
      radii = Array.from(
        { length: rings },
        (_, ring) => 60 + ((maxRadius - 60) * ring) / (rings - 1),
      );
      if (
        radii.reduce((sum, radius) => sum + Math.floor((2 * Math.PI * radius) / spacing), 0) >=
        count
      ) {
        break;
      }
    }
  }
  const slots: Array<{ x: number; y: number; cos: number; sin: number }> = [];
  let placed = 0;
  for (const radius of radii) {
    const onRing = Math.min(Math.floor((2 * Math.PI * radius) / spacing), count - placed);
    for (let index = 0; index < onRing; index += 1) {
      const angle = (index / onRing) * Math.PI * 2 - Math.PI / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      slots.push({ x: CENTER_X + radius * cos, y: CENTER_Y + radius * sin, cos, sin });
    }
    placed += onRing;
    if (placed >= count) break;
  }
  return { slots, nodeRadius };
}

export function KnowledgeWikiGraph({
  graph,
  onSelectPage,
  onCreatePage,
}: {
  graph: WikiGraph;
  onSelectPage: (pageId: string) => void;
  onCreatePage?: (() => void) | undefined;
}) {
  const [filter, setFilter] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  const query = filter.trim().toLowerCase();
  const visibleNodes = useMemo(
    () =>
      query ? graph.nodes.filter((node) => node.title.toLowerCase().includes(query)) : graph.nodes,
    [graph.nodes, query],
  );
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => graph.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)),
    [graph.edges, visibleIds],
  );
  const { positions, nodeRadius } = useMemo(() => {
    const { slots, nodeRadius: radius } = graphLayout(visibleNodes.length);
    const map = new Map<string, { x: number; y: number; cos: number; sin: number }>();
    visibleNodes.forEach((node, index) => {
      const slot = slots[index];
      if (slot) map.set(node.id, slot);
    });
    return { positions: map, nodeRadius: radius };
  }, [visibleNodes]);
  const connected = useMemo(() => {
    if (hovered === null) return null;
    const ids = new Set<string>([hovered]);
    for (const edge of graph.edges) {
      if (edge.from === hovered) ids.add(edge.to);
      else if (edge.to === hovered) ids.add(edge.from);
    }
    return ids;
  }, [graph.edges, hovered]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SearchInput
        value={filter}
        onChange={setFilter}
        label="按标题筛选 Wiki 页面"
        placeholder="筛选页面…"
        className="max-w-72"
      />
      {graph.truncated ? (
        <p className="text-xs text-muted-foreground">仅显示前 300 个页面</p>
      ) : null}
      {graph.nodes.length === 0 ? (
        <EmptyState
          variant="idle"
          scale="panel"
          icon={<Network aria-hidden="true" />}
          title="图谱暂无节点"
          description="创建 Wiki 页面并建立引用后，页面关系会展示在这里。"
          action={
            onCreatePage ? (
              <Button variant="outline" size="sm" onClick={onCreatePage}>
                新建页面
              </Button>
            ) : undefined
          }
        />
      ) : visibleNodes.length === 0 ? (
        <EmptyState
          variant="filter"
          scale="inline"
          title="没有匹配的页面"
          activeFilters={
            [
              {
                key: 'q',
                label: '关键词',
                value: filter.trim(),
                onRemove: () => setFilter(''),
              },
            ] satisfies EmptyFilterChip[]
          }
          action={
            <Button variant="outline" size="sm" onClick={() => setFilter('')}>
              清除筛选
            </Button>
          }
        />
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: SVG 图谱没有等价语义元素，group 保留子节点按钮语义
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="group"
          aria-label={`Wiki 链接图谱：${graph.nodes.length} 个页面，${graph.edges.length} 条链接`}
          className="w-full"
        >
          {visibleEdges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            return (
              <line
                key={`${edge.from}:${edge.to}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                strokeWidth={1}
                className={cn(
                  'transition-opacity',
                  hovered === null
                    ? 'stroke-line opacity-70'
                    : edge.from === hovered || edge.to === hovered
                      ? 'stroke-fg opacity-100'
                      : 'stroke-line opacity-15',
                )}
              />
            );
          })}
          {visibleNodes.map((node) => {
            const position = positions.get(node.id);
            if (!position) return null;
            const active = hovered === node.id;
            const dimmed = connected !== null && !connected.has(node.id);
            const anchor = position.cos > 0.1 ? 'start' : position.cos < -0.1 ? 'end' : 'middle';
            return (
              // biome-ignore lint/a11y/useSemanticElements: SVG 节点只能是 g，用 role="button" 提供键盘语义
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={`打开页面：${node.title}`}
                className={cn(
                  'cursor-pointer outline-none transition-opacity',
                  dimmed ? 'opacity-30' : 'opacity-100',
                )}
                onMouseEnter={() => setHovered(node.id)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(node.id)}
                onBlur={() => setHovered(null)}
                onClick={() => onSelectPage(node.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onSelectPage(node.id);
                }}
              >
                <title>{node.title}</title>
                <circle
                  cx={position.x}
                  cy={position.y}
                  r={active ? nodeRadius + 2 : nodeRadius}
                  className={cn('fill-fg transition-all', active && 'stroke-fg stroke-2')}
                />
                <text
                  x={position.x + position.cos * (nodeRadius + 8)}
                  y={position.y + position.sin * (nodeRadius + 8) + 3}
                  textAnchor={anchor}
                  className="fill-muted-foreground text-[10px]"
                >
                  {labelOf(node.title)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
