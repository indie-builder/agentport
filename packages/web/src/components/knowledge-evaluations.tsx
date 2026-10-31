import { knowledgeTargetSchema } from '@agentport/shared';
import { useState } from 'react';
import { z } from 'zod';
import { errorMessage } from '../lib/api.js';
import { useEvaluateKnowledgeRetrieval } from '../lib/queries.js';
import { Button } from './ui/button.js';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from './ui/field.js';
import { Input } from './ui/input.js';
import { Switch } from './ui/switch.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';
import { Textarea } from './ui/textarea.js';

const targetsSchema = z.array(knowledgeTargetSchema).min(1).max(50);
const chunkIdsSchema = z.array(z.string().min(1)).max(100);

export function KnowledgeEvaluations({ baseId }: { baseId: string }) {
  const evaluation = useEvaluateKnowledgeRetrieval(baseId);
  const [query, setQuery] = useState('');
  const [targets, setTargets] = useState('');
  const [chunks, setChunks] = useState('');
  const [limit, setLimit] = useState('10');
  const [rerank, setRerank] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pending = evaluation.isPending;
  const report = evaluation.data;
  const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const expectedTargets = targetsSchema.safeParse(
            targets
              .split(/[\n,]/)
              .map((value) => value.trim())
              .filter(Boolean)
              .map((value) => {
                const colon = value.indexOf(':');
                return { kind: value.slice(0, colon), id: value.slice(colon + 1) };
              }),
          );
          const expectedChunkIds = chunkIdsSchema.safeParse(
            chunks
              .split(/[\n,]/)
              .map((value) => value.trim())
              .filter(Boolean),
          );
          if (
            !expectedTargets.success ||
            !expectedChunkIds.success ||
            !query.trim() ||
            query.trim().length > 500
          ) {
            setError('请填写 1–500 字的查询、1–50 个有效目标与最多 100 个分块 ID。');
            return;
          }
          setError(null);
          evaluation.mutate(
            {
              cases: [
                {
                  q: query.trim(),
                  expectedTargets: expectedTargets.data,
                  ...(expectedChunkIds.data.length
                    ? { expectedChunkIds: expectedChunkIds.data }
                    : {}),
                },
              ],
              limit: Number(limit),
              rerank,
            },
            { onError: (reason) => setError(errorMessage(reason)) },
          );
        }}
      >
        <FieldGroup className="grid grid-cols-2 gap-5">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="knowledge-evaluation-query">查询</FieldLabel>
            <Textarea
              id="knowledge-evaluation-query"
              value={query}
              disabled={pending}
              maxLength={500}
              required
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          <Field className="gap-1.5" data-invalid={error !== null}>
            <FieldLabel htmlFor="knowledge-evaluation-targets">期望目标</FieldLabel>
            <Textarea
              id="knowledge-evaluation-targets"
              value={targets}
              disabled={pending}
              required
              aria-invalid={error !== null}
              aria-describedby="knowledge-evaluation-target-format"
              onChange={(event) => setTargets(event.target.value)}
            />
            <FieldDescription id="knowledge-evaluation-target-format">
              每行一个 document:ID、faq:ID 或 wiki:ID。
            </FieldDescription>
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="knowledge-evaluation-chunks">期望分块 ID（可选）</FieldLabel>
            <Textarea
              id="knowledge-evaluation-chunks"
              value={chunks}
              disabled={pending}
              onChange={(event) => setChunks(event.target.value)}
            />
          </Field>
          <div className="flex flex-col items-start gap-4">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="knowledge-evaluation-limit">检索条数 K</FieldLabel>
              <Input
                id="knowledge-evaluation-limit"
                className="w-28"
                type="number"
                min={1}
                max={50}
                step={1}
                required
                value={limit}
                disabled={pending}
                onChange={(event) => setLimit(event.target.value)}
              />
            </Field>
            <Field orientation="horizontal" className="gap-2">
              <Switch
                id="knowledge-evaluation-rerank"
                checked={rerank}
                disabled={pending}
                onCheckedChange={setRerank}
              />
              <FieldLabel htmlFor="knowledge-evaluation-rerank">重排</FieldLabel>
            </Field>
          </div>
        </FieldGroup>
        <FieldError role="alert">{error}</FieldError>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!report || pending}
            onClick={() => {
              if (!report) return;
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = `retrieval-evaluation-${baseId}.json`;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            下载结果
          </Button>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? '评估中…' : '运行评估'}
          </Button>
        </div>
      </form>
      {report ? (
        <Table aria-label="检索评估结果">
          <TableHeader>
            <TableRow>
              <TableHead>查询</TableHead>
              <TableHead>命中</TableHead>
              <TableHead>Recall@K</TableHead>
              <TableHead>MRR</TableHead>
              <TableHead>分块 Recall@K</TableHead>
              <TableHead>耗时</TableHead>
              <TableHead>警告</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.results.map((result) => (
              <TableRow key={result.q}>
                <TableCell>{result.q}</TableCell>
                <TableCell>{result.hit ? '命中' : '未命中'}</TableCell>
                <TableCell>{percent(result.recallAtK)}</TableCell>
                <TableCell>{result.reciprocalRank.toFixed(3)}</TableCell>
                <TableCell>{percent(result.chunkRecallAtK)}</TableCell>
                <TableCell>{result.elapsedMs} ms</TableCell>
                <TableCell>
                  {result.degraded ? '检索降级 ' : ''}
                  {result.warnings.map((warning) => warning.message).join('；') || '—'}
                </TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell>总体</TableCell>
              <TableCell>—</TableCell>
              <TableCell>{percent(report.recallAtK)}</TableCell>
              <TableCell>{report.mrr.toFixed(3)}</TableCell>
              <TableCell>{percent(report.chunkRecallAtK)}</TableCell>
              <TableCell>—</TableCell>
              <TableCell>—</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}
