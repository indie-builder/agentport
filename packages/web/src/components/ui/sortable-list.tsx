'use client';

import {
  type ChangeDetails,
  createChange,
  createReorder,
  definePrimitive,
  prepareAnnouncements,
  type ReorderDraft,
  type ReorderReason,
} from '@ui-sdk/core';
import { createParts } from '@ui-sdk/react/primitive';

type SortableListOptions = {
  value: string[];
  labels: Record<string, string>;
  onValueChange: (value: string[], details: ChangeDetails<ReorderReason>) => void;
};

const sortableList = definePrimitive({
  name: 'sortable-list',
  options: { value: 'list', labels: 'value', onValueChange: 'callback' },
  controlled: ['value'],
  state: (options: SortableListOptions) => ({
    value: options.value,
    moving: null as ReorderDraft | null,
  }),
  sync: (options) => ({ value: options.value }),
  api: (context) => {
    const change = createChange(context);
    const reorder = createReorder(context, {
      slot: 'item',
      key: 'value',
      draft: 'moving',
      set: (value, details) => change('value', value, details),
      preview: true,
      label: (key) => context.options().labels[key],
      message: ({ type, label, position, total }) => {
        switch (type) {
          case 'grab':
            return `已拾取「${label}」，第 ${position} 项，共 ${total} 项。使用方向键调整顺序，空格或回车放下，Escape 取消。`;
          case 'move':
            return `「${label}」已移到第 ${position} 项，共 ${total} 项。`;
          case 'drop':
            return `已放下「${label}」，第 ${position} 项，共 ${total} 项。`;
          case 'cancel':
            return `已取消调整「${label}」顺序。`;
        }
      },
    });
    const focusHandle = (key: string): void => {
      queueMicrotask(() => context.element('handle', key)?.focus({ preventScroll: true }));
    };
    const move = (value: string, toIndex: number): boolean => {
      const order = reorder.order(context.store.get());
      if (typeof value !== 'string' || !order.includes(value)) {
        throw new Error(`Unknown item "${String(value)}". Items: ${order.join(', ')}.`);
      }
      if (
        typeof toIndex !== 'number' ||
        !Number.isInteger(toIndex) ||
        toIndex < 0 ||
        toIndex >= order.length
      ) {
        throw new Error(`Index ${String(toIndex)} out of range (0-${order.length - 1}).`);
      }
      return reorder.move(value, toIndex);
    };
    const items = () => {
      const { labels } = context.options();
      return reorder
        .order(context.store.get())
        .map((value) => ({ value, label: labels[value] ?? value }));
    };
    return { reorder, move, items, focusHandle };
  },
  slots: (slot) => ({
    root: slot<Record<never, never>, { order: string[] }>({
      state: (state, { api }) => ({ order: api.reorder.order(state) }),
      attrs: (state) => ({ 'data-moving': state.moving ? '' : undefined }),
      on: {
        keydown: (event, { api, store }) => {
          if (event.defaultPrevented) return;
          if (event.key !== 'Escape' && event.key !== 'Tab') return;
          const moving = store.get().moving;
          if (!moving || moving.pointer) return;
          if (!api.reorder.keydown(event, '')) return;
          if (event.key !== 'Escape') return;
          api.focusHandle(moving.key);
        },
      },
      bind: (el, part) => {
        prepareAnnouncements(el.ownerDocument);
        const onClick = (event: MouseEvent) => {
          const moving = part.store.get().moving;
          if (!moving || moving.pointer) return;
          if (!(event.target instanceof Element)) return;
          if (!event.target.closest('[data-reorder-control]')) return;
          part.api.reorder.cancel();
        };
        const onKeydown = (event: KeyboardEvent) => {
          const moving = part.store.get().moving;
          if (!moving || moving.pointer || event.key !== 'Escape') return;
          if (event.target instanceof Node && el.contains(event.target)) return;
          if (part.api.reorder.keydown(event, '')) event.stopPropagation();
        };
        el.addEventListener('click', onClick, true);
        el.ownerDocument.addEventListener('keydown', onKeydown, true);
        return () => {
          el.removeEventListener('click', onClick, true);
          el.ownerDocument.removeEventListener('keydown', onKeydown, true);
        };
      },
    }),
    item: slot<{ value: string }>({
      props: { value: 'string' },
      attrs: (state, { api, key }) => ({
        'data-moving': api.reorder.moving(state, key) ? '' : undefined,
      }),
      bind: (el, part) => part.api.reorder.bind(el, part),
    }),
    handle: slot<{ value: string }>({
      props: { value: 'string' },
      attrs: () => ({
        type: 'button',
        'aria-description':
          '按空格或回车拾取，方向键调整顺序，Home 或 End 移到两端，空格或回车放下，Escape 取消，Tab 取消并离开。',
      }),
      on: {
        keydown: (event, { api, key }) => {
          if (api.reorder.keydown(event, key) && event.key !== 'Tab') {
            api.focusHandle(key);
          }
        },
        pointerdown: (event, { api, key, el }) => {
          el?.focus({ preventScroll: true });
          api.reorder.pointerdown(event, key);
        },
      },
    }),
  }),
  agent: {
    actions: ['move'],
    items: (api) => api.items(),
  },
});

const {
  Root: SortableList,
  Item: SortableListItem,
  Handle: SortableListHandle,
} = createParts(sortableList, { root: 'fieldset', item: 'div', handle: 'button' });

export { SortableList, SortableListHandle, SortableListItem };
