import { errorText, segmentOpenUi } from '@agentport/shared';
import { createParser, mergeStatements, type ParseResult } from '@openuidev/lang-core';
import librarySpec from './generated/openui.spec.json' with { type: 'json' };

const parser = createParser(librarySpec.schema, librarySpec.root);

function parsesUsable(program: string): boolean {
  if (program.trim() === '') return false;
  return isUsable(parser.parse(program));
}

function isUsable(result: ParseResult): boolean {
  return (
    result.root !== null && result.meta.incomplete !== true && result.meta.unresolved.length === 0
  );
}

function isCompleteReplacement(result: ParseResult): boolean {
  return isUsable(result) && !result.meta.errors.some((error) => error.code === 'no-root');
}

interface OpenUiDiagnostic {
  blockKey: string;
  code: 'missing-baseline' | 'merge-failed' | 'invalid-program';
  message: string;
}

interface OpenUiResolution {
  text: string;
  diagnostics: OpenUiDiagnostic[];
}

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

    if (patch.trim() === '') continue;

    const base = baseline.get(blockKey);
    const parsedPatch = parser.parse(patch);

    if (isCompleteReplacement(parsedPatch)) {
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

    if (parsedPatch.meta.statementCount === 0) {
      diagnostics.push({
        blockKey,
        code: 'invalid-program',
        message: `UI segment ${blockKey} contains no valid openui-lang statements; keeping the original segment`,
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
        message: errorText(error),
      });
      parts.push(fence(patch));
      continue;
    }

    if (!parsesUsable(merged)) {
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

  for (const [blockKey, program] of baseline) {
    if (covered.has(blockKey)) continue;
    parts.push(fence(program.trim()));
  }

  return { text: joinParts(parts), diagnostics };
}

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

export function resolveOpenUiResponse(previous: string, response: string): string {
  return resolveOpenUiResponseDetailed(previous, response).text;
}
