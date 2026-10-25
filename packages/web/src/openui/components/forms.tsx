import { Field as BaseField } from '@base-ui/react/field';
import {
  ACTION_STEPS,
  FormNameContext,
  FormValidationContext,
  parseStructuredRules,
  useCreateFormValidation,
  useFormName,
  useFormValidation,
  useIsStreaming,
  useSetDefaultValue,
  useStateField,
  useTriggerAction,
} from '@openuidev/react-lang';
import { CalendarDays, CircleAlert } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
} from 'react';
import { RequiredMark } from '../../components/required-mark.js';
import { Button as UiButton } from '../../components/ui/button.js';
import { Calendar } from '../../components/ui/calendar.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import {
  Field,
  FieldError as FieldControlError,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.js';
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Slider } from '../../components/ui/slider.js';
import { Switch } from '../../components/ui/switch.js';
import { Textarea } from '../../components/ui/textarea.js';
import { cn } from '../../lib/cn.js';
import { childProps, isActionPlan, type RenderProps } from './shared.js';

type Rules = Record<string, string | number | boolean | undefined>;

/**
 * FormControl 向控件下发的接线：DOM id 用 instance 级 useId，
 * 同一条消息的两个 UI 段出现同名字段也不会撞 id。
 */
interface FieldWiring {
  controlId: string;
  labelId: string;
  describedBy: string | undefined;
}

const FieldWiringContext = createContext<FieldWiring | null>(null);

/** 标签能真正指向的控件（可点击标签聚焦）；分组控件改用 aria-labelledby。 */
const LABELABLE_INPUTS = new Set(['Input', 'TextArea', 'Select', 'DatePicker']);

function inputTypeName(input: unknown): string | undefined {
  return (input as { typeName?: string } | null | undefined)?.typeName;
}

/** 标签 / 提示 / 错误在控件上的投影；脱离 FormControl 时不产生多余属性。 */
function useFieldWiring() {
  return useContext(FieldWiringContext);
}

/** 把 schema 的 rules 对象登记进官方校验上下文；字段卸载时注销。 */
function useFieldRules(name: string, rules: Rules | undefined, getValue: () => unknown) {
  const validation = useFormValidation();
  const streaming = useIsStreaming();
  const parsed = useMemo(() => parseStructuredRules(rules), [rules]);
  const hasRules = parsed.length > 0;
  // 校验时机由提交按钮决定，读的必须是「当前值」，不能是登记那一刻的快照。
  const getter = useRef(getValue);
  getter.current = getValue;

  useEffect(() => {
    if (streaming || !validation || !hasRules) return undefined;
    validation.registerField(name, parsed, () => getter.current());
    return () => validation.unregisterField(name);
  }, [name, parsed, validation, hasRules, streaming]);

  return { validation, rules: parsed, hasRules, streaming };
}

function useField(
  name: string,
  value: unknown,
  rules: Rules | undefined,
  defaults?: { componentType?: string; defaultValue?: unknown },
) {
  const field = useStateField(name, value);
  const formName = useFormName();
  // 官方默认值语义：流结束后把 defaultValue 写进表单状态，用户已填过的值不覆盖。
  useSetDefaultValue({
    ...(formName ? { formName } : {}),
    ...(defaults?.componentType ? { componentType: defaults.componentType } : {}),
    name,
    existingValue: field.value,
    defaultValue: defaults?.defaultValue,
  });
  const {
    validation,
    rules: parsed,
    hasRules,
    streaming,
  } = useFieldRules(name, rules, () => field.value);
  const error = validation?.errors[name];
  return {
    name,
    value: field.value,
    setValue: (next: unknown) => {
      field.setValue(next);
      if (hasRules) validation?.clearFieldError(name);
    },
    validate: (next: unknown = field.value) => {
      if (hasRules) validation?.validateField(name, next, parsed);
    },
    error,
    streaming,
  };
}

