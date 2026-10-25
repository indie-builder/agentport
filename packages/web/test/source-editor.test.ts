import { EditorView } from '@codemirror/view';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceEditor } from '../src/components/source-editor.js';
import { SourceEditorInner } from '../src/components/source-editor-inner.js';

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(props: Parameters<typeof SourceEditorInner>[0]): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(SourceEditorInner, props)));
  return host;
}

function content(container: HTMLDivElement): HTMLElement {
  const node = container.querySelector<HTMLElement>('.cm-content');
  if (!node) throw new Error('editor content not mounted');
  return node;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('SourceEditorInner', () => {
  it('labels the contenteditable surface and keeps the source text verbatim', () => {
    const container = mount({
      value: '{"a":1}',
      onChange: () => {},
      language: 'json',
      id: 'schema',
      'aria-label': '输入模式',
      'aria-describedby': 'schema-hint',
      'aria-invalid': true,
    });
    const editor = content(container);
    expect(editor.getAttribute('contenteditable')).toBe('true');
    expect(editor.id).toBe('schema');
    expect(editor.getAttribute('aria-label')).toBe('输入模式');
    expect(editor.getAttribute('aria-describedby')).toBe('schema-hint');
    expect(editor.getAttribute('aria-invalid')).toBe('true');
    expect(editor.textContent).toBe('{"a":1}');
  });

  it('reports document edits through onChange', () => {
    const onChange = vi.fn();
    const container = mount({ value: 'a', onChange });
    const view = EditorView.findFromDOM(content(container));
    if (!view) throw new Error('editor view not found');
    act(() => view.dispatch({ changes: { from: 1, insert: 'b' } }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('ab');
  });

  it('applies external value updates without echoing onChange or recreating the view', () => {
    const props = { value: 'first', onChange: vi.fn() };
    const container = mount(props);
    const editor = content(container);
    const view = EditorView.findFromDOM(editor);
    act(() => root?.render(createElement(SourceEditorInner, { ...props, value: 'second' })));
    expect(content(container)).toBe(editor);
    expect(EditorView.findFromDOM(content(container))).toBe(view);
    expect(content(container).textContent).toBe('second');
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it('keeps focus while an external update replaces the document', () => {
    const props = { value: 'first', onChange: vi.fn() };
    const container = mount(props);
    const editor = content(container);
    editor.focus();
    act(() => root?.render(createElement(SourceEditorInner, { ...props, value: 'second' })));
    expect(document.activeElement).toBe(editor);
  });

  it('marks read-only content as non-editable but still selectable', () => {
    const container = mount({ value: 'x', onChange: () => {}, readOnly: true });
    const editor = content(container);
    expect(editor.getAttribute('contenteditable')).toBe('true');
    expect(editor.getAttribute('aria-readonly')).toBe('true');
  });

  it('takes disabled content out of editing entirely', () => {
    const container = mount({ value: 'x', onChange: () => {}, disabled: true });
    const editor = content(container);
    expect(editor.getAttribute('contenteditable')).toBe('false');
    expect(editor.getAttribute('aria-disabled')).toBe('true');
  });

  it('switches read-only on and off without rebuilding the editor', () => {
    const props = { value: 'x', onChange: () => {} };
    const container = mount(props);
    const editor = content(container);
    const view = EditorView.findFromDOM(editor);
    act(() => root?.render(createElement(SourceEditorInner, { ...props, disabled: true })));
    expect(EditorView.findFromDOM(content(container))).toBe(view);
    expect(content(container).getAttribute('contenteditable')).toBe('false');
    act(() => root?.render(createElement(SourceEditorInner, { ...props, disabled: false })));
    expect(content(container).getAttribute('contenteditable')).toBe('true');
  });

  it('calls the latest onChange and onBlur after they change', () => {
    const first = vi.fn();
    const second = vi.fn();
    const blur = vi.fn();
    const container = mount({ value: 'a', onChange: first });
    act(() =>
      root?.render(
        createElement(SourceEditorInner, { value: 'a', onChange: second, onBlur: blur }),
      ),
    );
    const view = EditorView.findFromDOM(content(container));
    if (!view) throw new Error('editor view not found');
    act(() => view.dispatch({ changes: { from: 1, insert: 'b' } }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith('ab');
    act(() => content(container).dispatchEvent(new FocusEvent('blur')));
    expect(blur).toHaveBeenCalledOnce();
  });
});

describe('SourceEditor', () => {
  it('renders an accessible textarea of the same value while CodeMirror loads', () => {
    const html = renderToStaticMarkup(
      createElement(SourceEditor, {
        value: '{"a":1}',
        onChange: () => {},
        id: 'schema',
        'aria-label': '输入模式',
        'aria-describedby': 'schema-hint',
        readOnly: true,
      }),
    );
    expect(html).toContain('data-slot="source-editor"');
    expect(html).toMatch(/<textarea\b[^>]*id="schema"/);
    expect(html).toContain('aria-label="输入模式"');
    expect(html).toContain('aria-describedby="schema-hint"');
    expect(html).toMatch(/readonly/i);
    expect(html).toContain('{&quot;a&quot;:1}');
  });

  it('swaps the fallback for the CodeMirror surface once loaded', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        createElement(SourceEditor, {
          value: '{"a":1}',
          onChange: () => {},
          language: 'json',
          'aria-label': '输入模式',
        }),
      );
    });
    const editor = content(host);
    expect(editor.getAttribute('aria-label')).toBe('输入模式');
    expect(host.querySelector('textarea')).toBeNull();
  });
});
