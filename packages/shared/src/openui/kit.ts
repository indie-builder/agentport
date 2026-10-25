import type { z } from 'zod';

/**
 * 组件定义的构建原语。`shared` 只依赖 zod，两端各自注入官方实现：
 * - core：只需要 spec，不含渲染器；
 * - web：`@openuidev/react-lang` 的 defineComponent / action / reactive。
 *
 * `reactive` 由官方实现标记字段并返回原 schema；这里只放宽类型，
 * 不复制它的语义。`C` 是各框架自己的渲染器类型。
 */
export interface OpenUiKit<C> {
  defineComponent<T extends z.core.$ZodObject>(config: {
    name: string;
    description: string;
    props: T;
    component: C;
  }): OpenUiDefinedComponent<C, T>;
  action(): z.core.$ZodType & { optional(): z.core.$ZodType };
  reactive<T extends z.ZodType>(schema: T): z.core.$ZodType;
}

export interface OpenUiDefinedComponent<C, T extends z.core.$ZodObject = z.core.$ZodObject> {
  name: string;
  description: string;
  props: T;
  component: C;
  ref: z.core.$ZodType;
}

export interface OpenUiDefinitions<C> {
  root: string;
  components: OpenUiDefinedComponent<C>[];
  componentGroups: Array<{ name: string; components: string[]; notes?: string[] }>;
}
