import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import { cn } from 'cn';

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  ...props
}: SliderPrimitive.Root.Props) {
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max];
  // 键盘焦点落在 Thumb 内的原生 range input；Root 上的 aria 不会继承过去，这里显式转发。
  const thumbAria = { 'aria-describedby': props['aria-describedby'] };

  return (
    <SliderPrimitive.Root
      className={cn('data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full', className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-full bg-muted select-none data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-primary select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            {...thumbAria}
            className="relative block size-3 shrink-0 rounded-full border border-control-boundary bg-surface ring-ring transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:border-transparent hover:ring-2 has-[:focus-visible]:border-transparent has-[:focus-visible]:ring-2 [&_input:focus-visible]:outline-none active:border-transparent active:ring-2 disabled:pointer-events-none disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
