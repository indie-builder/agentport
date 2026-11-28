import {
  ACTION_STEPS,
  FormNameContext,
  FormValidationContext,
  type ParsedRule,
  parseStructuredRules,
  useCreateFormValidation,
  useFormName,
  useFormValidation,
  useIsStreaming,
  useSetDefaultValue,
  useStateField,
  useTriggerAction,
} from '@openuidev/react-lang';
import { CircleAlert } from 'lucide-react';
import { createContext, useContext, useEffect, useId, useMemo, useRef } from 'react';
import { Button as UiButton } from '../../components/ui/button.js';
import { Checkbox, CheckboxGroup } from '../../components/ui/checkbox.js';
import {
  DatePicker,
  DatePickerClear,
  DatePickerContent,
  DatePickerGroup,
  DatePickerInput,
  DatePickerTrigger,
} from '../../components/ui/date-picker.js';
import {
  Field,
  FieldContent,
  FieldError as FieldControlError,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import {
  NumberInput,
  NumberInputControl,
  NumberInputDecrement,
  NumberInputGroup,
  NumberInputIncrement,
} from '../../components/ui/number-input.js';
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
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group.js';
import { cn } from '../../lib/cn.js';
import { childProps, isActionPlan, type RenderProps } from './shared.js';

type Rules = Record<string, string | number | boolean | undefined>;

interface FieldWiring {
  controlId: string;
  labelId: string;
  label: string;
  required: boolean;
  describedBy: string | undefined;
}

const FieldWiringContext = createContext<FieldWiring | null>(null);

const LABELABLE_INPUTS = new Set(['Input', 'TextArea', 'Select', 'DatePicker']);

function inputTypeName(input: unknown): string | undefined {
  return (input as { typeName?: string } | null | undefined)?.typeName;
}

function useFieldWiring() {
  return useContext(FieldWiringContext);
}

function useFieldRules(
  name: string,
  rules: Rules | undefined,
  getValue: () => unknown,
  extraRules: readonly ParsedRule[] = [],
) {
  const validation = useFormValidation();
  const streaming = useIsStreaming();
  const parsed = useMemo(
    () => [...parseStructuredRules(rules), ...extraRules],
    [rules, extraRules],
  );
  const hasRules = parsed.length > 0;
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
  options?: {
    componentType?: string;
    defaultValue?: unknown;
    extraRules?: readonly ParsedRule[];
    getValidationValue?: () => unknown;
  },
) {
  const field = useStateField(name, value);
  const formName = useFormName();
  useSetDefaultValue({
    ...(formName ? { formName } : {}),
    ...(options?.componentType ? { componentType: options.componentType } : {}),
    name,
    existingValue: field.value,
    defaultValue: options?.defaultValue,
  });
  const {
    validation,
    rules: parsed,
    hasRules,
    streaming,
  } = useFieldRules(
    name,
    rules,
    options?.getValidationValue ?? (() => field.value),
    options?.extraRules,
  );
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
    clearError: () => {
      if (hasRules) validation?.clearFieldError(name);
    },
    error,
    streaming,
  };
}

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
  const numberControlRef = useRef<HTMLInputElement | null>(null);
  if (props.type === 'number') {
    const trimmed = typeof field.value === 'string' ? field.value.trim() : '';
    const numericValue =
      typeof field.value === 'number'
        ? Number.isFinite(field.value)
          ? field.value
          : null
        : trimmed !== '' && Number.isFinite(Number(trimmed))
          ? Number(trimmed)
          : null;
    const min =
      typeof props.rules?.min === 'number' && Number.isFinite(props.rules.min)
        ? props.rules.min
        : undefined;
    const max =
      typeof props.rules?.max === 'number' && Number.isFinite(props.rules.max)
        ? props.rules.max
        : undefined;
    return (
      <NumberInput
        name={field.name}
        value={numericValue}
        {...(min === undefined ? {} : { min })}
        {...(max === undefined ? {} : { max })}
        format={{ useGrouping: false, maximumFractionDigits: 12 }}
        disabled={field.streaming}
        onValueChange={(next, details) => {
          if (details.reason === 'input-commit') {
            const raw = numberControlRef.current?.value.trim() ?? '';
            const parsed = raw !== '' ? Number(raw) : Number.NaN;
            const inBounds =
              Number.isFinite(parsed) &&
              (min === undefined || parsed >= min) &&
              (max === undefined || parsed <= max);
            if (inBounds) {
              details.cancel();
              return;
            }
          }
          field.setValue(next === null ? '' : String(next));
        }}
        onValueCommit={(next) => field.validate(next === null ? '' : String(next))}
      >
        <NumberInputGroup>
          <NumberInputDecrement />
          <NumberInputControl
            ref={numberControlRef}
            id={wiring?.controlId ?? field.name}
            placeholder={props.placeholder ?? ''}
            aria-invalid={field.error ? true : undefined}
            aria-required={wiring?.required ? true : undefined}
            onBlur={(event) => field.validate(event.currentTarget.value)}
          />
          <NumberInputIncrement />
        </NumberInputGroup>
      </NumberInput>
    );
  }
  return (
    <Input
      id={wiring?.controlId ?? field.name}
      name={field.name}
      placeholder={props.placeholder ?? ''}
      type={props.type ?? 'text'}
      value={field.value == null ? '' : String(field.value)}
      disabled={field.streaming}
      aria-invalid={field.error ? true : undefined}
      aria-required={wiring?.required ? true : undefined}
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
      aria-required={wiring?.required ? true : undefined}
      onChange={(event) => field.setValue(event.target.value)}
      onBlur={(event) => field.validate(event.target.value)}
    />
  );
}

