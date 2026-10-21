/**
 * 类名合并的唯一实现。
 *
 * 直接用 shadcn 的 `cn` 包（clsx + tailwind-merge 的编译版），
 * 不再自己拼一份，避免两套实现产生不同的合并结果。
 */
export { cn } from 'cn';
