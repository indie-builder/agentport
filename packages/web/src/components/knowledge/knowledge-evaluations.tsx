import { knowledgeTargetSchema } from '@agentport/shared';
import { useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { errorMessage } from '../../lib/api.js';
import { downloadJson } from '../../lib/browser-files.js';
import { useEvaluateKnowledgeRetrieval } from '../../lib/queries.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import { Button } from '../ui/button.js';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../ui/field.js';
import {
  NumberInput,
  NumberInputControl,
  NumberInputDecrement,
  NumberInputGroup,
  NumberInputIncrement,
} from '../ui/number-input.js';
import { Switch } from '../ui/switch.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { Textarea } from '../ui/textarea.js';

function parseTargets(raw: string) {
  return raw
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const colon = value.indexOf(':');
      return colon <= 0
        ? { kind: '', id: value }
        : { kind: value.slice(0, colon), id: value.slice(colon + 1) };
    });
}

function parseChunkIds(raw: string) {
  return raw
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

const targetsSchema = z
  .array(knowledgeTargetSchema.extend({ id: z.string().min(1) }))
  .min(1)
  .max(50);
const chunkIdsSchema = z.array(z.string().min(1)).max(100);

const evaluationFormSchema = z.object({
  query: z.string().trim().min(1, '请填写查询内容').max(500, '查询不能超过 500 字'),
  targets: z
    .string()
    .superRefine((raw, ctx) => {
      if (!targetsSchema.safeParse(parseTargets(raw)).success) {
        ctx.addIssue({
          code: 'custom',
          message: '请填写 1–50 个有效目标（document:ID、faq:ID 或 wiki:ID）',
        });
      }
    })
    .transform((raw) => targetsSchema.parse(parseTargets(raw))),
  chunks: z
    .string()
    .superRefine((raw, ctx) => {
      if (!chunkIdsSchema.safeParse(parseChunkIds(raw)).success) {
        ctx.addIssue({
          code: 'custom',
          message: '最多填写 100 个分块 ID',
        });
      }
    })
    .transform((raw) => chunkIdsSchema.parse(parseChunkIds(raw))),
  limit: z
    .string()
    .trim()
    .refine((raw) => {
      if (raw === '') return false;
      const next = Number(raw);
      return Number.isInteger(next) && next >= 1 && next <= 50;
    }, '检索条数 K 需为 1–50 的整数')
    .transform((raw) => Number(raw)),
  rerank: z.boolean(),
});

export function KnowledgeEvaluations({
  baseId,
  canExecute,
}: {
  baseId: string;
  canExecute: boolean;
}) {
  const evaluation = useEvaluateKnowledgeRetrieval(baseId);
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, control, formState } = useZodForm(evaluationFormSchema, {
    defaultValues: {
      query: '',
      targets: '',
      chunks: '',
      limit: '10',
      rerank: true,
    },
  });
  const { errors } = formState;
  const pending = evaluation.isPending;
  const report = evaluation.data;
  const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);

  const submit = handleSubmit((values) => {
    if (!canExecute || pending) return;
    setFormError(null);
    evaluation.mutate(
      {
        cases: [
          {
            q: values.query,
            expectedTargets: values.targets,
            ...(values.chunks.length ? { expectedChunkIds: values.chunks } : {}),
          },
        ],
        limit: values.limit,
        rerank: values.rerank,
      },
      { onError: (reason) => setFormError(errorMessage(reason)) },
    );
  });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canExecute) return;
          void submit();
        }}
      >
        <FieldGroup className="grid grid-cols-2 gap-5">
          <Field className="gap-1.5" data-invalid={Boolean(errors.query)}>
            <FieldLabel htmlFor="knowledge-evaluation-query">查询</FieldLabel>
            <Textarea
              id="knowledge-evaluation-query"
              disabled={pending}
              maxLength={500}
              aria-invalid={Boolean(errors.query)}
              aria-describedby={errors.query ? 'knowledge-evaluation-query-error' : undefined}
              {...register('query')}
            />
            <FieldError id="knowledge-evaluation-query-error">{errors.query?.message}</FieldError>
          </Field>
          <Field className="gap-1.5" data-invalid={Boolean(errors.targets)}>
            <FieldLabel htmlFor="knowledge-evaluation-targets">期望目标</FieldLabel>
            <Textarea
              id="knowledge-evaluation-targets"
              disabled={pending}
              aria-invalid={Boolean(errors.targets)}
              aria-describedby={
                errors.targets
                  ? 'knowledge-evaluation-target-format knowledge-evaluation-targets-error'
                  : 'knowledge-evaluation-target-format'
              }
              {...register('targets')}
            />
            <FieldDescription id="knowledge-evaluation-target-format">
              每行一个 document:ID、faq:ID 或 wiki:ID。
            </FieldDescription>
            <FieldError id="knowledge-evaluation-targets-error">
              {errors.targets?.message}
            </FieldError>
          </Field>
          <Field className="gap-1.5" data-invalid={Boolean(errors.chunks)}>
            <FieldLabel htmlFor="knowledge-evaluation-chunks">期望分块 ID（可选）</FieldLabel>
            <Textarea
              id="knowledge-evaluation-chunks"
              disabled={pending}
              aria-invalid={Boolean(errors.chunks)}
              aria-describedby={errors.chunks ? 'knowledge-evaluation-chunks-error' : undefined}
              {...register('chunks')}
            />
            <FieldError id="knowledge-evaluation-chunks-error">{errors.chunks?.message}</FieldError>
          </Field>
          <div className="flex flex-col items-start gap-4">
            <Field className="gap-1.5" data-invalid={Boolean(errors.limit)}>
              <FieldLabel htmlFor="knowledge-evaluation-limit">检索条数 K</FieldLabel>
              <Controller
                control={control}
                name="limit"
                render={({ field }) => {
                  const trimmed = field.value.trim();
                  const parsed = trimmed === '' ? Number.NaN : Number(trimmed);
                  return (
                    <NumberInput
                      value={Number.isFinite(parsed) ? parsed : null}
                      step={1}
                      disabled={pending}
                      className="w-32 max-w-32"
                      onValueChange={(next, details) => {
                        if (details.reason === 'input-commit') {
                          details.cancel();
                          return;
                        }
                        field.onChange(next === null ? '' : String(next));
                      }}
                    >
                      <NumberInputGroup>
                        <NumberInputDecrement />
                        <NumberInputControl
                          ref={field.ref}
                          id="knowledge-evaluation-limit"
                          inputMode="numeric"
                          onBlur={field.onBlur}
                        />
                        <NumberInputIncrement />
                      </NumberInputGroup>
                    </NumberInput>
                  );
                }}
              />
              <FieldError id="knowledge-evaluation-limit-error">{errors.limit?.message}</FieldError>
            </Field>
            <Controller
              control={control}
              name="rerank"
              render={({ field }) => (
                <Field orientation="horizontal" className="gap-2">
                  <Switch
                    id="knowledge-evaluation-rerank"
                    checked={field.value}
                    disabled={pending}
                    onCheckedChange={field.onChange}
                  />
                  <FieldLabel htmlFor="knowledge-evaluation-rerank">重排</FieldLabel>
                </Field>
              )}
            />
          </div>
        </FieldGroup>
        <FieldError id="knowledge-evaluation-error" role="alert">
          {formError}
        </FieldError>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!report || pending}
            onClick={() => {
              if (!report) return;
              downloadJson(report, `retrieval-evaluation-${baseId}.json`);
            }}
          >
            下载结果
          </Button>
          {canExecute ? (
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? '评估中…' : '运行评估'}
            </Button>
          ) : null}
        </div>
      </form>
      {report ? (
        <Table aria-label="检索评估结果">
          <TableHeader>
            <TableRow>
              <TableHead>查询</TableHead>
              <TableHead>命中</TableHead>
              <TableHead className="text-right">Recall@K</TableHead>
              <TableHead className="text-right">MRR</TableHead>
              <TableHead className="text-right">分块 Recall@K</TableHead>
              <TableHead className="text-right">耗时</TableHead>
              <TableHead>警告</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.results.map((result) => (
              <TableRow key={result.q} className="hover:bg-transparent">
                <TableCell>{result.q}</TableCell>
                <TableCell>{result.hit ? '命中' : '未命中'}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {percent(result.recallAtK)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {result.reciprocalRank.toFixed(3)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {percent(result.chunkRecallAtK)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {result.elapsedMs} ms
                </TableCell>
                <TableCell>
                  {result.degraded ? '检索降级 ' : ''}
                  {result.warnings.map((warning) => warning.message).join('；') || '—'}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="hover:bg-transparent">
              <TableCell>总体</TableCell>
              <TableCell>—</TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {percent(report.recallAtK)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {report.mrr.toFixed(3)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {percent(report.chunkRecallAtK)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">—</TableCell>
              <TableCell>—</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}
