import type { z } from 'zod';

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
