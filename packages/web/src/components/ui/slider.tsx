import type { Primitive } from '@ui-sdk/core';
import { slider as sliderPrimitive } from '@ui-sdk/core/slider';
import { useFieldControl } from '@ui-sdk/react/field';
import { createParts, usePart } from '@ui-sdk/react/primitive';
import {
  SliderControl,
  SliderIndicator,
  Slider as SliderPrimitive,
  SliderTrack,
} from '@ui-sdk/react/slider';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

const slider = sliderPrimitive as typeof sliderPrimitive &
  Required<Pick<Primitive, 'options' | 'slots'>>;
const { Thumb: SliderThumb } = createParts(slider, { thumb: 'div' });

function SliderThumbInput({
  index,
  range,
  ...props
}: Pick<
  ComponentProps<'input'>,
  'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-invalid' | 'aria-errormessage'
> & { index: number; range: boolean }) {
  const field = useFieldControl();
  return usePart(
    slider,
    'thumb-input',
    { index, id: String(index) },
    {
      ...props,
      render: ({ value, ...input }) => (
        <input {...(field && !range ? field.props(input) : input)} defaultValue={value} />
      ),
    },
    'input',
  );
}

type SliderProps = ComponentProps<typeof SliderPrimitive> & {
  onValueCommitted?: ((value: number | number[]) => void) | undefined;
};

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  onValueCommit,
  onValueCommitted,
  ...props
}: SliderProps) {
  const _values = Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min];
  // 键盘焦点落在 Thumb 内的原生 range input；Root 上的 aria 不会继承过去，这里显式转发。
  const thumbAria = {
    'aria-label': props['aria-label'],
    'aria-labelledby': props['aria-labelledby'],
    'aria-describedby': props['aria-describedby'],
    'aria-invalid': props['aria-invalid'],
    'aria-errormessage': props['aria-errormessage'],
  };
  const commit =
    onValueCommitted === undefined
      ? onValueCommit
      : (next: number | number[]) => onValueCommitted(next);

  return (
    <SliderPrimitive
      className={cn(
        'data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full',
        className,
      )}
      min={min}
      max={max}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      {...(value === undefined ? {} : { value })}
      {...(commit === undefined ? {} : { onValueCommit: commit })}
      {...props}
    >
      <SliderControl className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col">
        <SliderTrack className="relative grow overflow-hidden rounded-full bg-muted select-none data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1">
          <SliderIndicator className="bg-primary select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full" />
        </SliderTrack>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderThumb
            index={index}
            key={index}
            className="relative block size-3 shrink-0 rounded-full border border-control-boundary bg-surface ring-ring transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:border-transparent hover:ring-2 has-[:focus-visible]:border-transparent has-[:focus-visible]:ring-2 [&_input:focus-visible]:outline-none data-dragging:border-transparent data-dragging:ring-2 data-disabled:pointer-events-none data-disabled:opacity-50"
          >
            <SliderThumbInput index={index} range={_values.length > 1} {...thumbAria} />
          </SliderThumb>
        ))}
      </SliderControl>
    </SliderPrimitive>
  );
}

export { Slider };
