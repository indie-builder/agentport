import { z } from 'zod';
import {
  AGENT_PACKAGE_MAX_ENTRIES,
  AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES,
} from './agent-package.js';
import { slugSchema } from './params.js';
import { pluginFileInputSchema } from './plugin.js';
import { hasEmbeddedCredentials, parseUrl } from './url.js';
import { utf8Bytes } from './utf8.js';

export const NATIVE_PLUGINS_QUEUE = 'native-plugins';

export const NATIVE_PLUGIN_TIMEOUT_MS = 120_000;
export const NATIVE_PLUGIN_WAIT_TIMEOUT_MS = NATIVE_PLUGIN_TIMEOUT_MS + 30_000;

const pluginNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const githubRepoPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function hasWhitespaceOrControl(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      c <= 0x20 ||
      c === 0x7f ||
      c === 0xa0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000 ||
      c === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

export const nativePluginMarketplaceSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !hasWhitespaceOrControl(value), '市场来源不能包含空白或控制字符')
  .refine((value) => !value.startsWith('-'), '市场来源不能以 - 开头')
  .refine((value) => {
    if (githubRepoPattern.test(value)) return true;
    if (!/^https:\/\//i.test(value)) return false;
    const url = parseUrl(value);
    return url !== null && url.hostname !== '' && !hasEmbeddedCredentials(url);
  }, '市场来源只接受 GitHub owner/repo 或 https URL');

export const nativePluginNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(pluginNamePattern, '插件名只允许小写字母、数字和 -');

export const nativePluginIdSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*@[A-Za-z0-9][A-Za-z0-9._-]*$/,
    '插件标识必须形如 name@marketplace',
  );

export const nativeInstalledPluginSchema = z.object({
  pluginId: nativePluginIdSchema,
  version: z.string().max(64).default(''),
});

export type NativeInstalledPlugin = z.infer<typeof nativeInstalledPluginSchema>;

export const nativePluginActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({
    action: z.literal('install'),
    marketplace: nativePluginMarketplaceSchema,
    plugin: nativePluginNameSchema,
  }),
  z.object({ action: z.literal('read'), pluginId: nativePluginIdSchema }),
]);

export type NativePluginAction = z.infer<typeof nativePluginActionSchema>;

const nativePluginFilesSchema = z
  .array(pluginFileInputSchema)
  .max(AGENT_PACKAGE_MAX_ENTRIES, `插件文件数超过 ${AGENT_PACKAGE_MAX_ENTRIES} 个`)
  .superRefine((files, ctx) => {
    const total = files.reduce((sum, file) => sum + utf8Bytes(file.content), 0);
    if (total > AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `插件文件总大小超过 ${AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES} 字节`,
      });
    }
  });

export const nativePluginOutputSchema = z.union([
  z.object({ ok: z.literal(true), installed: z.array(nativeInstalledPluginSchema) }),
  z.object({
    ok: z.literal(true),
    plugin: nativeInstalledPluginSchema,
    files: nativePluginFilesSchema,
  }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

export type NativePluginOutput = z.infer<typeof nativePluginOutputSchema>;

export const nativePluginInstallInputSchema = z.object({
  marketplace: nativePluginMarketplaceSchema,
  plugin: nativePluginNameSchema,
  slug: slugSchema.optional(),
});

export type NativePluginInstallInput = z.infer<typeof nativePluginInstallInputSchema>;

export const nativePluginImportInputSchema = z.object({
  pluginId: nativePluginIdSchema,
  slug: slugSchema.optional(),
});

export type NativePluginImportInput = z.infer<typeof nativePluginImportInputSchema>;
