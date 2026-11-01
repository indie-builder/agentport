import { Children, createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogShell } from '../src/components/dialog-shell.js';

const capture = vi.hoisted(() => ({
  submit: undefined as
    | undefined
    | ((event: {
        currentTarget: { querySelector: (selector: string) => { focus: () => void } | null };
      }) => void),
}));

vi.mock('../src/components/ui/dialog.js', () => ({
  DialogContent: ({ children }: { children: ReactNode }) => {
    const content = Children.toArray(children)[1] as ReactElement<{
      onSubmitCapture: typeof capture.submit;
    }>;
    capture.submit = content.props.onSubmitCapture;
    return children;
  },
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => children,
  DialogDescription: ({ children }: { children: ReactNode }) => children,
  DialogClose: () => null,
}));

afterEach(() => vi.unstubAllGlobals());

describe('DialogShell validation focus', () => {
  it('waits for rendered validation errors before focusing the first invalid field', () => {
    let frame: (() => void) | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      frame = callback;
    });
    renderToStaticMarkup(createElement(DialogShell, { title: '编辑' }));
    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    capture.submit?.({ currentTarget: { querySelector } });
    expect(frame).toBeTypeOf('function');
    expect(querySelector).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    frame?.();
    expect(querySelector).toHaveBeenCalledWith('[aria-invalid="true"]');
    expect(focus).toHaveBeenCalledOnce();
  });

  it('leaves focus alone after a valid submission', () => {
    let frame: (() => void) | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      frame = callback;
    });
    renderToStaticMarkup(createElement(DialogShell, { title: '编辑' }));
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    const querySelector = vi.fn(() => null);
    capture.submit?.({ currentTarget: { querySelector } });
    expect(frame).toBeTypeOf('function');
    frame?.();
    expect(querySelector).toHaveBeenCalledWith('[aria-invalid="true"]');
    expect(document.activeElement).toBe(input);
    input.remove();
  });
});
