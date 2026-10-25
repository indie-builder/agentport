import { language } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolForm } from '../src/pages/servers.js';

const state = vi.hoisted(() => ({
  createPending: false,
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../src/lib/queries.js', () => ({
  useServers: () => ({ data: [] }),
  useAgents: () => ({ data: [] }),
  useTools: () => ({ data: [] }),
  useCreateServer: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateServer: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteServer: () => ({ mutate: vi.fn(), isPending: false }),
  useTestServer: () => ({ mutate: vi.fn(), isPending: false }),
  useImportMcpFile: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateTool: () => ({ isPending: state.createPending, mutate: state.create }),
  useUpdateTool: () => ({ isPending: false, mutate: state.update }),
  useDeleteTool: () => ({ mutate: vi.fn(), isPending: false }),
  useSetToolEnabled: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: 'a',
  useNavigate: () => () => {},
  useSearch: () => ({}),
  useBlocker: () => ({ status: 'idle' }),
}));

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(element: ReactElement) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(element));
}

function flush() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function waitFor<T>(probe: () => T, tries = 60): Promise<T> {
  for (let index = 0; index < tries; index += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {
      // 懒加载的编辑器还没挂上，继续等。
    }
    await flush();
  }
  return probe();
}

function editorView(id: string): EditorView {
  const element = document.getElementById(id);
  if (!element?.classList.contains('cm-content')) {
    throw new Error(`Editor not mounted: ${id}`);
  }
  const view = EditorView.findFromDOM(element);
  if (!view) throw new Error(`Editor view not found: ${id}`);
  return view;
}

async function replaceContent(id: string, value: string) {
  await act(async () => {
    const view = editorView(id);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  });
  await flush();
}

function fill(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) throw new Error(`Missing input: ${id}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  const form = document.querySelector('form');
  if (!form) throw new Error('Missing tool form');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

const props = {
  serverId: 'srv',
  disabled: false,
  onDirtyChange: () => {},
  onPendingChange: () => {},
  onDone: () => {},
  onCancel: () => {},
};

beforeEach(() => vi.clearAllMocks());

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('tool inputSchema editor', () => {
  it('edits the schema as JSON with the blank schema as its value', async () => {
    mount(createElement(ToolForm, { ...props, tool: null }));
    const view = await waitFor(() => editorView('tool-schema-srv'));

    expect(view.state.doc.toString()).toBe('{\n  "type": "object",\n  "properties": {}\n}');
    expect(view.state.facet(language)?.name).toBe('json');
    expect(document.getElementById('tool-schema-srv')?.getAttribute('aria-label')).toBe(
      'inputSchema (JSON)',
    );
    expect(document.querySelector('label[for="tool-schema-srv"]')?.textContent).toBe(
      'inputSchema (JSON)',
    );
  });

  it('links schema validation errors to the editor surface', async () => {
    mount(createElement(ToolForm, { ...props, tool: null }));
    await waitFor(() => editorView('tool-schema-srv'));

    await replaceContent('tool-schema-srv', '{"oops"');
    await submit();

    const editor = await waitFor(() => {
      const element = document.getElementById('tool-schema-srv');
      return element?.getAttribute('aria-invalid') === 'true' ? element : null;
    });
    expect(editor.getAttribute('aria-describedby')).toBe('tool-schema-error-srv');
    expect(document.getElementById('tool-schema-error-srv')?.textContent).toContain(
      '不是合法 JSON',
    );
  });

  it('reports the form dirty when only the schema changes', async () => {
    const onDirtyChange = vi.fn();
    mount(createElement(ToolForm, { ...props, tool: null, onDirtyChange }));
    await waitFor(() => editorView('tool-schema-srv'));

    await replaceContent('tool-schema-srv', '{"type":"object"}');

    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('submits the parsed schema', async () => {
    mount(createElement(ToolForm, { ...props, tool: null }));
    await waitFor(() => editorView('tool-schema-srv'));

    fill('tool-name-srv', 'list-users');
    fill('tool-path-srv', '/users/{id}');
    await replaceContent(
      'tool-schema-srv',
      '{"type":"object","properties":{"id":{"type":"string"}}}',
    );
    await submit();

    expect(state.create).toHaveBeenCalledOnce();
    expect(state.create.mock.calls[0]?.[0].inputSchema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
    });
  });

  it('takes the schema editor out of editing while saving', async () => {
    state.createPending = true;
    mount(createElement(ToolForm, { ...props, tool: null }));

    await waitFor(() => editorView('tool-schema-srv'));
    const editor = document.getElementById('tool-schema-srv');
    expect(editor?.getAttribute('contenteditable')).toBe('false');
    expect(editor?.getAttribute('aria-disabled')).toBe('true');
  });
});