export function LabelRenderer({ props }: RenderProps<{ text: string }>) {
  return <span className="text-sm font-medium text-fg">{props.text}</span>;
}

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
        size={props.size === 'small' ? 'sm' : 'default'}
        aria-invalid={field.error ? true : undefined}
        aria-required={wiring?.required ? true : undefined}
        className="w-full"
      >
        <SelectValue placeholder={props.placeholder ?? '请选择...'} />
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INVALID_DATE_SENTINEL = '__openui_invalid_date__';
const INVALID_DATE_RULES: readonly ParsedRule[] = [
  { type: 'pattern', arg: `^(?!${INVALID_DATE_SENTINEL}$)` },
];

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = value.slice(0, 10);
  return ISO_DATE.test(date) ? date : null;
}

export function DatePickerRenderer({
  props,
}: RenderProps<{
  name: string;
  mode?: 'single' | 'range';
  rules?: Rules;
  value?: unknown;
}>) {
  const pickerRef = useRef<HTMLDivElement>(null);
  const hasInvalidDateText = () => pickerRef.current?.hasAttribute('data-invalid') ?? false;
  const latestValueRef = useRef<unknown>(props.value);
  const field = useField(props.name, props.value, props.rules, {
    extraRules: INVALID_DATE_RULES,
    getValidationValue: () =>
      hasInvalidDateText() ? INVALID_DATE_SENTINEL : latestValueRef.current,
  });
  latestValueRef.current = field.value;
  const wiring = useFieldWiring();
  const mode = props.mode ?? 'single';
  const selected = mode === 'range' ? null : isoDate(field.value);
  const rangeValue =
    mode === 'range' && typeof field.value === 'object' && field.value !== null
      ? (field.value as { from?: unknown; to?: unknown })
      : undefined;
  const from = mode === 'range' ? isoDate(rangeValue?.from) : null;
  const to = mode === 'range' ? isoDate(rangeValue?.to) : null;
  const range = from && to ? ([from, to] as [string, string]) : null;
  const monthSeed = selected ?? from;

  const scheduleValidation = () => {
    queueMicrotask(() => {
      queueMicrotask(() => {
        field.validate(hasInvalidDateText() ? INVALID_DATE_SENTINEL : latestValueRef.current);
      });
    });
  };

  const handleInput = (text: string) => {
    queueMicrotask(() => {
      queueMicrotask(() => {
        if (hasInvalidDateText()) {
          field.validate(INVALID_DATE_SENTINEL);
        } else if (text.trim() === '') {
          field.validate(latestValueRef.current);
        } else {
          field.clearError();
        }
      });
    });
  };

  return (
    <DatePicker
      ref={pickerRef}
      mode={mode}
      name={field.name}
      value={mode === 'range' ? range : selected}
      {...(monthSeed ? { defaultMonth: monthSeed.slice(0, 7) } : {})}
      disabled={field.streaming}
      onValueChange={(next) => {
        if (mode === 'range') {
          const start = Array.isArray(next) ? next[0] : undefined;
          const end = Array.isArray(next) ? next[1] : undefined;
          const value =
            typeof start === 'string' && start !== '' && typeof end === 'string' && end !== ''
              ? { from: start, to: end }
              : '';
          latestValueRef.current = value;
          field.setValue(value);
          field.validate(value);
          return;
        }
        const value = typeof next === 'string' ? next : '';
        latestValueRef.current = value;
        field.setValue(value);
        field.validate(value);
      }}
    >
      <DatePickerGroup>
        <DatePickerInput
          id={wiring?.controlId ?? field.name}
          placeholder={mode === 'range' ? '开始日期' : '选择日期'}
          aria-invalid={field.error ? true : undefined}
          aria-required={wiring?.required ? true : undefined}
          onInput={(event) => handleInput(event.currentTarget.value)}
          onBlur={scheduleValidation}
          onKeyDown={(event) => {
            if (event.key === 'Enter') scheduleValidation();
          }}
        />
        {mode === 'range' ? (
          <>
            <span aria-hidden="true" className="text-muted-foreground select-none">
              –
            </span>
            <DatePickerInput
              end
              placeholder="结束日期"
              aria-label={wiring?.label ? `${wiring.label} 结束日期` : '结束日期'}
              aria-invalid={field.error ? true : undefined}
              aria-required={wiring?.required ? true : undefined}
              aria-describedby={wiring?.describedBy}
              onInput={(event) => handleInput(event.currentTarget.value)}
              onBlur={scheduleValidation}
              onKeyDown={(event) => {
                if (event.key === 'Enter') scheduleValidation();
              }}
            />
          </>
        ) : null}
        <DatePickerClear />
        <DatePickerTrigger />
      </DatePickerGroup>
      <DatePickerContent />
    </DatePicker>
  );
}

