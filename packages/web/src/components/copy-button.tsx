import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { toastError } from '../lib/toast.js';
import { Button } from './ui/button.js';

/**
 * 复制文本，1.5s 内显示「已复制」。
 * label 同时作为 aria-label、title 与（showLabel 时）可见文字；定位由调用方用 className 决定。
 */
export function CopyButton({
  value,
  label,
  showLabel = false,
  variant,
  className,
}: {
  value: string;
  label: string;
  showLabel?: boolean;
  variant?: 'outline' | 'ghost';
  className?: string;
}) {
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  // 用值本身而不是布尔标记判断反馈：正文换成另一份时立刻回到「复制」，不会闪回上一份的「已复制」。
  const copied = copiedValue === value;
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setCopiedValue((current) => (current === value ? current : null));
    return () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      resetTimer.current = null;
    };
  }, [value]);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      setCopiedValue(value);
      resetTimer.current = setTimeout(() => setCopiedValue(null), 1500);
    } catch {
      toastError(new Error('无法复制，请选择内容后手动复制。'));
    }
  };
  const text = copied ? '已复制' : label;
  return (
    <Button
      variant={variant ?? (showLabel ? 'outline' : 'ghost')}
      size={showLabel ? 'sm' : 'icon-sm'}
      onClick={() => void copy()}
      aria-label={text}
      title={text}
      className={className}
    >
      <span className="grid">
        <Copy
          aria-hidden="true"
          data-icon={showLabel ? 'inline-start' : undefined}
          className={cn(
            'col-start-1 row-start-1 transition-opacity duration-150 ease-out-soft',
            copied ? 'opacity-0' : 'opacity-100',
          )}
        />
        <Check
          aria-hidden="true"
          data-icon={showLabel ? 'inline-start' : undefined}
          className={cn(
            'col-start-1 row-start-1 text-success transition-opacity duration-150 ease-out-soft',
            copied ? 'opacity-100' : 'opacity-0',
          )}
        />
      </span>
      {showLabel ? text : null}
    </Button>
  );
}
