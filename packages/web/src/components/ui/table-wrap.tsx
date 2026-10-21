import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

/**
 * 项目自定义层：表格容器。
 * 窄屏横向滚动，避免挤压列；label 让读屏知道这是什么表格。
 * 底座的 table.tsx 只管表格元素本身，容器语义在这里。
 */
export function TableWrap({
  className,
  label,
  ...props
}: ComponentProps<'section'> & { label: string }) {
  return <section className={cn('overflow-x-auto', className)} aria-label={label} {...props} />;
}
