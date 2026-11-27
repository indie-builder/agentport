const sizes = {
  standard: { className: 'size-24', pixels: 96 },
  compact: { className: 'size-16', pixels: 64 },
  error: { className: 'size-36', pixels: 144 },
} as const;

type BusinessIllustrationName =
  | 'knowledge'
  | 'documents'
  | 'tools'
  | 'search'
  | 'schedule'
  | 'runs'
  | 'memory'
  | 'outputs'
  | 'agents'
  | 'review'
  | 'sharing'
  | 'not-found';

export function BusinessIllustration({
  name,
  size = 'standard',
}: {
  name: BusinessIllustrationName;
  size?: keyof typeof sizes;
}) {
  const { className, pixels } = sizes[size];
  return (
    <img
      src={`/brand/business/${name}.webp`}
      alt=""
      aria-hidden="true"
      width={pixels}
      height={pixels}
      className={`${className} shrink-0 object-contain`}
    />
  );
}