function resolveSliderValues(fieldValue: unknown, defaultValue: unknown, min: number): number[] {
  if (fieldValue === undefined) {
    const initial = Array.isArray(defaultValue)
      ? defaultValue.filter(
          (item): item is number => typeof item === 'number' && Number.isFinite(item),
        )
      : [];
    return initial.length > 0 ? initial : [min];
  }
  if (fieldValue === null) return [min];
  if (Array.isArray(fieldValue)) {
    const filtered = fieldValue.filter(
      (item): item is number => typeof item === 'number' && Number.isFinite(item),
    );
    return filtered.length > 0 ? filtered : [min];
  }
  if (typeof fieldValue === 'number' && Number.isFinite(fieldValue)) {
    return [fieldValue];
  }
  return [min];
}

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
  const standaloneLabelId = useId();
  const values = resolveSliderValues(field.value, props.defaultValue, props.min);
  const isMulti = values.length > 1;
  const step =
    typeof props.step === 'number' && Number.isFinite(props.step) && props.step > 0
      ? props.step
      : props.variant === 'continuous'
        ? Number((Math.abs(props.max - props.min) / 100).toPrecision(4)) || 0.01
        : 1;
  const trimmedLabel = props.label?.trim() ?? '';
  const showStandaloneLabel = !wiring && trimmedLabel !== '';
  const showSupplementLabel =
    Boolean(wiring) && trimmedLabel !== '' && trimmedLabel !== wiring?.label.trim();
  const contextLabel = trimmedLabel || wiring?.label.trim() || undefined;
  const labelledBy = wiring
    ? isMulti
      ? wiring.labelId
      : undefined
    : showStandaloneLabel
      ? standaloneLabelId
      : undefined;
  const sliderAriaLabel = isMulti
    ? contextLabel
    : !wiring && !showStandaloneLabel
      ? contextLabel
      : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {showStandaloneLabel ? (
        <span id={standaloneLabelId} className="text-sm font-medium text-fg">
          {trimmedLabel}
        </span>
      ) : showSupplementLabel ? (
        <span className="text-xs text-muted-foreground">{trimmedLabel}</span>
      ) : null}
      <Slider
        {...(sliderAriaLabel ? { 'aria-label': sliderAriaLabel } : {})}
        {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
        aria-invalid={field.error ? true : undefined}
        aria-required={wiring?.required ? true : undefined}
        {...(wiring?.required ? { required: true } : {})}
        min={props.min}
        max={props.max}
        step={step}
        value={values}
        disabled={field.streaming}
        onValueChange={(next) => field.setValue(Array.isArray(next) ? next : [next])}
        onValueCommit={(next) => field.validate(Array.isArray(next) ? next : [next])}
      />
      <div className="flex justify-between font-mono text-xs tabular-nums text-muted-foreground">
        <span>{props.min}</span>
        <span className="text-fg">{values.join(' – ')}</span>
        <span>{props.max}</span>
      </div>
    </div>
  );
}