/** 分组控件（多选、单选、卡片）用 fieldset 承接 FormControl 的标签、提示与 invalid。 */
function RangeGroup({
  labelledBy,
  describedBy,
  invalid,
  className,
  children,
}: {
  labelledBy: string | undefined;
  describedBy: string | undefined;
  invalid: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <fieldset
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      className={cn('m-0 min-w-0 border-0 p-0', className)}
    >
      {children}
    </fieldset>
  );
}

// ─── Text inputs ─────────────────────────────────────────────────────────────

export function InputRenderer({
  props,
}: RenderProps<{
  name: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'password' | 'number' | 'url';
  rules?: Rules;
  value?: string;
}>) {
  const field = useField(props.name, props.value, props.rules);
  const wiring = useFieldWiring();
  return (
    <Input
      id={wiring?.controlId ?? field.name}
      name={field.name}
      placeholder={props.placeholder ?? ''}
      type={props.type ?? 'text'}
      value={field.value == null ? '' : String(field.value)}
      disabled={field.streaming}
      aria-invalid={field.error ? true : undefined}
      aria-describedby={wiring?.describedBy}
      onChange={(event) => field.setValue(event.target.value)}
      onBlur={(event) => field.validate(event.target.value)}
    />
  );
}

export function TextAreaRenderer({
  props,
}: RenderProps<{
  name: string;
  placeholder?: string;
  rows?: number;
  rules?: Rules;
  value?: string;
}>) {
  const field = useField(props.name, props.value, props.rules);
  const wiring = useFieldWiring();
  return (
    <Textarea
      id={wiring?.controlId ?? field.name}
      name={field.name}
      placeholder={props.placeholder ?? ''}
      rows={props.rows ?? 3}
      value={field.value == null ? '' : String(field.value)}
      disabled={field.streaming}
      aria-invalid={field.error ? true : undefined}
      aria-describedby={wiring?.describedBy}
      onChange={(event) => field.setValue(event.target.value)}
      onBlur={(event) => field.validate(event.target.value)}
    />
  );
}

export function LabelRenderer({ props }: RenderProps<{ text: string }>) {
  return <span className="text-sm font-medium text-fg">{props.text}</span>;
}

// ─── Select ──────────────────────────────────────────────────────────────────

