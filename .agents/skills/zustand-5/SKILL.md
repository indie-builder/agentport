---
name: zustand-5
description: >
  Zustand 5 state management patterns.
  Trigger: When implementing client-side state with Zustand (stores, selectors, persist middleware, slices).
license: Apache-2.0
metadata:
  author: prowler-cloud
  version: "1.0"
  scope: [root, ui]
  auto_invoke: "Using Zustand stores"
---

> **Project convention（适用于本文件及关联引用）：** Zustand 5 只用于本项目跨组件、非服务端的共享客户端交互状态，按业务域复用现有 store（当前 `packages/web/src/lib/chat-store.ts`：流式展示投影与未发送草稿生命周期），不按页面并排新建同类 store。读取用原子 selector；组合对象或数组时保持引用稳定，按需使用 `useShallow`，不整 store 订阅。更新保持不可变。服务端状态用 TanStack Query，可导航状态用 TanStack Router，平台资源编辑表单用 `useZodForm`/RHF，生成式表单走 OpenUI 官方运行时，组件私有临时状态留本地 state。上游的直连 `fetch` 示例只作 store 写法参考，不据此另造服务端 cache；不引入 Immer、SSR 或新的持久化层（现有草稿持久化是既有实现）。版本以 `skills-lock.json` 与已安装 `zustand@5.0.16` 为准。

## Basic Store

```typescript
import { create } from "zustand";

interface CounterStore {
  count: number;
  increment: () => void;
  decrement: () => void;
  reset: () => void;
}

const useCounterStore = create<CounterStore>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
  decrement: () => set((state) => ({ count: state.count - 1 })),
  reset: () => set({ count: 0 }),
}));

// Usage
function Counter() {
  const { count, increment, decrement } = useCounterStore();
  return (
    <div>
      <span>{count}</span>
      <button onClick={increment}>+</button>
      <button onClick={decrement}>-</button>
    </div>
  );
}
```

## Persist Middleware

```typescript
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsStore {
  theme: "light" | "dark";
  language: string;
  setTheme: (theme: "light" | "dark") => void;
  setLanguage: (language: string) => void;
}

const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      theme: "light",
      language: "en",
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
    }),
    {
      name: "settings-storage",  // localStorage key
    }
  )
);
```

## Selectors (Zustand 5)

```typescript
// ✅ Select specific fields to prevent unnecessary re-renders
function UserName() {
  const name = useUserStore((state) => state.name);
  return <span>{name}</span>;
}

// ✅ For multiple fields, use useShallow
import { useShallow } from "zustand/react/shallow";

function UserInfo() {
  const { name, email } = useUserStore(
    useShallow((state) => ({ name: state.name, email: state.email }))
  );
  return <div>{name} - {email}</div>;
}

// ❌ AVOID: Selecting entire store (causes re-render on any change)
const store = useUserStore();  // Re-renders on ANY state change
```

## Async Actions

```typescript
interface UserStore {
  user: User | null;
  loading: boolean;
  error: string | null;
  fetchUser: (id: string) => Promise<void>;
}

const useUserStore = create<UserStore>((set) => ({
  user: null,
  loading: false,
  error: null,

  fetchUser: async (id) => {
    set({ loading: true, error: null });
    try {
      const response = await fetch(`/api/users/${id}`);
      const user = await response.json();
      set({ user, loading: false });
    } catch (error) {
      set({ error: "Failed to fetch user", loading: false });
    }
  },
}));
```

## Slices Pattern

```typescript
// userSlice.ts
interface UserSlice {
  user: User | null;
  setUser: (user: User) => void;
  clearUser: () => void;
}

const createUserSlice = (set): UserSlice => ({
  user: null,
  setUser: (user) => set({ user }),
  clearUser: () => set({ user: null }),
});

// cartSlice.ts
interface CartSlice {
  items: CartItem[];
  addItem: (item: CartItem) => void;
  removeItem: (id: string) => void;
}

const createCartSlice = (set): CartSlice => ({
  items: [],
  addItem: (item) => set((state) => ({ items: [...state.items, item] })),
  removeItem: (id) => set((state) => ({
    items: state.items.filter(i => i.id !== id)
  })),
});

// store.ts
type Store = UserSlice & CartSlice;

const useStore = create<Store>()((...args) => ({
  ...createUserSlice(...args),
  ...createCartSlice(...args),
}));
```

## Immer Middleware

```typescript
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

interface TodoStore {
  todos: Todo[];
  addTodo: (text: string) => void;
  toggleTodo: (id: string) => void;
}

const useTodoStore = create<TodoStore>()(
  immer((set) => ({
    todos: [],

    addTodo: (text) => set((state) => {
      // Mutate directly with Immer!
      state.todos.push({ id: crypto.randomUUID(), text, done: false });
    }),

    toggleTodo: (id) => set((state) => {
      const todo = state.todos.find(t => t.id === id);
      if (todo) todo.done = !todo.done;
    }),
  }))
);
```

## DevTools

```typescript
import { create } from "zustand";
import { devtools } from "zustand/middleware";

const useStore = create<Store>()(
  devtools(
    (set) => ({
      // store definition
    }),
    { name: "MyStore" }  // Name in Redux DevTools
  )
);
```

## Outside React

```typescript
// Access store outside components
const { count, increment } = useCounterStore.getState();
increment();

// Subscribe to changes
const unsubscribe = useCounterStore.subscribe(
  (state) => console.log("Count changed:", state.count)
);
```
