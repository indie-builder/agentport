import type {
  ConversationSummary,
  CreateMemoryReviewInput,
  MemoryReview,
  MemoryReviewTarget,
} from '@agentport/shared';
import { INDEX_FILE_NAME } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button as ButtonPrimitive } from '@ui-sdk/react/button';
import { MessageSquare, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { type AgentSummary, errorMessage } from '../../../lib/api.js';
import { useDialogClose } from '../../../lib/dialog-guard.js';
import { useFormBlocker } from '../../../lib/form.js';
import {
  agentMemoryQuery,
  agentRulesQuery,
  useAgentsTruncated,
  useCreateMemoryReview,
  usePersonalConversations,
} from '../../../lib/queries.js';
import { toastSuccess } from '../../../lib/toast.js';
import { useZodForm } from '../../../lib/use-zod-form.js';
import { AgentPicker } from '../../agent/agent-picker.js';
import { ConfirmDialog } from '../../confirm-dialog.js';
import { DialogShell } from '../../dialog-shell.js';
import { FilterSelect } from '../../filter-select.js';
import { EmptyState, ErrorState, LoadingState } from '../../states.js';
import { Button, buttonVariants } from '../../ui/button.js';
import { Checkbox } from '../../ui/checkbox.js';
import { Dialog } from '../../ui/dialog.js';
import { Field, FieldError, FieldLabel, FieldTitle } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/select.js';
import { Textarea } from '../../ui/textarea.js';
import {
  allTargetKindOptions,
  formatTimeout,
  INSTRUCTION_MAX_CHARS,
  MAX_SOURCES,
  memoryFileNameOf,
  memoryFormatErrorOf,
  NEW_MEMORY_CHOICE,
  slugFormatErrorOf,
  type TargetKind,
  targetDisplay,
} from './review-shared.js';

interface SelectedSource {
  conversationId: string;
  title: string;
  agentId: string;
}

const selectedSourceSchema = z.object({
  conversationId: z.string(),
  title: z.string(),
  agentId: z.string(),
});

const createMemoryReviewFormSchema = z
  .object({
    modelAgentId: z.string().min(1, '选择执行专家。'),
    targetKind: z.enum(['personal', 'agent_memory', 'agent_rule']),
    targetAgentId: z.string(),
    ruleChoice: z.string(),
    newRuleSlug: z.string(),
    memoryChoice: z.string(),
    newMemoryName: z.string(),
    sourceExpertId: z.string(),
    sources: z
      .array(selectedSourceSchema)
      .min(1, '至少选择一段来源会话。')
      .max(MAX_SOURCES, `最多选择 ${MAX_SOURCES} 段来源会话。`),
    instruction: z
      .string()
      .max(INSTRUCTION_MAX_CHARS, `最多 ${INSTRUCTION_MAX_CHARS} 个字符，请精简后再提交。`),
  })
  .superRefine((values, ctx) => {
    if (values.targetKind !== 'personal' && !values.targetAgentId) {
      ctx.addIssue({ code: 'custom', path: ['targetAgentId'], message: '选择目标专家。' });
    }
    if (values.targetKind === 'agent_rule') {
      const slug = values.ruleChoice === '__new__' ? values.newRuleSlug.trim() : values.ruleChoice;
      if (!slug) {
        ctx.addIssue({
          code: 'custom',
          path: ['newRuleSlug'],
          message: '选择已有规则或填写新规则 slug。',
        });
      } else {
        const formatError = slugFormatErrorOf(slug);
        if (formatError) {
          ctx.addIssue({ code: 'custom', path: ['newRuleSlug'], message: formatError });
        }
      }
    }
    if (values.targetKind === 'agent_memory') {
      if (values.memoryChoice === NEW_MEMORY_CHOICE && values.newMemoryName.trim() === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['newMemoryName'],
          message: '填写新主题文件名。',
        });
      } else {
        const formatError = memoryFormatErrorOf(
          values.memoryChoice === NEW_MEMORY_CHOICE ? values.newMemoryName : values.memoryChoice,
        );
        if (formatError) {
          ctx.addIssue({ code: 'custom', path: ['newMemoryName'], message: formatError });
        }
      }
    }
  });