function useDefaultCheckedMap(
  items: ReadonlyArray<{ name: string; defaultChecked?: boolean | undefined }>,
) {
  const key = items.some((item) => item.defaultChecked === true)
    ? JSON.stringify(items.map((item) => [item.name, Boolean(item.defaultChecked)]))
    : '';
  return useMemo(
    () =>
      key
        ? (Object.fromEntries(JSON.parse(key) as Array<[string, boolean]>) as Record<
            string,
            boolean
          >)
        : undefined,
    [key],
  );
}

export function CheckBoxGroupRenderer({
  props,
}: RenderProps<{
  name: string;
  items: unknown[];
  rules?: Rules;
  value?: Record<string, unknown>;
}>) {
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
  const defaultMap = useDefaultCheckedMap(items);
  const field = useField(
    props.name,
    props.value,
    props.rules,
    defaultMap === undefined
      ? undefined
      : { componentType: 'CheckBoxGroup', defaultValue: defaultMap },
  );
  const wiring = useFieldWiring();
  const isCleared = field.value === null;
  const stored =
    typeof field.value === 'object' && field.value !== null
      ? (field.value as Record<string, unknown>)
      : undefined;
  const aggregate: Record<string, boolean> = Object.fromEntries(
    items.map((item) => [
      item.name,
      isCleared
        ? false
        : stored !== undefined
          ? Boolean(stored[item.name] ?? item.defaultChecked ?? false)
          : Boolean(item.defaultChecked ?? false),
    ]),
  );
  const selectedValues = items.filter((item) => aggregate[item.name]).map((item) => item.name);

  if (items.length === 0) return null;
  return (
    <CheckboxGroup
      name={field.name}
      aria-labelledby={wiring?.labelId}
      aria-invalid={field.error ? true : undefined}
      aria-required={wiring?.required ? true : undefined}
      disabled={field.streaming}
      value={selectedValues}
      onValueChange={(nextValues) => {
        const selected = new Set(nextValues);
        const next = Object.fromEntries(items.map((item) => [item.name, selected.has(item.name)]));
        field.setValue(next);
        field.validate(next);
      }}
    >
      {items.map((item) => (
        <Field key={item.name} orientation="horizontal" className="items-start gap-2">
          <Checkbox
            value={item.name}
            aria-invalid={field.error ? true : undefined}
            aria-describedby={wiring?.describedBy}
            className="mt-0.5"
          />
          <FieldContent className="gap-0">
            <FieldLabel className="font-normal text-fg">{item.label}</FieldLabel>
            {item.description ? <FieldDescription>{item.description}</FieldDescription> : null}
          </FieldContent>
        </Field>
      ))}
    </CheckboxGroup>
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
  const value =
    field.value === undefined
      ? (props.defaultValue ?? '')
      : typeof field.value === 'string'
        ? field.value
        : '';
  if (items.length === 0) return null;
  return (
    <RadioGroup
      allowNull
      aria-labelledby={wiring?.labelId}
      aria-invalid={field.error ? true : undefined}
      aria-required={wiring?.required ? true : undefined}
      value={value === '' ? null : value}
      disabled={field.streaming}
      onValueChange={(next) => {
        const selected = next ?? '';
        field.setValue(selected);
        field.validate(selected);
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
  const defaultMap = useDefaultCheckedMap(items);
  const field = useField(
    props.name,
    props.value,
    undefined,
    defaultMap === undefined
      ? undefined
      : { componentType: 'SwitchGroup', defaultValue: defaultMap },
  );
  const wiring = useFieldWiring();
  const isCleared = field.value === null;
  const stored =
    typeof field.value === 'object' && field.value !== null
      ? (field.value as Record<string, unknown>)
      : undefined;
  const aggregate: Record<string, boolean> = Object.fromEntries(
    items.map((item) => [
      item.name,
      isCleared
        ? false
        : stored !== undefined
          ? Boolean(stored[item.name] ?? item.defaultChecked ?? false)
          : Boolean(item.defaultChecked ?? false),
    ]),
  );
  if (items.length === 0) return null;
  return (
    /* biome-ignore lint/a11y/useSemanticElements: 标签由外层 FormControl 的 FieldTitle 承载，套无 legend 的 fieldset 反而违背语义。 */
    <div
      role="group"
      aria-labelledby={wiring?.labelId}
      aria-describedby={wiring?.describedBy}
      aria-invalid={field.error ? true : undefined}
      className={cn(
        'flex flex-col gap-2',
        props.variant === 'card' && 'cds-card-surface rounded-card bg-surface p-3',
        props.variant === 'sunk' && 'rounded-card bg-sunken p-3',
      )}
    >
      {items.map((item) => (
        <Field
          key={item.name}
          orientation="horizontal"
          className="items-start justify-between gap-3"
        >
          <FieldContent className="gap-0">
            <FieldLabel className="font-normal text-fg">{item.label ?? item.name}</FieldLabel>
            {item.description ? <FieldDescription>{item.description}</FieldDescription> : null}
          </FieldContent>
          <Switch
            checked={aggregate[item.name] ?? false}
            disabled={field.streaming}
            aria-invalid={field.error ? true : undefined}
            onCheckedChange={(checked) =>
              field.setValue({ ...aggregate, [item.name]: checked === true })
            }
          />
        </Field>
      ))}
    </div>
  );
}

export function SwitchItemRenderer() {
  return null;
}

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
  const selection = useMemo(() => {
    if (stored === null) return [];
    if (type === 'single') {
      if (typeof stored === 'string') return stored ? [stored] : [];
      if (Array.isArray(stored) && typeof stored[0] === 'string')
        return stored[0] ? [stored[0]] : [];
      if (stored !== undefined) return [];
      return typeof storedDefault === 'string' && storedDefault ? [storedDefault] : [];
    }
    if (Array.isArray(stored))
      return stored.filter((item): item is string => typeof item === 'string');
    if (typeof stored === 'string') return stored ? [stored] : [];
    if (stored !== undefined) return [];
    if (Array.isArray(storedDefault))
      return storedDefault.filter((item): item is string => typeof item === 'string');
    return typeof storedDefault === 'string' && storedDefault ? [storedDefault] : [];
  }, [stored, storedDefault, type]);

  const setSelection = (next: string[]) => {
    const storedValue = type === 'single' ? (next[0] ?? '') : next;
    field.setValue(storedValue);
    field.validate(type === 'single' ? (next[0] ?? undefined) : next);
  };

  return { ...field, selection, setSelection };
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
  const type = props.type ?? 'multiple';
  const state = useSelectionField(props.name, type, props.defaultValue, props.rules, 'Chips');
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
    <ToggleGroup
      aria-labelledby={wiring?.labelId}
      aria-describedby={wiring?.describedBy}
      aria-invalid={state.error ? true : undefined}
      aria-required={wiring?.required ? true : undefined}
      disabled={state.streaming}
      multiple={type === 'multiple'}
      value={state.selection}
      onValueChange={(next) => state.setSelection(next)}
      variant="pill"
      size="pill"
      spacing={1.5}
      className="flex w-full min-w-0 flex-wrap"
    >
      {items.map((item) => (
        <ToggleGroupItem
          key={item.value}
          value={item.value}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={wiring?.describedBy}
          disabled={Boolean(item.disabled)}
        >
          {item.icon ? renderNode(item.icon) : null}
          {item.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
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
  const type = props.type ?? 'single';
  const state = useSelectionField(props.name, type, props.defaultValue, props.rules, 'OptionCards');
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
    <ToggleGroup
      aria-labelledby={wiring?.labelId}
      aria-describedby={wiring?.describedBy}
      aria-invalid={state.error ? true : undefined}
      aria-required={wiring?.required ? true : undefined}
      disabled={state.streaming}
      multiple={type === 'multiple'}
      value={state.selection}
      onValueChange={(next) => state.setSelection(next)}
      variant="card"
      size="card"
      className="grid w-full min-w-0 grid-cols-1 items-stretch sm:grid-cols-2"
    >
      {items.map((item) => {
        const selected = state.selection.includes(item.value);
        return (
          <ToggleGroupItem
            key={item.value}
            value={item.value}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={wiring?.describedBy}
            disabled={Boolean(item.disabled)}
          >
            {item.topContent ? (
              <span className="shrink-0">{renderNode(item.topContent)}</span>
            ) : null}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span
                className={cn(
                  'text-sm font-medium',
                  selected ? 'text-selected-foreground' : 'text-fg',
                )}
              >
                {item.title}
              </span>
              {item.subtitle ? (
                <span className="text-sm text-muted-foreground">{item.subtitle}</span>
              ) : null}
            </span>
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

export function OptionCardRenderer() {
  return null;
}

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
  const inputProps = childProps<{
    name?: string;
    rules?: Rules;
    value?: unknown;
    defaultValue?: unknown;
  }>(props.input);
  const fieldName = inputProps?.name;
  const error = fieldName ? validation?.errors[fieldName] : undefined;
  const required = inputProps?.rules?.required === true;
  const controlId = useId();
  const labelId = `${controlId}-label`;
  const hintId = props.hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const inputType = inputTypeName(props.input) ?? '';
  const sliderField = useStateField(
    inputType === 'Slider' ? (fieldName ?? '') : '',
    inputType === 'Slider' ? inputProps?.value : undefined,
  );
  const isSingleSlider =
    inputType === 'Slider' &&
    resolveSliderValues(sliderField.value, inputProps?.defaultValue, 0).length <= 1;
  const labelable = LABELABLE_INPUTS.has(inputType) || isSingleSlider;
  const wiring = useMemo<FieldWiring>(
    () => ({
      controlId,
      labelId,
      label: props.label,
      required,
      describedBy: [hintId, errorId].filter(Boolean).join(' ') || undefined,
    }),
    [controlId, labelId, props.label, required, hintId, errorId],
  );

  return (
    <Field
      className="gap-1.5"
      data-invalid={error ? 'true' : undefined}
      data-disabled={streaming ? 'true' : undefined}
    >
      {labelable ? (
        <FieldLabel
          id={labelId}
          {...(isSingleSlider ? {} : { htmlFor: controlId })}
          className="text-fg"
        >
          {props.label}
          {required ? (
            <span className="ml-0.5 text-danger" aria-hidden="true">
              *
            </span>
          ) : null}
        </FieldLabel>
      ) : (
        <FieldTitle id={labelId} className="text-fg">
          {props.label}
          {required ? (
            <span className="ml-0.5 text-danger" aria-hidden="true">
              *
            </span>
          ) : null}
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

const DESTRUCTIVE_BUTTON_STYLES = {
  primary: {
    variant: 'destructive' as const,
    className: 'bg-destructive text-destructive-foreground shadow-2xs hover:bg-destructive/90',
  },
  secondary: {
    variant: 'outline' as const,
    className: 'border-destructive/40 text-destructive hover:bg-danger-soft hover:text-destructive',
  },
  tertiary: {
    variant: 'ghost' as const,
    className: 'text-destructive hover:bg-danger-soft hover:text-destructive',
  },
} as const;

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
  const destructiveStyle =
    props.type === 'destructive' ? DESTRUCTIVE_BUTTON_STYLES[variant] : undefined;

  return (
    <UiButton
      type="button"
      variant={destructiveStyle ? destructiveStyle.variant : BUTTON_VARIANTS[variant]}
      {...(destructiveStyle ? { className: destructiveStyle.className } : {})}
      size={
        size === 'extra-small'
          ? 'xs'
          : size === 'small'
            ? 'sm'
            : size === 'large'
              ? 'lg'
              : 'default'
      }
      {...(props.type === 'destructive'
        ? { 'data-agent-confirm': `执行危险操作「${props.label}」` }
        : {})}
      disabled={streaming}
      onClick={() => {
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
      {...(props.shape === 'circle' ? { className: 'rounded-full' } : {})}
      disabled={streaming}
      onClick={() =>
        void trigger(props.name, formName, props.action as Parameters<typeof trigger>[2])
      }
    >
      {renderNode(props.icon)}
    </UiButton>
  );
}
