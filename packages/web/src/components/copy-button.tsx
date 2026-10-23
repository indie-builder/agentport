import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
  className,
}: {
  value: string;
  label: string;
  showLabel?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      setCopied(true);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      toastError(new Error('无法复制，请选择内容后手动复制。'));
    }
  };
  const text = copied ? '已复制' : label;
  return (
    <Button
      variant={showLabel ? 'outline' : 'ghost'}
      size={showLabel ? 'sm' : 'icon-sm'}
      onClick={() => void copy()}
      aria-label={text}
      title={text}
      className={className}
    >
      {copied ? (
        <Check data-icon={showLabel ? 'inline-start' : undefined} className="text-success" />
      ) : (
        <Copy data-icon={showLabel ? 'inline-start' : undefined} />
      )}
      {showLabel ? text : null}
    </Button>
  );
}