export function SelectRenderer({
  props,
}: RenderProps<{
  name: string;
  items: unknown[];
  placeholder?: string;
  rules?: Rules;
  value?: string;
  size?: 'small' | 'medium' | 'large';
}>) {
  const field = useField(props.name, props.value, props.rules);
  const wiring = useFieldWiring();
  const items = (props.items ?? [])
    .map((item) => childProps<{ value: string; label: string }>(item))
    .filter((item): item is { value: string; label: string } => !!item?.value);
  const value = typeof field.value === 'string' ? field.value : '';
  return (
    <Select
      value={value === '' ? null : value}
      items={items.map((item) => ({ value: item.value, label: item.label }))}
      disabled={field.streaming}
      onValueChange={(next) => {
        const selected = typeof next === 'string' ? next : '';
        field.setValue(selected);
        field.validate(selected);
      }}
    >
      <SelectTrigger
        id={wiring?.controlId ?? field.name}
        aria-invalid={field.error ? true : undefined}
        aria-describedby={wiring?.describedBy}
        className="w-full"
      >
        <SelectValue placeholder={props.placeholder ?? 'Select...'} />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function SelectItemRenderer() {
  return null;
}

// ─── DatePicker ──────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && ISO_DATE.test(value.slice(0, 10))) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

function toIso(date: Date | undefined): string | undefined {
  return date ? date.toISOString().slice(0, 10) : undefined;
}

function DateTrigger({
  id,
  label,
  invalid,
  describedBy,
  disabled,
}: {
  id: string | undefined;
  label: string;
  invalid: boolean;
  describedBy: string | undefined;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      id={id}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      disabled={disabled}
      className={cn(
        'flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input px-2.5 text-sm transition-colors',
        'focus-visible:border-ring focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive',
        label ? 'text-fg' : 'text-muted-foreground',
      )}
    >
      {label || 'Select date...'}
      <CalendarDays aria-hidden="true" className="size-4 text-muted-foreground" />
    </button>
  );
}

export function DatePickerRenderer({
  props,
}: RenderProps<{
  name: string;
  mode?: 'single' | 'range';
  rules?: Rules;
  value?: unknown;
}>) {
  const field = useField(props.name, props.value, props.rules);
  const wiring = useFieldWiring();
  const mode = props.mode ?? 'single';
  const selected = mode === 'range' ? undefined : toDate(field.value);
  const rangeValue = field.value as { from?: string; to?: string } | undefined;
  const from = mode === 'range' ? toDate(rangeValue?.from) : undefined;
  const to = mode === 'range' ? toDate(rangeValue?.to) : undefined;
  const label =
    mode === 'range'
      ? [rangeValue?.from, rangeValue?.to].filter(Boolean).join(' → ')
      : typeof field.value === 'string'
        ? field.value.slice(0, 10)
        : '';

  return (
    <Popover>
      <PopoverTrigger
        render={
          <DateTrigger
            id={wiring?.controlId ?? field.name}
            label={label}
            invalid={!!field.error}
            describedBy={wiring?.describedBy}
            disabled={field.streaming}
          />
        }
      />
      <PopoverContent align="start" className="w-auto p-0">
        {mode === 'range' ? (
          <Calendar
            mode="range"
            selected={{ from, to }}
            onSelect={(range) => {
              const next = { from: toIso(range?.from), to: toIso(range?.to) };
              field.setValue(next);
              field.validate(next);
            }}
          />
        ) : (
          <Calendar
            mode="single"
            selected={selected}
            onSelect={(date) => {
              const next = toIso(date);
              field.setValue(next);
              field.validate(next);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─── Slider ──────────────────────────────────────────────────────────────────

export function SliderRenderer({
  props,
}: RenderProps<{
  name: string;
  variant: 'continuous' | 'discrete';
  min: number;
  max: number;
  step?: number;
  defaultValue?: number[];
  label?: string;
  rules?: Rules;
  value?: number[];
}>) {
  const field = useField(props.name, props.value, props.rules, {
    componentType: 'Slider',
    defaultValue: props.defaultValue,
  });
  const wiring = useFieldWiring();
  const values = Array.isArray(field.value)
    ? field.value.filter((item): item is number => typeof item === 'number')
    : (props.defaultValue ?? [props.min]);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* Field.Root 的 invalid 是 Base UI 把 aria-invalid 送到 Thumb 内 range input 的官方通道。 */}
      <BaseField.Root invalid={!!field.error}>
        <Slider
          aria-labelledby={wiring?.labelId}
          aria-describedby={wiring?.describedBy}
          min={props.min}
          max={props.max}
          step={props.step ?? (props.variant === 'discrete' ? 1 : undefined)}
          value={values}
          disabled={field.streaming}
          onValueChange={(next) => field.setValue(Array.isArray(next) ? next : [next])}
          onValueCommitted={(next) => field.validate(Array.isArray(next) ? next : [next])}
        />
      </BaseField.Root>
      <div className="flex justify-between font-mono text-xs tabular-nums text-muted-foreground">
        <span>{props.min}</span>
        <span className="text-fg">{values.join(' – ')}</span>
        <span>{props.max}</span>
      </div>
    </div>
  );
}

// ─── Selection groups ────────────────────────────────────────────────────────

export function CheckBoxGroupRenderer({
  props,
}: RenderProps<{
  name: string;
  items: unknown[];
  rules?: Rules;
  value?: Record<string, unknown>;
}>) {
  const field = useField(props.name, props.value, props.rules);
  const wiring = useFieldWiring();
  const items = (props.items ?? [])
    .map((item) =>
      childProps<{ label: string; description: string; name: string; defaultChecked?: boolean }>(
        item,
      ),
    )
    .filter(
      (
        item,
      ): item is { label: string; description: string; name: string; defaultChecked?: boolean } =>
        !!item,
    );
  const stored = (field.value ?? {}) as Record<string, unknown>;
  const checkedFor = (itemName: string) =>
    Boolean(
      stored[itemName] ?? items.find((item) => item.name === itemName)?.defaultChecked ?? false,
    );

  if (items.length === 0) return null;
  return (
    <RangeGroup
      labelledBy={wiring?.labelId}
      describedBy={wiring?.describedBy}
      invalid={!!field.error}
      className="flex flex-col gap-2"
    >
      {items.map((item) => {
        const id = `${wiring?.controlId ?? field.name}-${item.name}`;
        return (
          <div key={item.name} className="flex items-start gap-2">
            <Checkbox
              id={id}
              checked={checkedFor(item.name)}
              disabled={field.streaming}
              aria-invalid={field.error ? true : undefined}
              aria-describedby={wiring?.describedBy}
              onCheckedChange={(checked) => {
                const next = { ...stored, [item.name]: checked === true };
                field.setValue(next);
                field.validate(next);
              }}
            />
            <div className="flex min-w-0 flex-col">
              <Label htmlFor={id}>{item.label}</Label>
              {item.description ? (
                <span className="text-sm text-muted-foreground">{item.description}</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </RangeGroup>
  );
}

export function CheckBoxItemRenderer() {
  return null;
}

export function RadioGroupRenderer({
  props,
}: RenderProps<{
  name: string;
  items: unknown[];
  defaultValue?: string;
  rules?: Rules;
  value?: string;
}>) {
  const field = useField(props.name, props.value, props.rules, {
    componentType: 'RadioGroup',
    defaultValue: props.defaultValue,
  });
  const wiring = useFieldWiring();
  const items = (props.items ?? [])
    .map((item) => childProps<{ label: string; description: string; value: string }>(item))
    .filter((item): item is { label: string; description: string; value: string } => !!item);
  const value = typeof field.value === 'string' ? field.value : (props.defaultValue ?? '');
  if (items.length === 0) return null;
  return (
    <RadioGroup
      aria-labelledby={wiring?.labelId}
      aria-describedby={wiring?.describedBy}
      aria-invalid={field.error ? true : undefined}
      value={value}
      disabled={field.streaming}
      onValueChange={(next) => {
        field.setValue(next);
        field.validate(next);
      }}
    >
      {items.map((item) => {
        const id = `${wiring?.controlId ?? field.name}-${item.value}`;
        return (
          <div key={item.value} className="flex items-start gap-2">
            <RadioGroupItem
              id={id}
              value={item.value}
              aria-invalid={field.error ? true : undefined}
              aria-describedby={wiring?.describedBy}
              className="mt-0.5"
            />
            <div className="flex min-w-0 flex-col">
              <Label htmlFor={id}>{item.label}</Label>
              {item.description ? (
                <span className="text-sm text-muted-foreground">{item.description}</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </RadioGroup>
  );
}

export function RadioItemRenderer() {
  return null;
}

export function SwitchGroupRenderer({
  props,
}: RenderProps<{
  name: string;
  variant?: 'clear' | 'card' | 'sunk';
  items: unknown[];
  value?: Record<string, unknown>;
}>) {
  const field = useField(props.name, props.value, undefined);
  // 同一消息的两段可以有同名 SwitchGroup；条目 id 必须按实例生成。
  const groupId = useId();
  const items = (props.items ?? [])
    .map((item) =>
      childProps<{ label?: string; description?: string; name: string; defaultChecked?: boolean }>(
        item,
      ),
    )
    .filter(
      (
        item,
      ): item is { label?: string; description?: string; name: string; defaultChecked?: boolean } =>
        !!item,
    );
  const stored = (field.value ?? {}) as Record<string, unknown>;
  const checkedFor = (itemName: string) =>
    Boolean(
      stored[itemName] ?? items.find((item) => item.name === itemName)?.defaultChecked ?? false,
    );
  if (items.length === 0) return null;
  return (
    <div
      className={cn(
        'flex flex-col gap-2',
        props.variant === 'card' && 'rounded-card bg-chip p-3',
        props.variant === 'sunk' && 'rounded-card bg-sunken p-3',
      )}
    >
      {items.map((item) => {
        const id = `${groupId}-${item.name}`;
        return (
          <div key={item.name} className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col">
              <Label htmlFor={id}>{item.label ?? item.name}</Label>
              {item.description ? (
                <span className="text-sm text-muted-foreground">{item.description}</span>
              ) : null}
            </div>
            <Switch
              id={id}
              checked={checkedFor(item.name)}
              disabled={field.streaming}
              onCheckedChange={(checked) =>
                field.setValue({ ...stored, [item.name]: checked === true })
              }
            />
          </div>
        );
      })}
    </div>
  );
}

export function SwitchItemRenderer() {
  return null;
}

/** Chips 与 OptionCards 共用的多选 / 单选状态。 */
function useSelectionField(
  name: string,
  type: 'single' | 'multiple',
  defaultValue: string | string[] | undefined,
  rules: Rules | undefined,
  componentType: string,
) {
  const storedDefault =
    type === 'single'
      ? typeof defaultValue === 'string'
        ? defaultValue
        : defaultValue?.[0]
      : defaultValue;
  const field = useField(name, undefined, rules, {
    componentType,
    defaultValue: storedDefault,
  });
  const stored = field.value;
  // 与官方 normalizeSelection 一致：空值代表「用户清空了选择」，不能回落 defaultValue。
  const selection = useMemo(() => {
    if (type === 'single') {
      if (typeof stored === 'string') return stored ? [stored] : [];
      if (Array.isArray(stored) && typeof stored[0] === 'string')
        return stored[0] ? [stored[0]] : [];
      return typeof storedDefault === 'string' && storedDefault ? [storedDefault] : [];
    }
    if (Array.isArray(stored))
      return stored.filter((item): item is string => typeof item === 'string');
    if (typeof stored === 'string') return stored ? [stored] : [];
    if (Array.isArray(storedDefault))
      return storedDefault.filter((item): item is string => typeof item === 'string');
    return typeof storedDefault === 'string' && storedDefault ? [storedDefault] : [];
  }, [stored, storedDefault, type]);

  const toggle = (value: string) => {
    const next =
      type === 'single'
        ? selection[0] === value
          ? []
          : [value]
        : selection.includes(value)
          ? selection.filter((item) => item !== value)
          : [...selection, value];
    const storedValue = type === 'single' ? (next[0] ?? '') : next;
    field.setValue(storedValue);
    field.validate(type === 'single' ? (next[0] ?? undefined) : next);
  };

  return { ...field, selection, toggle };
}

export function ChipsRenderer({
  props,
  renderNode,
}: RenderProps<{
  name: string;
  type: 'single' | 'multiple';
  items: unknown[];
  rules?: Rules;
  defaultValue?: string | string[];
}>) {
  const state = useSelectionField(
    props.name,
    props.type ?? 'multiple',
    props.defaultValue,
    props.rules,
    'Chips',
  );
  const items = (props.items ?? [])
    .map((item) =>
      childProps<{ value: string; label: string; icon?: unknown; disabled?: boolean }>(item),
    )
    .filter(
      (item): item is { value: string; label: string; icon?: unknown; disabled?: boolean } =>
        !!item?.value,
    );
  const wiring = useFieldWiring();
  if (items.length === 0) return null;
  return (
    <RangeGroup
      labelledBy={wiring?.labelId}
      describedBy={wiring?.describedBy}
      invalid={!!state.error}
      className="flex flex-wrap gap-1.5"
    >
      {items.map((item) => {
        const selected = state.selection.includes(item.value);
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={selected}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={wiring?.describedBy}
            disabled={state.streaming || item.disabled}
            onClick={() => state.toggle(item.value)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected
                ? 'border-line-strong bg-selected text-fg'
                : 'border-line bg-transparent text-muted-foreground hover:bg-hover',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            {item.icon ? renderNode(item.icon) : null}
            {item.label}
          </button>
        );
      })}
    </RangeGroup>
  );
}

export function ChipItemRenderer() {
  return null;
}

export function OptionCardsRenderer({
  props,
  renderNode,
}: RenderProps<{
  name: string;
  type: 'single' | 'multiple';
  items: unknown[];
  rules?: Rules;
  defaultValue?: string | string[];
}>) {
  const state = useSelectionField(
    props.name,
    props.type ?? 'single',
    props.defaultValue,
    props.rules,
    'OptionCards',
  );
  const items = (props.items ?? [])
    .map((item) =>
      childProps<{
        value: string;
        title: string;
        subtitle?: string;
        topContent?: unknown;
        disabled?: boolean;
      }>(item),
    )
    .filter(
      (
        item,
      ): item is {
        value: string;
        title: string;
        subtitle?: string;
        topContent?: unknown;
        disabled?: boolean;
      } => !!item?.value,
    );
  const wiring = useFieldWiring();
  if (items.length === 0) return null;
  return (
    <RangeGroup
      labelledBy={wiring?.labelId}
      describedBy={wiring?.describedBy}
      invalid={!!state.error}
      className="grid grid-cols-1 gap-2 sm:grid-cols-2"
    >
      {items.map((item) => {
        const selected = state.selection.includes(item.value);
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={selected}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={wiring?.describedBy}
            disabled={state.streaming || item.disabled}
            onClick={() => state.toggle(item.value)}
            className={cn(
              'flex min-w-0 items-start gap-2 rounded-card border p-3 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected ? 'border-line-strong bg-selected' : 'border-line hover:bg-hover',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            {item.topContent ? (
              <span className="shrink-0">{renderNode(item.topContent)}</span>
            ) : null}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-fg">{item.title}</span>
              {item.subtitle ? (
                <span className="text-sm text-muted-foreground">{item.subtitle}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </RangeGroup>
  );
}

export function OptionCardRenderer() {
  return null;
}

// ─── Form ────────────────────────────────────────────────────────────────────

export function FormRenderer({
  props,
  renderNode,
}: RenderProps<{ name: string; buttons: unknown; fields: unknown[] }>) {
  const validation = useCreateFormValidation();
  return (
    <FormValidationContext.Provider value={validation}>
      <FormNameContext.Provider value={props.name}>
        {/* biome-ignore lint/a11y/useSemanticElements: 提交由 OpenUI 的 Buttons 触发，套 <form> 会多出一条浏览器原生提交路径。 */}
        <div role="form" aria-label={props.name} className="flex min-w-0 flex-col gap-4">
          <FieldGroup className="gap-4">{renderNode(props.fields)}</FieldGroup>
          {renderNode(props.buttons)}
        </div>
      </FormNameContext.Provider>
    </FormValidationContext.Provider>
  );
}

export function FormControlRenderer({
  props,
  renderNode,
}: RenderProps<{ label: string; input: unknown; hint?: string }>) {
  const validation = useFormValidation();
  const streaming = useIsStreaming();
  const inputProps = childProps<{ name?: string; rules?: Rules }>(props.input);
  const fieldName = inputProps?.name;
  const error = fieldName ? validation?.errors[fieldName] : undefined;
  const required = inputProps?.rules?.required === true;
  // 同一消息可以有多个 UI 段、每段都有自己的 Form；id 必须按实例生成，不能只用字段名。
  const controlId = useId();
  const labelId = `${controlId}-label`;
  // 提示与错误各自成一行的位置固定：出错时 hint 仍保留格式/约束信息，不因错误消失。
  const hintId = props.hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const labelable = LABELABLE_INPUTS.has(inputTypeName(props.input) ?? '');
  const wiring = useMemo<FieldWiring>(
    () => ({
      controlId,
      labelId,
      describedBy: [hintId, errorId].filter(Boolean).join(' ') || undefined,
    }),
    [controlId, labelId, hintId, errorId],
  );

  return (
    <Field
      className="gap-1.5"
      data-invalid={error ? 'true' : undefined}
      data-disabled={streaming ? 'true' : undefined}
    >
      {labelable ? (
        <FieldLabel id={labelId} htmlFor={controlId} className="text-fg">
          {props.label}
          {required ? <RequiredMark /> : null}
        </FieldLabel>
      ) : (
        <FieldTitle id={labelId} className="text-fg">
          {props.label}
          {required ? <RequiredMark /> : null}
        </FieldTitle>
      )}
      <FieldWiringContext.Provider value={wiring}>
        {renderNode(props.input)}
      </FieldWiringContext.Provider>
      {props.hint ? <FieldDescription id={hintId}>{props.hint}</FieldDescription> : null}
      <FieldControlError id={errorId} className="flex items-center gap-1">
        {error ? (
          <>
            <CircleAlert aria-hidden="true" />
            {error}
          </>
        ) : undefined}
      </FieldControlError>
    </Field>
  );
}

export function ButtonsRenderer({
  props,
  renderNode,
}: RenderProps<{ buttons: unknown[]; direction?: 'row' | 'column' }>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2',
        props.direction === 'column' && 'flex-col items-stretch',
      )}
    >
      {renderNode(props.buttons)}
    </div>
  );
}

const BUTTON_VARIANTS = {
  primary: 'default',
  secondary: 'outline',
  tertiary: 'ghost',
} as const;

/** 与官方 Button 一致：只有提交类步骤（发消息 / mutation / 自定义动作）才拦在表单校验后。 */
function needsFormValidation(action: unknown): boolean {
  if (!isActionPlan(action)) return true;
  return action.steps.some(
    (step) =>
      step.type === ACTION_STEPS.ToAssistant ||
      step.type === 'custom_action' ||
      (step.type === ACTION_STEPS.Run && step.refType === 'mutation'),
  );
}

export function ButtonRenderer({
  props,
}: RenderProps<{
  label: string;
  action?: unknown;
  variant?: keyof typeof BUTTON_VARIANTS;
  type?: 'normal' | 'destructive';
  size?: 'extra-small' | 'small' | 'medium' | 'large';
}>) {
  const trigger = useTriggerAction();
  const formName = useFormName();
  const streaming = useIsStreaming();
  const validation = useFormValidation();
  const variant = props.variant ?? 'primary';
  const size = props.size ?? 'medium';

  return (
    <UiButton
      type="button"
      variant={props.type === 'destructive' ? 'destructive' : BUTTON_VARIANTS[variant]}
      size={
        size === 'extra-small'
          ? 'xs'
          : size === 'small'
            ? 'sm'
            : size === 'large'
              ? 'lg'
              : 'default'
      }
      disabled={streaming}
      onClick={() => {
        // 只有主按钮的提交类动作承担表单语义：校验不过就地显示错误，不发消息。
        if (
          variant === 'primary' &&
          validation &&
          needsFormValidation(props.action) &&
          !validation.validateForm()
        ) {
          return;
        }
        void trigger(props.label, formName, props.action as Parameters<typeof trigger>[2]);
      }}
    >
      {props.label}
    </UiButton>
  );
}

export function IconButtonRenderer({
  props,
  renderNode,
}: RenderProps<{
  name: string;
  icon: unknown;
  action?: unknown;
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: 'extra-small' | 'small' | 'medium' | 'large';
  shape?: 'square' | 'circle';
}>) {
  const trigger = useTriggerAction();
  const formName = useFormName();
  const streaming = useIsStreaming();
  const size = props.size ?? 'medium';
  return (
    <UiButton
      type="button"
      aria-label={props.name}
      title={props.name}
      variant={BUTTON_VARIANTS[props.variant ?? 'secondary']}
      size={
        size === 'extra-small'
          ? 'icon-xs'
          : size === 'small'
            ? 'icon-sm'
            : size === 'large'
              ? 'icon-lg'
              : 'icon'
      }
      className={props.shape === 'circle' ? 'rounded-full' : undefined}
      disabled={streaming}
      onClick={() =>
        void trigger(props.name, formName, props.action as Parameters<typeof trigger>[2])
      }
    >
      {renderNode(props.icon)}
    </UiButton>
  );
}
