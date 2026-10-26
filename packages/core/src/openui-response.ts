import { segmentOpenUi } from '@agentport/shared';
import { createParser, mergeStatements, type ParseResult } from '@openuidev/lang-core';
import librarySpec from './generated/openui.spec.json' with { type: 'json' };

/**
 * 跨轮 editMode 的合并：把本轮回复里的每个 UI 段与上一轮同序号段的完整程序合并，
 * 返回「Markdown + 每段完整程序」的混合文本，作为这条消息的 `ui_program`。
 *
 * 返回值是这条消息的**完整快照**（worker 直接落库）：
 * - 本轮 Markdown 与 UI 段保持原顺序；
 * - 本轮没提到的上一轮 UI 段追加到末尾，各自带完整程序（原独立 root），不重复旧 Markdown；
 * - 只有显式写出空围栏才算删除该段，静默消失不算。
 *
 * 规则（不能猜）：
 * - 本轮某段本身是完整、可独立解析的程序（有 root 且无解析错误）→ 它是新程序，不合并；
 * - 否则若上一轮有同序号段 → 用官方 mergeStatements 合并；合并后仍不可解析则保留原文；
 * - 上一轮没有同序号基线 → 保留原文并产生诊断，不把半截补丁当完整界面。
 */

const parser = createParser(librarySpec.schema, librarySpec.root);

/** 程序能否独立渲染：有根节点、已写完、无校验错误、没有引用未定义语句。 */
function parsesComplete(program: string): boolean {
  if (program.trim() === '') return false;
  return isComplete(parser.parse(program));
}

function isComplete(result: ParseResult): boolean {
  return (
    result.root !== null &&
    result.meta.incomplete !== true &&
    result.meta.errors.length === 0 &&
    // 解析器会把未定义引用当 null 丢弃；有它就不是完整界面。
    result.meta.unresolved.length === 0
  );
}

export interface OpenUiDiagnostic {
  blockKey: string;
  code: 'missing-baseline' | 'merge-failed' | 'invalid-program';
  message: string;
}

export interface OpenUiResolution {
  /** 完整混合文本：本轮 Markdown 与每段完整程序，未提段追加在末尾。 */
  text: string;
  diagnostics: OpenUiDiagnostic[];
}

/** 围栏语言与 shared 分段器一致，保证重建结果能被再次切分。 */
function fence(program: string): string {
  return `\`\`\`openui-lang\n${program}\n\`\`\``;
}

export function resolveOpenUiResponseDetailed(
  previous: string,
  response: string,
): OpenUiResolution {
  const baseline = new Map<string, string>(
    segmentOpenUi(previous)
      .filter((segment) => segment.kind === 'openui')
      .map((segment) => [segment.blockKey ?? 's0', segment.text]),
  );

  const diagnostics: OpenUiDiagnostic[] = [];
  const covered = new Set<string>();
  const parts: string[] = [];

  for (const segment of segmentOpenUi(response)) {
    if (segment.kind === 'markdown') {
      parts.push(segment.text);
      continue;
    }

    const blockKey = segment.blockKey ?? 's0';
    const patch = segment.text;
    covered.add(blockKey);

    // 显式空围栏 = 删除声明；整段（含围栏）不进入快照。
    if (patch.trim() === '') continue;

    const base = baseline.get(blockKey);

    if (parsesComplete(patch)) {
      // 完整程序（含全新一轮的界面）不需要基线。
      parts.push(fence(patch));
      continue;
    }

    if (base === undefined) {
      diagnostics.push({
        blockKey,
        code: 'missing-baseline',
        message: `UI segment ${blockKey} is not a complete program and there is no previous program to patch`,
      });
      parts.push(fence(patch));
      continue;
    }

    let merged: string;
    try {
      merged = mergeStatements(base.trim(), patch.trim(), 'root').trim();
    } catch (error) {
      diagnostics.push({
        blockKey,
        code: 'merge-failed',
        message: error instanceof Error ? error.message : String(error),
      });
      parts.push(fence(patch));
      continue;
    }

    if (!parsesComplete(merged)) {
      diagnostics.push({
        blockKey,
        code: 'invalid-program',
        message: `merged program for ${blockKey} does not parse; keeping the original segment`,
      });
      parts.push(fence(patch));
      continue;
    }
    parts.push(fence(merged));
  }

  // 未提 UI 段保留：追加在末尾，保持上一轮的 sN 顺序与各自的完整程序。
  for (const [blockKey, program] of baseline) {
    if (covered.has(blockKey)) continue;
    parts.push(fence(program.trim()));
  }

  return { text: joinParts(parts), diagnostics };
}

/** 段与段之间一个空行；单段（纯文字）原样返回。 */
function joinParts(parts: string[]): string {
  const kept = parts.filter((part) => part.trim() !== '');
  if (kept.length <= 1) return kept[0] ?? '';
  return kept
    .map((part, index) => {
      let value = part;
      if (index > 0) value = value.trimStart();
      if (index < kept.length - 1) value = value.trimEnd();
      return value;
    })
    .join('\n\n');
}

/** 固定契约：返回合并后的完整混合文本；诊断走 `resolveOpenUiResponseDetailed`。 */
export function resolveOpenUiResponse(previous: string, response: string): string {
  return resolveOpenUiResponseDetailed(previous, response).text;
}