function createInitialState(
  agents: AgentSummary[],
  defaultAgentId: string | null,
  seed: MemoryReview | null,
): {
  modelAgentId: string;
  targetKind: TargetKind;
  targetAgentId: string;
  ruleChoice: string;
  newRuleSlug: string;
  memoryChoice: string;
  newMemoryName: string;
  sourceExpertId: string;
  sources: SelectedSource[];
  instruction: string;
} {
  const enabled = agents.filter((agent) => agent.enabled);
  const initialAgent = enabled.find((agent) => agent.id === defaultAgentId) ?? enabled[0];
  if (seed === null) {
    return {
      modelAgentId: initialAgent?.id ?? '',
      targetKind: 'personal',
      targetAgentId: initialAgent?.id ?? '',
      ruleChoice: '__new__',
      newRuleSlug: '',
      memoryChoice: INDEX_FILE_NAME,
      newMemoryName: '',
      sourceExpertId: initialAgent?.id ?? '',
      sources: [],
      instruction: '',
    };
  }
  const target = seed.target;
  const targetAgentId = target.kind === 'personal' ? (initialAgent?.id ?? '') : target.agentId;
  const sourceExpertId = target.kind === 'personal' ? (initialAgent?.id ?? '') : target.agentId;
  return {
    modelAgentId: seed.modelAgentId,
    targetKind: target.kind,
    targetAgentId,
    ruleChoice: target.kind === 'agent_rule' ? target.slug : '__new__',
    newRuleSlug: '',
    memoryChoice: target.kind === 'agent_memory' ? target.name : INDEX_FILE_NAME,
    newMemoryName: '',
    sourceExpertId,
    sources: seed.sources.map((source) => ({
      conversationId: source.conversationId,
      title: source.title,
      agentId: sourceExpertId,
    })),
    instruction: '',
  };
}

type ComposerPhase = 'editing' | 'discard' | 'closing';

