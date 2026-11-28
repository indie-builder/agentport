import {
  SliderControl,
  SliderIndicator,
  Slider as SliderPrimitive,
  SliderThumb,
  SliderTrack,
} from '@ui-sdk/react/slider';
import { type ComponentProps, useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';

const sliderClassName = 'data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full';

type SliderProps = Omit<ComponentProps<typeof SliderPrimitive>, 'className'> & {
  className?: ComponentProps<typeof SliderPrimitive>['className'] | undefined;
  thumbLabels?: readonly string[] | undefined;
};

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  thumbLabels,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  ...props
}: SliderProps) {
  const controlRef = useRef<HTMLDivElement | null>(null);
  const appliedInvalidRef = useRef(false);
  const appliedDescribedByRef = useRef(false);
  const normalizedValue = Array.isArray(value) ? (value.length > 0 ? value : [min]) : value;
  const normalizedDefaultValue = Array.isArray(defaultValue)
    ? defaultValue.length > 0
      ? defaultValue
      : [min]
    : defaultValue;
  const _values = Array.isArray(normalizedValue)
    ? normalizedValue
    : Array.isArray(normalizedDefaultValue)
      ? normalizedDefaultValue
      : [min];
  const thumbCount = _values.length;
  const isSingle = thumbCount === 1;
  const baseLabel = ariaLabel?.trim();
  const rootAria = {
    ...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }),
    ...(ariaLabelledBy === undefined ? {} : { 'aria-labelledby': ariaLabelledBy }),
    ...(ariaDescribedBy === undefined ? {} : { 'aria-describedby': ariaDescribedBy }),
    ...(ariaInvalid === undefined ? {} : { 'aria-invalid': ariaInvalid }),
  };

  useEffect(() => {
    const control = controlRef.current;
    if (!control || thumbCount === 0) return;
    const sliderRoot = control.closest('[data-slot="slider"]');
    const syncDescribedBy = !isSingle && ariaDescribedBy === undefined;
    const sync = () => {
      const rootInvalid = sliderRoot?.getAttribute('aria-invalid') ?? null;
      const nextInvalid = ariaInvalid === undefined ? rootInvalid : String(ariaInvalid);
      const rootDescribedBy = syncDescribedBy
        ? (sliderRoot?.getAttribute('aria-describedby') ?? null)
        : null;
      for (const input of control.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
        if (nextInvalid != null) {
          if (input.getAttribute('aria-invalid') !== nextInvalid) {
            input.setAttribute('aria-invalid', nextInvalid);
          }
        } else if (appliedInvalidRef.current) {
          input.removeAttribute('aria-invalid');
        }
        if (syncDescribedBy) {
          if (rootDescribedBy) {
            if (input.getAttribute('aria-describedby') !== rootDescribedBy) {
              input.setAttribute('aria-describedby', rootDescribedBy);
            }
          } else if (appliedDescribedByRef.current) {
            input.removeAttribute('aria-describedby');
          }
        }
      }
      appliedInvalidRef.current = nextInvalid != null;
      if (syncDescribedBy) {
        appliedDescribedByRef.current = Boolean(rootDescribedBy);
      }
    };
    sync();
    const observeAttrs: string[] = [];
    if (ariaInvalid === undefined) observeAttrs.push('aria-invalid');
    if (syncDescribedBy) observeAttrs.push('aria-describedby');
    if (observeAttrs.length === 0 || !sliderRoot || typeof MutationObserver === 'undefined') {
      return;
    }
    const observer = new MutationObserver(sync);
    observer.observe(sliderRoot, { attributes: true, attributeFilter: observeAttrs });
    return () => observer.disconnect();
  }, [ariaInvalid, ariaDescribedBy, isSingle, thumbCount]);

  return (
    <SliderPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(sliderClassName, className(state))
          : cn(sliderClassName, className)
      }
      min={min}
      max={max}
      {...(normalizedDefaultValue === undefined ? {} : { defaultValue: normalizedDefaultValue })}
      {...(normalizedValue === undefined ? {} : { value: normalizedValue })}
      {...rootAria}
      {...props}
    >
      <SliderControl
        ref={controlRef}
        className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col"
      >
        <SliderTrack className="relative grow overflow-hidden rounded-full bg-muted select-none data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1">
          <SliderIndicator className="bg-primary select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full" />
        </SliderTrack>
        {Array.from({ length: _values.length }, (_, index) => {
          const thumbKey = isSingle
            ? 'single'
            : index === 0
              ? 'start'
              : index === _values.length - 1
                ? 'end'
                : `thumb-${index}`;
          const defaultThumbLabel =
            _values.length === 2 ? (index === 0 ? '最小值' : '最大值') : `滑块 ${index + 1}`;
          const thumbAria = isSingle
            ? {
                ...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }),
                ...(ariaLabelledBy === undefined ? {} : { 'aria-labelledby': ariaLabelledBy }),
                ...(ariaDescribedBy === undefined ? {} : { 'aria-describedby': ariaDescribedBy }),
              }
            : {
                'aria-label':
                  thumbLabels?.[index] ??
                  (baseLabel ? `${baseLabel} ${defaultThumbLabel}` : defaultThumbLabel),
                ...(ariaDescribedBy === undefined ? {} : { 'aria-describedby': ariaDescribedBy }),
              };
          return (
            <SliderThumb
              key={thumbKey}
              index={index}
              className="relative block size-3 shrink-0 rounded-full border border-control-boundary bg-surface ring-ring transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:border-transparent hover:ring-2 has-[:focus-visible]:border-transparent has-[:focus-visible]:ring-2 [&_input:focus-visible]:outline-none data-dragging:border-transparent data-dragging:ring-2 data-disabled:pointer-events-none data-disabled:opacity-50"
              {...thumbAria}
            />
          );
        })}
      </SliderControl>
    </SliderPrimitive>
  );
}

export { Slider };
