import { useMemo, useState } from 'react';
import type { KnowledgeWikiGraph as WikiGraph } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { SearchInput } from '../search-input.js';
import { InlineEmpty } from '../states.js';

const WIDTH = 760;
const HEIGHT = 520;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;
const RADIUS = 190;

function labelOf(title: string): string {
  return title.length > 16 ? `${title.slice(0, 15)}…` : title;
}

export function KnowledgeWikiGraph({
  graph,
  onSelectPage,
}: {
  graph: WikiGraph;
  onSelectPage: (pageId: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  const query = filter.trim().toLowerCase();
  const visibleNodes = useMemo(
    () =>
      query
        ? graph.nodes.filter(
            (node) =>
              node.title.toLowerCase().includes(query) || node.slug.toLowerCase().includes(query),
          )
        : graph.nodes,
    [graph.nodes, query],
  );
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => graph.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)),
    [graph.edges, visibleIds],
  );
  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number; cos: number; sin: number }>();
    graph.nodes.forEach((node, index) => {
      const angle = (index / Math.max(graph.nodes.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      map.set(node.id, { x: CENTER_X + RADIUS * cos, y: CENTER_Y + RADIUS * sin, cos, sin });
    });
    return map;
  }, [graph.nodes]);
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
        <InlineEmpty>还没有 Wiki 页面</InlineEmpty>
      ) : visibleNodes.length === 0 ? (
        <InlineEmpty>没有匹配的页面</InlineEmpty>
      ) : (
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
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
                  r={active ? 7 : 5}
                  className={cn('fill-fg transition-all', active && 'stroke-fg stroke-2')}
                />
                <text
                  x={position.x + position.cos * 12}
                  y={position.y + position.sin * 12 + 3}
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
