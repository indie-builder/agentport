import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { buttonVariants } from './ui/button.js';

export function BackLink({
  to,
  label,
  showLabel = false,
}: {
  to: string;
  label: string;
  showLabel?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <a
      href={to}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        void navigate({ href: to });
      }}
      aria-label={label}
      className={buttonVariants(
        showLabel
          ? { variant: 'link', className: 'w-fit px-0' }
          : { variant: 'outline', size: 'icon' },
      )}
    >
      <ArrowLeft aria-hidden="true" />
      {showLabel ? label : null}
    </a>
  );
}
