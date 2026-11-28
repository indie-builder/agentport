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
  const _values = Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min];
  const isSingle = _values.length === 1;
  const rootAria = isSingle
    ? {}
    : {
        ...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }),
        ...(ariaLabelledBy === undefined ? {} : { 'aria-labelledby': ariaLabelledBy }),
        ...(ariaDescribedBy === undefined ? {} : { 'aria-describedby': ariaDescribedBy }),
        ...(ariaInvalid === undefined ? {} : { 'aria-invalid': ariaInvalid }),
      };

  useEffect(() => {
    const control = controlRef.current;
    if (!control) return;
    const rootInvalid = control.closest('[data-slot="slider"]')?.getAttribute('aria-invalid');
    const nextInvalid = ariaInvalid === undefined ? rootInvalid : String(ariaInvalid);
    for (const input of control.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
      if (nextInvalid != null) {
        if (input.getAttribute('aria-invalid') !== nextInvalid) {
          input.setAttribute('aria-invalid', nextInvalid);
        }
      } else if (appliedInvalidRef.current) {
        input.removeAttribute('aria-invalid');
      }
    }
    appliedInvalidRef.current = nextInvalid != null;
  });

  return (
    <SliderPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(sliderClassName, className(state))
          : cn(sliderClassName, className)
      }
      min={min}
      max={max}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      {...(value === undefined ? {} : { value })}
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
          const thumbAria = isSingle
            ? {
                ...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }),
                ...(ariaLabelledBy === undefined ? {} : { 'aria-labelledby': ariaLabelledBy }),
                ...(ariaDescribedBy === undefined ? {} : { 'aria-describedby': ariaDescribedBy }),
                ...(ariaInvalid === undefined ? {} : { 'aria-invalid': ariaInvalid }),
              }
            : {
                'aria-label':
                  thumbLabels?.[index] ??
                  (_values.length === 2
                    ? index === 0
                      ? '最小值'
                      : '最大值'
                    : `滑块 ${index + 1}`),
                ...(ariaDescribedBy === undefined ? {} : { 'aria-describedby': ariaDescribedBy }),
                ...(ariaInvalid === undefined ? {} : { 'aria-invalid': ariaInvalid }),
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
