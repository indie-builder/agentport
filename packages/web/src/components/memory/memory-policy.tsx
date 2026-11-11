import { type MemoryPolicy, memoryPolicySchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Controller } from 'react-hook-form';
import { agentMemoryOverviewQuery, useUpdateAgentMemoryPolicy } from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import { ErrorState, LoadingState } from '../states.js';
import { Button } from '../ui/button.js';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../ui/field.js';
import { Input } from '../ui/input.js';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group.js';
import { Switch } from '../ui/switch.js';

interface PolicyCallbacks {
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}

const WRITE_MODES: Array<{
  value: MemoryPolicy['writeMode'];
  title: string;
  description: string;
}> = [
  {
    value: 'native_auto',
    title: '模型自动写入',
    description: '模型运行中可改记忆，改动不进版本账本。',
  },
  {
    value: 'proposal_only',
    title: '仅提案',
    description: '运行期不可写，只能通过记忆提案写入并记账。',
  },
];

function PolicyForm({
  agentId,
  policy,
  canWrite,
  onDirtyChange,
  onPendingChange,
}: {
  agentId: string;
  policy: MemoryPolicy;
  canWrite: boolean;
} & PolicyCallbacks) {
  const save = useUpdateAgentMemoryPolicy();
  const { register, control, handleSubmit, reset, formState } = useZodForm(memoryPolicySchema, {
    defaultValues: policy,
  });
  const { errors, isDirty: dirty } = formState;
  const pending = save.isPending;
  const disabled = pending || !canWrite;

  // 策略被外部刷新时只在没有草稿的情况下重设基线，避免覆盖未保存修改。
  const policyRef = useRef(policy);
  useEffect(() => {
    if (policyRef.current === policy) return;
    policyRef.current = policy;
    if (!dirty) reset(policy);
  }, [policy, dirty, reset]);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => onPendingChange?.(pending), [pending, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);

  const submit = handleSubmit((values) => {
    if (disabled) return;
    save.mutate(
      { agentId, policy: values },
      {
        onSuccess: (saved) => {
          reset(saved.policy);
          toastSuccess('记忆策略已保存');
        },
        onError: toastError,
      },
    );
  });

  return (
    // 校验统一走 zod：不让浏览器原生 min/max 静默拦下提交、却不显示字段错误。
    <form className="flex flex-col gap-5" noValidate onSubmit={submit}>
      <FieldGroup className="gap-5">
        <Field orientation="horizontal" className="items-start gap-3" data-disabled={disabled}>
          <FieldContent>
            <FieldLabel htmlFor="memory-policy-enabled">启用专家记忆</FieldLabel>
            <FieldDescription id="memory-policy-enabled-hint">
              仅管主会话记忆，子智能体记忆独立。关闭后运行期不加载、不写入专家记忆，手工浏览与编辑仍然可用。
            </FieldDescription>
          </FieldContent>
          <Controller
            control={control}
            name="enabled"
            render={({ field }) => (
              <Switch
                id="memory-policy-enabled"
                checked={field.value}
                disabled={disabled}
                aria-label="启用专家记忆"
                aria-describedby="memory-policy-enabled-hint"
                onCheckedChange={field.onChange}
              />
            )}
          />
        </Field>

        <Field className="gap-2" data-disabled={disabled}>
          <FieldLabel id="memory-policy-write-mode">运行期写入方式</FieldLabel>
          <Controller
            control={control}
            name="writeMode"
            render={({ field }) => (
              <RadioGroup
                aria-labelledby="memory-policy-write-mode"
                value={field.value}
                disabled={disabled}
                className="grid gap-2 sm:grid-cols-2"
                onValueChange={(next) => field.onChange(next)}
              >
                {WRITE_MODES.map((option) => (
                  <FieldLabel
                    key={option.value}
                    className="w-full cursor-pointer items-start gap-2 rounded-item border border-line px-3 py-2.5 font-normal"
                  >
                    <RadioGroupItem
                      value={option.value}
                      aria-label={option.title}
                      aria-describedby={`memory-policy-write-mode-${option.value}-hint`}
                      className="mt-0.5"
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm font-medium text-fg">{option.title}</span>
                      <span
                        id={`memory-policy-write-mode-${option.value}-hint`}
                        className="text-xs text-muted-foreground"
                      >
                        {option.description}
                      </span>
                    </span>
                  </FieldLabel>
                ))}
              </RadioGroup>
            )}
          />
        </Field>

        <Field orientation="horizontal" className="items-start gap-3" data-disabled={disabled}>
          <FieldContent>
            <FieldLabel htmlFor="memory-policy-personal">注入个人记忆</FieldLabel>
            <FieldDescription id="memory-policy-personal-hint">
              仅私有会话生效，频道与服务主体固定不注入。
            </FieldDescription>
          </FieldContent>
          <Controller
            control={control}
            name="injectPersonalMemory"
            render={({ field }) => (
              <Switch
                id="memory-policy-personal"
                checked={field.value}
                disabled={disabled}
                aria-label="注入个人记忆"
                aria-describedby="memory-policy-personal-hint"
                onCheckedChange={field.onChange}
              />
            )}
          />
        </Field>

        <Field orientation="horizontal" className="items-start gap-3" data-disabled={disabled}>
          <FieldContent>
            <FieldLabel htmlFor="memory-policy-rules">加载项目规则</FieldLabel>
            <FieldDescription id="memory-policy-rules-hint">
              关闭后 .claude/rules 不渲染。
            </FieldDescription>
          </FieldContent>
          <Controller
            control={control}
            name="injectRules"
            render={({ field }) => (
              <Switch
                id="memory-policy-rules"
                checked={field.value}
                disabled={disabled}
                aria-label="加载项目规则"
                aria-describedby="memory-policy-rules-hint"
                onCheckedChange={field.onChange}
              />
            )}
          />
        </Field>

        <Field
          orientation="horizontal"
          className="items-start gap-3"
          data-disabled={disabled}
          data-invalid={Boolean(errors.topicLimit)}
        >
          <FieldContent>
            <FieldLabel htmlFor="memory-policy-topic-limit">主题数量上限（3–48）</FieldLabel>
            <FieldDescription id="memory-policy-topic-limit-hint">
              超出时新建主题与提案采纳会被拒绝。
            </FieldDescription>
            <FieldError id="memory-policy-topic-limit-error">
              {errors.topicLimit?.message}
            </FieldError>
          </FieldContent>
          <Input
            {...register('topicLimit', { valueAsNumber: true })}
            id="memory-policy-topic-limit"
            type="number"
            min={3}
            max={48}
            step={1}
            inputMode="numeric"
            className="w-24"
            disabled={disabled}
            aria-invalid={Boolean(errors.topicLimit)}
            aria-describedby={
              errors.topicLimit
                ? 'memory-policy-topic-limit-hint memory-policy-topic-limit-error'
                : 'memory-policy-topic-limit-hint'
            }
          />
        </Field>
      </FieldGroup>

      {/* 只读时没有可提交的动作，不渲染保存按钮。 */}
      {canWrite ? (
        <div className="flex justify-end">
          <Button type="submit" disabled={disabled || !dirty} aria-busy={pending}>
            {pending ? '保存中…' : '保存策略'}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

/** 专家记忆策略：运行期挂载、写入方式、个人记忆/规则注入与主题上限。 */
export function MemoryPolicyPanel({
  agentId,
  canWrite = true,
  onDirtyChange,
  onPendingChange,
}: { agentId: string; canWrite?: boolean } & PolicyCallbacks) {
  const overview = useQuery(agentMemoryOverviewQuery(agentId));

  if (overview.isPending) return <LoadingState rows={3} />;
  if (overview.data === undefined) {
    return <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-4">
      {overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : null}
      <PolicyForm
        agentId={agentId}
        policy={overview.data.policy}
        canWrite={canWrite}
        onDirtyChange={onDirtyChange}
        onPendingChange={onPendingChange}
      />
    </div>
  );
}