export function CreateMemoryReviewDialog({
  agents,
  defaultAgentId,
  seed,
  canUseAgents,
  canUseAgentMemoryTarget,
  canUseAgentRuleTarget,
  canReadAgentMemory,
  canReadAgentRules,
  onClose: onClosed,
  finalFocus,
}: {
  agents: AgentSummary[];
  defaultAgentId: string | null;
  seed: MemoryReview | null;
  canUseAgents: boolean;
  canUseAgentMemoryTarget: boolean;
  canUseAgentRuleTarget: boolean;
  canReadAgentMemory: boolean;
  canReadAgentRules: boolean;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const [initial] = useState(() => createInitialState(agents, defaultAgentId, seed));
  const rhf = useZodForm(createMemoryReviewFormSchema, { defaultValues: initial });
  const {
    modelAgentId,
    targetKind,
    targetAgentId,
    ruleChoice,
    newRuleSlug,
    memoryChoice,
    newMemoryName,
    sourceExpertId,
    sources,
    instruction,
  } = rhf.watch();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [phase, setPhase] = useState<ComposerPhase>('editing');
  const idempotency = useRef<{ fingerprint: string; key: string } | null>(null);
  const sourcesBoxRef = useRef<HTMLDivElement>(null);
  const create = useCreateMemoryReview();
  const errors = rhf.formState.errors;
  const modelError = errors.modelAgentId?.message;
  const targetError = errors.targetAgentId?.message;
  const sourcesError = errors.sources?.message;
  const formError = errors.root?.message;

  useEffect(() => {
    if (sourcesError) sourcesBoxRef.current?.focus();
  }, [sourcesError]);

  const modelAgent = agents.find((agent) => agent.id === modelAgentId);
  const sourceAgent = agents.find((agent) => agent.id === sourceExpertId);
  const conversationAgentId = sourceExpertId;
  const conversations = usePersonalConversations(conversationAgentId || null);
  const rules = useQuery({
    ...agentRulesQuery(targetAgentId),
    enabled: targetKind === 'agent_rule' && targetAgentId !== '' && canReadAgentRules,
  });
  const memory = useQuery({
    ...agentMemoryQuery(targetAgentId),
    enabled: targetKind === 'agent_memory' && targetAgentId !== '' && canReadAgentMemory,
  });
  const agentsTruncated = useAgentsTruncated().data ?? false;
  const targetKindOptions = allTargetKindOptions.filter(
    (option) =>
      option.value === 'personal' ||
      (option.value === 'agent_memory' ? canUseAgentMemoryTarget : canUseAgentRuleTarget),
  );
  const enabled = agents.filter((agent) => agent.enabled);
  const agentOptions = enabled.map((agent) => ({ value: agent.id, label: agent.name, agent }));
  const ruleSlug = ruleChoice === '__new__' ? newRuleSlug.trim() : ruleChoice;
  const baseRuleOptions = [
    ...(rules.data ?? []).map((rule) => ({ value: rule.slug, label: rule.slug })),
    { value: '__new__', label: '新规则…' },
  ];
  const ruleOptions = baseRuleOptions.some((option) => option.value === ruleChoice)
    ? baseRuleOptions
    : [{ value: ruleChoice, label: ruleChoice }, ...baseRuleOptions];
  const memoryFileNames = [
    INDEX_FILE_NAME,
    ...(memory.data?.files ?? [])
      .map((file) => file.name)
      .filter((fileName) => fileName !== INDEX_FILE_NAME),
  ];
  const baseMemoryOptions = [
    ...memoryFileNames.map((fileName) => ({ value: fileName, label: fileName })),
    { value: NEW_MEMORY_CHOICE, label: '新主题…' },
  ];
  const memoryOptions = baseMemoryOptions.some((option) => option.value === memoryChoice)
    ? baseMemoryOptions
    : [{ value: memoryChoice, label: memoryChoice }, ...baseMemoryOptions];
  const selectedMemoryName =
    memoryChoice === NEW_MEMORY_CHOICE ? memoryFileNameOf(newMemoryName) : memoryChoice;
  const summaryTarget: MemoryReviewTarget =
    targetKind === 'personal'
      ? { kind: 'personal' }
      : targetKind === 'agent_memory'
        ? { kind: 'agent_memory', agentId: targetAgentId, name: selectedMemoryName }
        : { kind: 'agent_rule', agentId: targetAgentId, slug: ruleSlug };
  const summaryTargetDisplay = targetDisplay(summaryTarget, agents);
  const dirty = phase !== 'closing' && rhf.formState.isDirty;
  const instructionLength = instruction.length;
  const slugFormatError =
    targetKind === 'agent_rule' && ruleChoice === '__new__'
      ? slugFormatErrorOf(newRuleSlug.trim())
      : null;
  const slugError = slugFormatError ?? errors.newRuleSlug?.message;
  const memoryFormatError =
    targetKind === 'agent_memory' && memoryChoice === NEW_MEMORY_CHOICE
      ? memoryFormatErrorOf(newMemoryName)
      : null;
  const memoryError = memoryFormatError ?? errors.newMemoryName?.message;
  const instructionError =
    instructionLength > INSTRUCTION_MAX_CHARS
      ? `最多 ${INSTRUCTION_MAX_CHARS} 个字符，请精简后再提交。`
      : errors.instruction?.message;
  const blocker = useFormBlocker(dirty, create.isPending);
  const latestBlocker = useRef(blocker);
  latestBlocker.current = blocker;
  const leaving = blocker.status === 'blocked';

  const requestClose = (): void => {
    if (create.isPending) return;
    if (dirty) {
      setPhase('discard');
      return;
    }
    setPhase('closing');
  };

  useEffect(() => {
    if (phase === 'closing') onClose();
  }, [phase, onClose]);

  const changeTargetKind = (next: TargetKind): void => {
    rhf.setValue('targetKind', next, { shouldDirty: true });
    rhf.setValue('ruleChoice', '__new__', { shouldDirty: true });
    rhf.setValue('newRuleSlug', '', { shouldDirty: true });
    rhf.setValue('memoryChoice', INDEX_FILE_NAME, { shouldDirty: true });
    rhf.setValue('newMemoryName', '', { shouldDirty: true });
    rhf.clearErrors();
  };

  const changeSourceExpert = (next: string): void => {
    if (next === sourceExpertId) return;
    rhf.setValue('sourceExpertId', next, { shouldDirty: true });
    rhf.setValue('sources', [], { shouldDirty: true });
    rhf.clearErrors('sources');
    rhf.clearErrors('root');
  };

  const toggleSource = (conversation: ConversationSummary): void => {
    rhf.clearErrors('sources');
    rhf.clearErrors('root');
    const current = rhf.getValues('sources');
    if (current.some((source) => source.conversationId === conversation.id)) {
      rhf.setValue(
        'sources',
        current.filter((source) => source.conversationId !== conversation.id),
        { shouldDirty: true },
      );
      return;
    }
    if (current.length >= MAX_SOURCES) {
      rhf.setError('sources', { message: `最多选择 ${MAX_SOURCES} 段来源会话。` });
      return;
    }
    rhf.setValue(
      'sources',
      [
        ...current,
        {
          conversationId: conversation.id,
          title: conversation.title,
          agentId: conversation.agentId,
        },
      ],
      { shouldDirty: true },
    );
  };

  const goNext = async (): Promise<void> => {
    if (step === 1) {
      const valid = await rhf.trigger('sources');
      if (!valid) {
        sourcesBoxRef.current?.focus();
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      const valid = await rhf.trigger([
        'modelAgentId',
        'targetAgentId',
        'newRuleSlug',
        'newMemoryName',
        'instruction',
      ]);
      if (!valid) return;
      setStep(3);
    }
  };

  const goBack = (): void => {
    if (step === 3) setStep(2);
    else if (step === 2) setStep(1);
  };

  const submit = (): void => {
    if (!canUseAgents) return;
    void rhf.handleSubmit(
      (data) => {
        const submittedSlug =
          data.ruleChoice === '__new__' ? data.newRuleSlug.trim() : data.ruleChoice;
        const submittedMemoryName =
          data.memoryChoice === NEW_MEMORY_CHOICE
            ? memoryFileNameOf(data.newMemoryName)
            : data.memoryChoice;
        const target: MemoryReviewTarget =
          data.targetKind === 'personal'
            ? { kind: 'personal' }
            : data.targetKind === 'agent_memory'
              ? { kind: 'agent_memory', agentId: data.targetAgentId, name: submittedMemoryName }
              : { kind: 'agent_rule', agentId: data.targetAgentId, slug: submittedSlug };
        const input: CreateMemoryReviewInput = {
          modelAgentId: data.modelAgentId,
          target,
          sources: data.sources.map((source) => ({ conversationId: source.conversationId })),
          instruction: data.instruction,
        };
        const fingerprint = JSON.stringify(input);
        let attempt = idempotency.current;
        if (attempt?.fingerprint !== fingerprint) {
          attempt = { fingerprint, key: crypto.randomUUID() };
          idempotency.current = attempt;
        }
        create.mutate(
          { input, idempotencyKey: attempt.key },
          {
            onSuccess: () => {
              toastSuccess('已发起记忆提案');
              if (latestBlocker.current.status === 'blocked') latestBlocker.current.reset?.();
              setPhase('closing');
            },
            onError: (error) => rhf.setError('root', { message: errorMessage(error) }),
          },
        );
      },
      (errs) => {
        setStep(errs.sources ? 1 : 2);
      },
    )();
  };

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={(next) => (!next ? requestClose() : undefined)}
    >
      <DialogShell title="新建记忆提案" finalFocus={finalFocus} closeDisabled={create.isPending}>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (step < 3) {
              void goNext();
              return;
            }
            submit();
          }}
        >
          {step === 2 ? (
            <>
              <div>
                <h3 className="text-base font-medium text-fg">写入目标与执行方式</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  默认写入个人记忆；专家目标会写入该专家的共享文件。
                </p>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field
                  className="gap-1.5"
                  data-disabled={create.isPending}
                  data-invalid={modelError ? true : undefined}
                >
                  <FieldLabel htmlFor="memory-review-model">执行专家</FieldLabel>
                  <AgentPicker
                    triggerVariant="field"
                    agent={enabled.find((agent) => agent.id === modelAgentId) ?? null}
                    agentId={modelAgentId}
                    agentOptions={agentOptions}
                    truncated={agentsTruncated}
                    onSwitchAgent={(id) => {
                      rhf.setValue('modelAgentId', id, { shouldDirty: true });
                      rhf.clearErrors('modelAgentId');
                      rhf.clearErrors('root');
                    }}
                    placeholder="选择专家"
                    triggerId="memory-review-model"
                    triggerAriaLabel="执行专家"
                    triggerClassName="w-full"
                    disabled={create.isPending || !canUseAgents}
                    ariaInvalid={modelError ? true : undefined}
                    ariaDescribedby={modelError ? 'memory-review-model-error' : undefined}
                  />
                  {modelError ? (
                    <FieldError id="memory-review-model-error">{modelError}</FieldError>
                  ) : null}
                </Field>

                <Field className="gap-1.5" data-disabled={create.isPending}>
                  <FieldLabel htmlFor="memory-review-target-kind">目标</FieldLabel>
                  <Select
                    value={targetKind}
                    items={targetKindOptions}
                    disabled={create.isPending}
                    onValueChange={(next) => {
                      if (next !== null) changeTargetKind(next as TargetKind);
                    }}
                  >
                    <SelectTrigger
                      id="memory-review-target-kind"
                      className="w-full"
                      aria-label="目标"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {targetKindOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              {targetKind !== 'personal' ? (
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field
                    className="gap-1.5"
                    data-disabled={create.isPending}
                    data-invalid={targetError ? true : undefined}
                  >
                    <FieldLabel htmlFor="memory-review-target-agent">目标专家</FieldLabel>
                    <AgentPicker
                      triggerVariant="field"
                      agent={enabled.find((agent) => agent.id === targetAgentId) ?? null}
                      agentId={targetAgentId}
                      agentOptions={agentOptions}
                      truncated={agentsTruncated}
                      onSwitchAgent={(id) => {
                        rhf.setValue('targetAgentId', id, { shouldDirty: true });
                        rhf.setValue('ruleChoice', '__new__', { shouldDirty: true });
                        rhf.setValue('newRuleSlug', '', { shouldDirty: true });
                        rhf.setValue('memoryChoice', INDEX_FILE_NAME, { shouldDirty: true });
                        rhf.setValue('newMemoryName', '', { shouldDirty: true });
                        rhf.clearErrors(['targetAgentId', 'newRuleSlug', 'newMemoryName']);
                        rhf.clearErrors('root');
                      }}
                      placeholder="选择专家"
                      triggerId="memory-review-target-agent"
                      triggerAriaLabel="目标专家"
                      triggerClassName="w-full"
                      disabled={create.isPending}
                      ariaInvalid={targetError ? true : undefined}
                      ariaDescribedby={targetError ? 'memory-review-target-error' : undefined}
                    />
                    {targetError ? (
                      <FieldError id="memory-review-target-error">{targetError}</FieldError>
                    ) : null}
                  </Field>

                  {targetKind === 'agent_rule' ? (
                    <div className="flex flex-col gap-2">
                      <Field className="gap-1.5" data-disabled={create.isPending}>
                        <FieldLabel htmlFor="memory-review-rule">规则</FieldLabel>
                        <Select
                          value={ruleChoice}
                          items={ruleOptions}
                          disabled={create.isPending}
                          onValueChange={(next) => {
                            if (next === null) return;
                            rhf.setValue('ruleChoice', next, { shouldDirty: true });
                            rhf.clearErrors('newRuleSlug');
                            rhf.clearErrors('root');
                          }}
                        >
                          <SelectTrigger
                            id="memory-review-rule"
                            className="w-full"
                            aria-label="规则"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {ruleOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      {ruleChoice === '__new__' ? (
                        <Field
                          className="gap-1.5"
                          data-disabled={create.isPending}
                          data-invalid={slugError ? true : undefined}
                        >
                          <Input
                            id="memory-review-rule-slug"
                            value={newRuleSlug}
                            aria-label="新规则 slug"
                            aria-invalid={slugError ? true : undefined}
                            placeholder="新规则 slug，如 memory-review"
                            className="font-mono"
                            disabled={create.isPending}
                            onChange={(event) => {
                              rhf.setValue('newRuleSlug', event.target.value, {
                                shouldDirty: true,
                              });
                              rhf.clearErrors('newRuleSlug');
                              rhf.clearErrors('root');
                            }}
                          />
                          {slugError ? (
                            <FieldError id="memory-review-rule-error">{slugError}</FieldError>
                          ) : null}
                        </Field>
                      ) : null}
                    </div>
                  ) : targetKind === 'agent_memory' ? (
                    <div className="flex flex-col gap-2">
                      <Field className="gap-1.5" data-disabled={create.isPending}>
                        <FieldLabel htmlFor="memory-review-memory-file">记忆文件</FieldLabel>
                        <Select
                          value={memoryChoice}
                          items={memoryOptions}
                          disabled={create.isPending}
                          onValueChange={(next) => {
                            if (next === null) return;
                            rhf.setValue('memoryChoice', next, { shouldDirty: true });
                            rhf.clearErrors('newMemoryName');
                            rhf.clearErrors('root');
                          }}
                        >
                          <SelectTrigger
                            id="memory-review-memory-file"
                            className="w-full"
                            aria-label="记忆文件"
                          >
                            <SelectValue placeholder="选择记忆文件" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {memoryOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        {memory.isError ? (
                          <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />
                        ) : null}
                      </Field>
                      {memoryChoice === NEW_MEMORY_CHOICE ? (
                        <Field
                          className="gap-1.5"
                          data-disabled={create.isPending}
                          data-invalid={memoryError ? true : undefined}
                        >
                          <Input
                            id="memory-review-new-file"
                            value={newMemoryName}
                            aria-label="新主题文件名"
                            aria-invalid={memoryError ? true : undefined}
                            placeholder="新主题文件名，如 deployment.md"
                            className="font-mono"
                            disabled={create.isPending}
                            onChange={(event) => {
                              rhf.setValue('newMemoryName', event.target.value, {
                                shouldDirty: true,
                              });
                              rhf.clearErrors('newMemoryName');
                              rhf.clearErrors('root');
                            }}
                          />
                          {memoryError ? (
                            <FieldError id="memory-review-memory-file-error">
                              {memoryError}
                            </FieldError>
                          ) : null}
                        </Field>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div>
                <h3 className="text-base font-medium text-fg">来源</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  先选来源专家，再从该专家的本人会话中选择最多 {MAX_SOURCES} 段。
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <FieldTitle id="memory-review-sources-label">来源会话</FieldTitle>
                  <span className="text-xs text-muted-foreground">
                    已选 {sources.length} / {MAX_SOURCES}
                  </span>
                </div>

                <Field data-disabled={create.isPending}>
                  <FilterSelect
                    value={sourceExpertId}
                    onValueChange={changeSourceExpert}
                    options={agentOptions}
                    label="来源专家"
                    className="w-full sm:w-56"
                  />
                </Field>

                {sources.length > 0 ? (
                  <ul aria-label="已选来源会话" className="flex flex-wrap gap-2">
                    {sources.map((source) => {
                      const agentName =
                        agents.find((agent) => agent.id === source.agentId)?.name ?? source.agentId;
                      return (
                        <li
                          key={source.conversationId}
                          className="inline-flex max-w-full items-center gap-1 rounded-tag bg-sunken px-2 py-1 text-xs text-fg"
                        >
                          <span className="truncate" title={`${agentName} · ${source.title}`}>
                            {source.title || source.conversationId}
                            <span className="ml-1 text-muted-foreground">{agentName}</span>
                          </span>
                          <ButtonPrimitive
                            aria-label={`移除来源会话 ${source.title || source.conversationId}`}
                            className="inline-flex size-6 shrink-0 items-center justify-center rounded-icon text-muted-foreground hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            disabled={create.isPending}
                            onClick={() =>
                              rhf.setValue(
                                'sources',
                                sources.filter(
                                  (item) => item.conversationId !== source.conversationId,
                                ),
                                { shouldDirty: true },
                              )
                            }
                          >
                            <X className="size-3" aria-hidden="true" />
                          </ButtonPrimitive>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}

                <Field
                  className="gap-1.5"
                  data-disabled={create.isPending}
                  data-invalid={sourcesError ? true : undefined}
                  aria-labelledby="memory-review-sources-label"
                >
                  <div
                    ref={sourcesBoxRef}
                    className="max-h-52 overflow-y-auto overscroll-contain rounded-lg border border-line"
                    aria-invalid={sourcesError ? true : undefined}
                    aria-describedby={sourcesError ? 'memory-review-sources-error' : undefined}
                    tabIndex={sourcesError ? -1 : undefined}
                  >
                    {conversations.isPending ? <LoadingState rows={3} /> : null}
                    {conversations.isError ? (
                      <div className="p-3">
                        <ErrorState
                          error={conversations.error}
                          onRetry={() => void conversations.refetch()}
                        />
                      </div>
                    ) : null}
                    {conversations.data ? (
                      conversations.data.length === 0 ? (
                        <EmptyState
                          variant="idle"
                          scale="inline"
                          icon={<MessageSquare className="size-4" aria-hidden="true" />}
                          title="还没有与这位专家的对话记录"
                          description="先发起对话后再来整理记忆提案。"
                          action={
                            <Link
                              to="/chat"
                              search={sourceExpertId ? { agent: sourceExpertId } : {}}
                              className={buttonVariants({ variant: 'link', size: 'sm' })}
                            >
                              去对话
                            </Link>
                          }
                        />
                      ) : (
                        <ul className="divide-y">
                          {conversations.data.map((conversation) => {
                            const checked = sources.some(
                              (source) => source.conversationId === conversation.id,
                            );
                            return (
                              <li key={conversation.id}>
                                <div className="flex items-center gap-2 px-3 py-2 text-sm transition-colors duration-150 ease-out-soft hover:bg-hover">
                                  <Checkbox
                                    id={`memory-review-source-${conversation.id}`}
                                    checked={checked}
                                    disabled={
                                      create.isPending ||
                                      (!checked && sources.length >= MAX_SOURCES)
                                    }
                                    onCheckedChange={() => toggleSource(conversation)}
                                  />
                                  <label
                                    htmlFor={`memory-review-source-${conversation.id}`}
                                    className="min-w-0 flex-1 cursor-pointer truncate text-fg"
                                  >
                                    {conversation.title || conversation.id}
                                  </label>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )
                    ) : null}
                  </div>
                  {sourcesError ? (
                    <FieldError id="memory-review-sources-error">{sourcesError}</FieldError>
                  ) : null}
                </Field>
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <Field
                className="gap-1.5"
                data-disabled={create.isPending}
                data-invalid={instructionError ? true : undefined}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <FieldLabel htmlFor="memory-review-instruction">审核指令（可选）</FieldLabel>
                  <span
                    id="memory-review-instruction-count"
                    className={
                      instructionLength > INSTRUCTION_MAX_CHARS
                        ? 'text-xs text-danger'
                        : 'text-xs text-muted-foreground'
                    }
                  >
                    {instructionLength} / {INSTRUCTION_MAX_CHARS}
                  </span>
                </div>
                <Textarea
                  id="memory-review-instruction"
                  value={instruction}
                  disabled={create.isPending}
                  placeholder="例如：只整理长期有效的偏好"
                  aria-invalid={instructionError ? true : undefined}
                  aria-describedby="memory-review-instruction-count"
                  onChange={(event) => {
                    rhf.setValue('instruction', event.target.value, { shouldDirty: true });
                    rhf.clearErrors('instruction');
                  }}
                />
                {instructionError ? (
                  <FieldError id="memory-review-instruction-error">{instructionError}</FieldError>
                ) : null}
              </Field>

              {modelAgent ? (
                <p className="text-sm text-muted-foreground">
                  将使用「{modelAgent.name}」{modelAgent.model ? `（${modelAgent.model}）` : ''}
                  {modelAgent.maxBudgetUsd === undefined
                    ? ''
                    : `，单次预算上限 $${modelAgent.maxBudgetUsd}`}
                  {modelAgent.timeoutMs === undefined
                    ? ''
                    : ` / 超时 ${formatTimeout(modelAgent.timeoutMs)}`}
                  。
                </p>
              ) : null}
            </>
          ) : null}

          {step === 3 ? (
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="text-base font-medium text-fg">确认生成</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  核对来源、写入目标与执行专家后再生成；生成结果仍需审核才会写入。
                </p>
              </div>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
                <dt className="text-muted-foreground">来源专家</dt>
                <dd className="min-w-0 text-fg">
                  {sourceAgent?.name ?? sourceExpertId}
                  <ul className="mt-1 flex flex-col gap-1 text-muted-foreground">
                    {sources.map((source) => (
                      <li key={source.conversationId} className="break-words">
                        {source.title || source.conversationId}
                      </li>
                    ))}
                  </ul>
                </dd>

                <dt className="text-muted-foreground">写入目标</dt>
                <dd className="min-w-0 text-fg">
                  {summaryTargetDisplay.label}
                  {summaryTargetDisplay.detail ? (
                    <span className="ml-1.5 text-muted-foreground">
                      {summaryTargetDisplay.detail}
                    </span>
                  ) : null}
                  {summaryTargetDisplay.shared ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      这是专家的共享目标，不是个人记忆。
                    </p>
                  ) : null}
                </dd>

                <dt className="text-muted-foreground">执行专家</dt>
                <dd className="min-w-0 text-fg">
                  {modelAgent?.name ?? modelAgentId}
                  {modelAgent?.model ? (
                    <span className="ml-1.5 text-muted-foreground">{modelAgent.model}</span>
                  ) : null}
                  {modelAgent?.maxBudgetUsd === undefined ? null : (
                    <span className="ml-1.5 text-muted-foreground">
                      单次预算上限 ${modelAgent.maxBudgetUsd}
                    </span>
                  )}
                  {modelAgent?.timeoutMs === undefined ? null : (
                    <span className="ml-1.5 text-muted-foreground">
                      超时 {formatTimeout(modelAgent.timeoutMs)}
                    </span>
                  )}
                </dd>

                <dt className="text-muted-foreground">可选要求</dt>
                <dd className="min-w-0 whitespace-pre-wrap text-fg">
                  {instruction.trim() === '' ? '无' : instruction}
                </dd>
              </dl>
            </div>
          ) : null}

          {formError ? <FieldError>{formError}</FieldError> : null}

          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground">第 {step} / 3 步</span>
            <Button
              type="button"
              variant="outline"
              disabled={create.isPending}
              onClick={requestClose}
            >
              取消
            </Button>
            {step === 1 ? (
              <Button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  void goNext();
                }}
              >
                下一步
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={create.isPending}
                  onClick={goBack}
                >
                  上一步
                </Button>
                {step === 2 ? (
                  <Button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      void goNext();
                    }}
                  >
                    下一步
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    disabled={create.isPending || !canUseAgents}
                    aria-busy={create.isPending}
                  >
                    {create.isPending ? '提交中…' : '生成提案'}
                  </Button>
                )}
              </>
            )}
          </div>
        </form>
      </DialogShell>

      <ConfirmDialog
        open={phase === 'discard' || leaving}
        onClose={() => {
          setPhase((previous) => (previous === 'closing' ? previous : 'editing'));
          blocker.reset?.();
        }}
        title="放弃新建的提案？"
        description={leaving ? '离开后，已填写的内容不会保留。' : '关闭后，已填写的内容不会保留。'}
        confirmLabel={leaving ? '放弃并离开' : '放弃并关闭'}
        confirmDisabled={create.isPending}
        onConfirm={async () => {
          if (leaving) {
            setPhase('editing');
            blocker.proceed();
            return;
          }
          setPhase('closing');
        }}
      />
    </Dialog>
  );
}
