import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DataColumn, DataTable, reorderColumns } from '../src/components/data-table.js';

const rows = [{ id: 'run-1', name: 'A long expert name that must stay readable' }];
const columns: DataColumn<(typeof rows)[number]>[] = [
  { id: 'id', header: '运行', locked: true, width: '110px' },
  {
    id: 'name',
    header: '专家',
    cell: (row) => createElement('a', { href: '/agents' }, row.name),
  },
];

function renderTable(props: Partial<Parameters<typeof DataTable<(typeof rows)[number]>>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(DataTable<(typeof rows)[number]>, {
      rows,
      columns,
      rowKey: (row) => row.id,
      label: '运行列表',
      ...props,
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('DataTable accessibility', () => {
  it('renders named table headers and cells without wrapping cell links in buttons', () => {
    const html = renderTable({ onRowClick: () => {} });
    expect(html).toMatch(/<table\b[^>]*aria-label="运行列表"/);
    expect(html).toMatch(/<th\b[^>]*scope="col"/);
    expect(html).toMatch(/<td\b/);
    expect(html).toContain('<a href="/agents">A long expert name that must stay readable</a>');
    expect(html).not.toMatch(/<button\b[^>]*data-row[^>]*>[\s\S]*?<a\b[\s\S]*?<\/button>/);
  });

  it.each([
    { prefs: ['id'] },
    { prefs: { hidden: ['id'], order: ['name', 'id', 'id', 'removed'] } },
  ])('keeps locked columns visible despite saved preferences %j', ({ prefs }) => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(prefs) });
    const html = renderTable({ storageKey: 'test.columns' });
    expect(html).toContain('run-1');
    expect(html.match(/<th\b/g)).toHaveLength(2);
  });

  it.each([
    { from: 0, to: 1, expected: ['b', 'locked', 'a', 'c'] },
    { from: 2, to: 1, expected: ['a', 'locked', 'c', 'b'] },
    { from: 0, to: -1, expected: ['a', 'locked', 'b', 'c'] },
    { from: 2, to: 3, expected: ['a', 'locked', 'b', 'c'] },
  ])('moves only unlocked columns: $from to $to', ({ from, to, expected }) => {
    expect(
      reorderColumns(
        [{ id: 'a' }, { id: 'locked', locked: true }, { id: 'b' }, { id: 'c' }],
        from,
        to,
      ),
    ).toEqual(expected);
  });

  it('provides expansion state only for rows with expandable content', () => {
    const expandable = renderTable({ renderExpanded: () => 'Details' });
    expect(expandable).toMatch(/<button\b[^>]*data-row[^>]*aria-expanded="false"/);
    const inert = renderTable({ renderExpanded: () => null });
    expect(inert).not.toContain('data-row');
  });

  it.each([{ loading: true }, { empty: 'Nothing here' }])(
    'keeps loading and empty states inside table cells %j',
    (props) => {
      const html = renderTable({ rows: [], ...props });
      expect(html).toMatch(/<tbody\b[\s\S]*?<tr\b[\s\S]*?<td\b[^>]*colSpan="2"/);
    },
  );

  it('keeps null sort values last in both directions', async () => {
    const sortable = [
      { id: 'two', value: 2 },
      { id: 'none', value: null },
      { id: 'one', value: 1 },
    ];
    const sortableColumns: DataColumn<(typeof sortable)[number]>[] = [
      { id: 'value', header: '值', sortValue: (row) => row.value },
    ];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          createElement(DataTable<(typeof sortable)[number]>, {
            rows: sortable,
            columns: sortableColumns,
            rowKey: (row) => row.id,
            label: '排序测试',
            onRowClick: () => {},
          }),
        );
      });
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="值，按此列排序"]',
      );
      if (!button) throw new Error('Missing sort button');
      const order = () =>
        [...container.querySelectorAll('button[data-row]')].map((row) =>
          row.getAttribute('aria-label')?.replace('打开 ', ''),
        );

      await act(async () => button.click());
      expect(order()).toEqual(['two', 'one', 'none']);
      await act(async () => button.click());
      expect(order()).toEqual(['one', 'two', 'none']);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
