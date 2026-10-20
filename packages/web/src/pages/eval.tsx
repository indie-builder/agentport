import { Link } from '@tanstack/react-router';
import { ClipboardCheck, FlaskConical, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { CodeBlock } from '../components/code-block.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { Page, PageHeader, PageNote, PageSection } from '../components/page.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import { FieldError, FieldHint, Input } from '../components/ui/input.js';
import { Label, RequiredMark } from '../components/ui/label.js';
import { Select } from '../components/ui/select.js';
import { Textarea } from '../components/ui/textarea.js';
import type { EvalCase, EvalCaseInput, EvalRun } from '../lib/api.js';
import {
  evalStatusLabel,
  evalStatusVariant,
  formatDateTime,
  formatRelative,
  shortId,
} from '../lib/format.js';
import {
  useAgents,
  useCreateEvalCase,
  useDeleteEvalCase,
  useEvalCases,
  useEvalRun,
  useEvalRuns,
  useStartEvalRun,
  useUpdateEvalCase,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';

const runColumns: DataColumn<EvalRun>[] = [
  {
    id: 'id',
    header: '评估 ID',
    locked: true,
    width: '110px',
    sortValue: (run) => run.id,
    cell: (run) => (
      <code className="font-mono text-xs text-subtle" title={run.id}>
        {shortId(run.id)}
      </code>
    ),
  },
  {
    id: 'status',
    header: '状态',
    locked: true,
    width: '100px',
    sortValue: (run) => run.status,
    cell: (run) => (
      <Badge variant={evalStatusVariant[run.status]} className="rounded-[6px]">
        {run.status === 'running' ? (
          <span className="size-1.5 animate-pulse rounded-full bg-warning" aria-hidden="true" />
        ) : null}
        {evalStatusLabel[run.status]}
      </Badge>
    ),
  },
  {
    id: 'passed',
    header: '通过 / 总数',
    width: '120px',
    sortValue: (run) => (run.total === 0 ? 0 : run.passed / run.total),
    cell: (run) => (
      <span className="font-mono tabular-nums">
        {run.passed} / {run.total}
      </span>
    ),
  },
  {
    id: 'createdAt',
    header: '发起',
    width: '96px',
    sortValue: (run) => run.createdAt,
    cell: (run) => (
      <span className="text-sm text-muted" title={formatDateTime(run.createdAt)}>
        {formatRelative(run.createdAt)}
      </span>
    ),
  },
  {
    id: 'finishedAt',
    header: '结束',
    width: '96px',
    sortValue: (run) => run.finishedAt ?? '',
    cell: (run) => (
      <span className="text-sm text-muted" title={formatDateTime(run.finishedAt)}>
        {formatRelative(run.finishedAt)}
      </span>
    ),
  },
];

export function EvalPage() {
  const agents = useAgents();
  const [agentId, setAgentId] = useState('');
  const effectiveAgentId = agentId || agents.data?.[0]?.id || null;

  const cases = useEvalCases(effectiveAgentId);
  const runs = useEvalRuns(effectiveAgentId);
  const start = useStartEvalRun();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EvalCase | null>(null);
  const [deleting, setDeleting] = useState<EvalCase | null>(null);

  const startRun = (): void => {
    if (!effectiveAgentId) return;
    start.mutate(effectiveAgentId, {
      onSuccess: () => toastSuccess('评估已开始，结果会自动刷新'),
      onError: toastError,
    });
  };

  const latest = runs.data?.[0];

  return (
    <Page>
      <PageHeader
        title="评估"
        actions={
          <Button
            size="sm"
            className="rounded-full"
            onClick={startRun}
            disabled={start.isPending || !effectiveAgentId || (cases.data?.length ?? 0) === 0}
          >
            <Play className="size-4" strokeWidth={1.75} aria-hidden="true" /> 运行评估
          </Button>
        }
      />

      <div className="-mt-3 flex flex-wrap items-center gap-3">
        <Select
          aria-label="按智能体筛选"
          className="w-56 rounded-[9px]"
          value={effectiveAgentId ?? ''}
          onValueChange={setAgentId}
          options={(agents.data ?? []).map((agent) => ({ value: agent.id, label: agent.name }))}
        />
        <span className="text-sm text-subtle">
          判定：期望非空时检查输出包含该文本（不区分大小写）；为空时只要求有文本输出。
        </span>
      </div>

      <PageSection
        title="用例"
        actions={
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={!effectiveAgentId}
            onClick={() => setCreating(true)}
          >
            <Plus className="size-4" strokeWidth={1.75} aria-hidden="true" /> 新建用例
          </Button>
        }
      >
        {effectiveAgentId === null ? (
          <PageNote
            title="还没有智能体"
            description="先创建一个智能体，才能为它编写评估用例。"
            action={
              <Link to="/agents" className="text-sm text-fg underline underline-offset-4">
                前往创建智能体
              </Link>
            }
          />
        ) : null}
        {cases.isPending && effectiveAgentId ? <LoadingState rows={3} /> : null}
        {cases.isError ? (
          <ErrorState error={cases.error} onRetry={() => void cases.refetch()} />
        ) : null}
        {cases.data && cases.data.length === 0 ? (
          <PageNote
            icon={<FlaskConical className="size-4" strokeWidth={1.75} aria-hidden="true" />}
            title="还没有用例"
            description="把线上出过问题的输入写成用例，下次改动前先跑一遍。"
            action={
              <Button size="sm" className="rounded-full" onClick={() => setCreating(true)}>
                <Plus className="size-4" strokeWidth={1.75} aria-hidden="true" /> 新建用例
              </Button>
            }
          />
        ) : null}
        {cases.data && cases.data.length > 0 ? (
          <ul>
            {cases.data.map((testCase) => (
              <li
                key={testCase.id}
                className="group flex items-start gap-3 rounded-[9px] px-3 py-4 transition-colors duration-150 hover:bg-hover"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-md font-medium text-fg">{testCase.name}</div>
                  <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm leading-relaxed text-muted">
                    {testCase.prompt}
                  </p>
                  <p className="mt-1 truncate text-xs text-subtle">
                    {testCase.expectation
                      ? `期望包含：${testCase.expectation}`
                      : '期望为空：只要求有文本输出'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1 md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:focus-within:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="rounded-[7px]"
                    onClick={() => setEditing(testCase)}
                  >
                    <span className="sr-only">编辑 {testCase.name}</span>
                    <Pencil className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="rounded-[7px] hover:text-danger"
                    onClick={() => setDeleting(testCase)}
                  >
                    <span className="sr-only">删除 {testCase.name}</span>
                    <Trash2 className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </PageSection>

      <PageSection
        title="运行"
        description={latest ? `最近：${latest.passed} / ${latest.total}` : '每次回归的通过情况'}
      >
        {runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
        ) : null}
        {runs.isPending && effectiveAgentId ? <LoadingState rows={3} /> : null}
        {runs.data && runs.data.length === 0 ? (
          <PageNote
            icon={<ClipboardCheck className="size-4" strokeWidth={1.75} aria-hidden="true" />}
            title="还没有评估运行"
            description="写好用例后点「运行评估」，这里会显示每次回归的通过情况。"
          />
        ) : null}
        {runs.data && runs.data.length > 0 ? (
          <DataTable
            rows={runs.data}
            columns={runColumns}
            rowKey={(run) => run.id}
            label="评估运行"
            storageKey="agentport.eval-runs.columns"
            renderExpanded={(run) => <EvalRunResults id={run.id} />}
          />
        ) : null}
      </PageSection>

      {creating && effectiveAgentId ? (
        <CaseDialog agentId={effectiveAgentId} onClose={() => setCreating(false)} />
      ) : null}
      {editing ? <CaseDialog testCase={editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? <DeleteCaseDialog testCase={deleting} onClose={() => setDeleting(null)} /> : null}
    </Page>
  );
}

function EvalRunResults({ id }: { id: string }) {
  const detail = useEvalRun(id);

  if (detail.isPending) return <LoadingState rows={2} />;
  if (detail.isError) {
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  }

  const { results } = detail.data;
  if (results.length === 0) {
    return (
      <p className="text-sm text-muted">
        {detail.data.evalRun.status === 'running'
          ? '正在逐个执行用例…'
          : '还没有结果记录。这条运行可能仍在排队，稍后会自动刷新。'}
      </p>
    );
  }

  return (
    <ul>
      {results.map((result) => (
        <li key={result.caseId} className="border-b border-line py-4 last:border-b-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={result.passed ? 'success' : 'danger'} className="rounded-[6px]">
              {result.passed ? '通过' : '未通过'}
            </Badge>
            <span className="text-md font-medium text-fg">{result.name}</span>
            {result.runId ? (
              <Link
                to="/runs/$runId"
                params={{ runId: result.runId }}
                className="ml-auto text-sm text-fg underline underline-offset-4"
              >
                查看运行
              </Link>
            ) : null}
          </div>
          <div className="mt-2 grid gap-x-8 gap-y-2 text-sm leading-relaxed sm:grid-cols-2">
            <div>
              <div className="text-xs text-subtle">Prompt</div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-muted">{result.prompt}</p>
            </div>
            <div>
              <div className="text-xs text-subtle">期望</div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-muted">
                {result.expectation || '（只要求有文本输出）'}
              </p>
            </div>
          </div>
          <div className="mt-2">
            <div className="text-xs text-subtle">输出</div>
            <CodeBlock
              code={result.output || '（空）'}
              maxHeight="12rem"
              className="mt-1"
              copyLabel="复制输出"
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

interface CaseForm {
  name: string;
  prompt: string;
  expectation: string;
}

function CaseDialog({
  agentId,
  testCase,
  onClose,
}: {
  agentId?: string;
  testCase?: EvalCase;
  onClose: () => void;
}) {
  const create = useCreateEvalCase();
  const update = useUpdateEvalCase();
  const [form, setForm] = useState<CaseForm>(
    testCase
      ? { name: testCase.name, prompt: testCase.prompt, expectation: testCase.expectation }
      : { name: '', prompt: '', expectation: '' },
  );
  const [error, setError] = useState('');

  const set = <K extends keyof CaseForm>(key: K, value: CaseForm[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError('');
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!form.name.trim() || !form.prompt.trim()) {
      setError('名称和 Prompt 都需要填写，补全后再保存。');
      return;
    }
    const input: EvalCaseInput = { agentId: agentId ?? testCase?.agentId ?? '', ...form };
    const done = (): void => {
      toastSuccess(testCase ? '用例已更新' : '用例已创建');
      onClose();
    };
    if (testCase) {
      update.mutate(
        {
          id: testCase.id,
          input: { name: input.name, prompt: input.prompt, expectation: input.expectation },
        },
        { onSuccess: done, onError: toastError },
      );
    } else {
      create.mutate(input, { onSuccess: done, onError: toastError });
    }
  };

  const pending = create.isPending || update.isPending;

  return (
    <Dialog
      open
      onClose={onClose}
      title={testCase ? '编辑用例' : '新建用例'}
      description="运行评估时，每个用例都会发起一次真实运行。"
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="eval-name">
            名称 <RequiredMark />
          </Label>
          <Input
            id="eval-name"
            value={form.name}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'eval-form-error' : undefined}
            onChange={(event) => set('name', event.target.value)}
            placeholder="例如：拒绝编造不存在的工具"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="eval-prompt">
            Prompt <RequiredMark />
          </Label>
          <Textarea
            id="eval-prompt"
            rows={5}
            value={form.prompt}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'eval-form-error' : undefined}
            onChange={(event) => set('prompt', event.target.value)}
            placeholder="发送给智能体的完整输入"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="eval-expectation">期望包含</Label>
          <Textarea
            id="eval-expectation"
            rows={2}
            value={form.expectation}
            onChange={(event) => set('expectation', event.target.value)}
            placeholder="输出中应出现的文本（不区分大小写）；留空则只要求有文本输出"
          />
          <FieldHint>最小判定，不做语义判断；需要更严格时写更具体的片段。</FieldHint>
          <FieldError id="eval-form-error">{error}</FieldError>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteCaseDialog({ testCase, onClose }: { testCase: EvalCase; onClose: () => void }) {
  const remove = useDeleteEvalCase();
  return (
    <ConfirmDialog
      open
      title="删除用例"
      description={`将删除「${testCase.name}」。已有的评估结果会一并删除。`}
      onClose={onClose}
      onConfirm={async () => {
        await remove.mutateAsync(testCase.id);
        toastSuccess('用例已删除');
      }}
    />
  );
}
