'use client';

import { createListbox, definePrimitive, selects } from '@ui-sdk/core';
import { type PrimitiveHandle, usePart, usePrimitive } from '@ui-sdk/react/primitive';
import { type RefObject, useEffect } from 'react';

type MentionOption = { agentId: string; name: string };

type MentionListOptions = {
  open: boolean;
  options: readonly MentionOption[];
  onSelect: (agentId: string) => void;
  onClose: () => void;
};

export const mentionList = definePrimitive({
  name: 'mention-list',
  options: { open: 'boolean', options: 'value', onSelect: 'callback', onClose: 'callback' },
  state: (options: MentionListOptions) => ({
    highlighted: options.open ? (options.options[0]?.agentId ?? null) : null,
    shown: options.open,
  }),
  sync: (options) => ({ shown: options.open }),
  api: (context) => {
    const listbox = createListbox(context, { key: 'highlighted', focus: 'virtual' });
    context.onOptions((next) => {
      const prev = context.store.get();
      if (!next.open) {
        if (prev.highlighted !== null) context.store.set({ highlighted: null });
        return;
      }
      const hasHighlighted =
        prev.highlighted !== null &&
        next.options.some((option) => option.agentId === prev.highlighted);
      if (!prev.shown || !hasHighlighted) {
        const first = next.options[0]?.agentId ?? null;
        if (prev.highlighted !== first) context.store.set({ highlighted: first });
      }
    });
    const choose = (key: string): void => {
      const { shown } = context.store.get();
      const { options, onSelect } = context.options();
      if (!shown) {
        throw new Error('Mention list is closed.');
      }
      if (!options.some((option) => option.agentId === key)) {
        throw new Error(
          `Unknown mention "${key}". Options: ${options.map((option) => option.agentId).join(', ')}.`,
        );
      }
      onSelect(key);
    };
    const items = () =>
      context.options().options.map((option) => ({ value: option.agentId, label: option.name }));
    const keydown = (event: KeyboardEvent): boolean => {
      if (!context.store.get().shown) return false;
      if (event.key === 'Escape') {
        event.preventDefault();
        context.options().onClose();
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (context.store.get().highlighted === null) listbox.move('first');
        const key = context.store.get().highlighted;
        if (key === null) return false;
        event.preventDefault();
        choose(key);
        return true;
      }
      return listbox.keydown(event) !== undefined;
    };
    const bindInput = (el: HTMLTextAreaElement): (() => void) => {
      const clear = (): void => {
        for (const name of [
          'aria-autocomplete',
          'aria-haspopup',
          'aria-controls',
          'aria-activedescendant',
        ]) {
          el.removeAttribute(name);
        }
      };
      const apply = (): void => {
        if (!context.store.get().shown) {
          clear();
          return;
        }
        el.setAttribute('aria-autocomplete', 'list');
        el.setAttribute('aria-haspopup', 'listbox');
        el.setAttribute('aria-controls', `${context.id}-list`);
        const active = listbox.activeId(context.store.get());
        if (active === undefined) el.removeAttribute('aria-activedescendant');
        else el.setAttribute('aria-activedescendant', active);
      };
      apply();
      const unsubscribe = context.store.subscribe(apply);
      return () => {
        unsubscribe();
        clear();
      };
    };
    return { listbox, keydown, bindInput, choose, items };
  },
  slots: (slot) => ({
    root: slot({
      present: (state) => state.shown,
    }),
    list: slot({
      role: 'listbox',
      present: (state) => state.shown,
      keys: { none: '输入框处理键盘导航。' },
      attrs: (_state, { id }) => ({ id: `${id}-list` }),
    }),
    option: slot<{ value: string }>({
      role: 'option',
      focus: 'active-descendant',
      props: { value: 'string' },
      selects: selects({ highlighted: ({ key }) => [key, null] }),
      attrs: (state, part) => ({
        ...part.api.listbox.attrs(state, part),
        'aria-selected': String(state.highlighted === part.key),
      }),
      press: ({ key, api }) => api.choose(key),
      on: {
        pointerdown: (event) => event.preventDefault(),
        pointermove: (event, { key, api }) => api.listbox.highlight(key, { event }),
      },
      bind: (el, part) => part.api.listbox.bind(el, part),
    }),
  }),
  agent: {
    actions: ['choose'],
    shown: (state) => state.shown,
    items: (api) => api.items(),
  },
});

type MentionListHandle = PrimitiveHandle<typeof mentionList>;

function MentionListItem({
  handle,
  value,
  name,
  active,
}: {
  handle: MentionListHandle;
  value: string;
  name: string;
  active: boolean;
}) {
  return usePart(
    handle,
    'option',
    { value },
    {
      className:
        'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-item px-3 py-1.5 text-start text-sm text-fg data-highlighted:bg-accent data-highlighted:text-accent-foreground',
      children: (
        <>
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {active ? <span className="shrink-0 text-xs text-muted-foreground">运行中</span> : null}
        </>
      ),
    },
    'div',
  );
}

export function useMentionList(
  options: MentionListOptions,
  input: RefObject<HTMLTextAreaElement | null>,
) {
  const handle = usePrimitive(mentionList, options);
  const { instance } = handle;
  useEffect(() => {
    const el = input.current;
    return el ? instance.api.bindInput(el) : undefined;
  }, [instance, input]);
  return handle;
}

export function MentionList({
  handle,
  options,
  activeAgentIds,
}: {
  handle: MentionListHandle;
  options: readonly MentionOption[];
  activeAgentIds: ReadonlySet<string>;
}) {
  const list = usePart(
    handle,
    'list',
    {},
    {
      'aria-label': '提及智能体',
      className:
        'mb-2 max-h-56 overflow-y-auto rounded-popover border border-line bg-surface py-1 shadow-md',
      children: options.map((option) => (
        <MentionListItem
          key={option.agentId}
          handle={handle}
          value={option.agentId}
          name={option.name}
          active={activeAgentIds.has(option.agentId)}
        />
      )),
    },
    'div',
  );
  return usePart(
    handle,
    'root',
    {},
    {
      className: 'mx-auto w-full max-w-220 shrink-0 px-6',
      children: list,
    },
    'div',
  );
}
