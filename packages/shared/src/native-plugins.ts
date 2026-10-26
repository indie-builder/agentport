import { z } from 'zod';
import {
  AGENT_PACKAGE_MAX_ENTRIES,
  AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES,
} from './agent-package.js';
import { slugSchema } from './params.js';
import { pluginFileInputSchema } from './plugin.js';

/**
 * 原生插件安装：官方 CLI 在一次性沙盒里安装/读取市场插件，再把文本快照交回平台。
 * 这里只定义队列、动作与沙盒输出的信任边界，宿主路径不出沙盒。
 */

export const NATIVE_PLUGINS_QUEUE = 'native-plugins';

/** 沙盒容器内 CLI 安装 + 读取的总预算。 */
export const NATIVE_PLUGIN_TIMEOUT_MS = 120_000;
/** API 等待整个队列任务的上限，必须大于容器预算。 */
export const NATIVE_PLUGIN_WAIT_TIMEOUT_MS = 150_000;

const pluginNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const githubRepoPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

type ParsedUrl = { username: string; password: string; hostname: string };

/** shared 不带 DOM/Node lib，与 mcp.ts 一样声明最小 URL 形状。 */
function parseUrl(value: string): ParsedUrl | null {
  try {
    return new (globalThis as unknown as { URL: new (value: string) => ParsedUrl }).URL(value);
  } catch {
    return null;
  }
}

/** 等价于 `/[\s\x00-\x1f\x7f]/`，按码点判断，避开正则里的控制字符转义。 */
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

/** 市场来源只接受 GitHub owner/repo 与 https Git/marketplace URL；不开放本地路径或命令。 */
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
    return url !== null && url.hostname !== '' && !url.username && !url.password;
  }, '市场来源只接受 GitHub owner/repo 或 https URL');

/** 市场里的插件名：kebab-case，不带 `@`。 */
export const nativePluginNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(pluginNamePattern, '插件名只允许小写字母、数字和 -');

/** 官方目录里的插件标识 `name@marketplace`。 */
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

/** 沙盒 stdin 的动作；只此三种，不接受任意命令或参数。 */
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

/** shared 无 Node lib；按 UTF-8 字节校验总大小。 */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** 快照沿用 ZIP 导入的上限：条目数同包，单文件字符数由 pluginFileInputSchema 限制。 */
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

/**
 * 沙盒 stdout 的单行结果。两个成功分支都以 ok:true，所以用 z.union（不能用
 * discriminatedUnion，重复判别值会抛错）；worker 先判 !ok，再用 `'installed' in out`
 * 区分 list 与 read，类型可窄化。
 */
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
