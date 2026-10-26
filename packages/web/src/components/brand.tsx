import { animate } from 'motion/mini';
import type { MouseEvent } from 'react';
import { cn } from '../lib/cn.js';

/** 品牌图层使用固定占位，切换图片不改变导航或表单布局。 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src="/brand/pace-mark.svg"
      alt=""
      aria-hidden="true"
      width={32}
      height={32}
      className={cn('size-8 shrink-0 object-contain', className)}
    />
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <span
      className={cn('relative block aspect-square h-12 max-w-full shrink-0 self-start', className)}
    >
      <img
        src="/brand/pace-wordmark.webp"
        alt="PACE"
        width={512}
        height={512}
        className="absolute inset-0 size-full object-contain"
      />
      <img
        src="/brand/pace-wordmark.webp"
        alt=""
        aria-hidden="true"
        data-brand-incoming="true"
        className="absolute inset-0 size-full object-contain opacity-0"
      />
    </span>
  );
}

const logoSources = [
  '/brand/scenarios/pace-welcome.webp',
  '/brand/scenarios/pace-working.webp',
  '/brand/scenarios/pace-success.webp',
  '/brand/scenarios/pace-search.webp',
  '/brand/scenarios/pace-empty.webp',
  '/brand/scenarios/pace-error.webp',
];
const transitioning = new WeakSet<HTMLImageElement>();

export async function animateBrand(event: MouseEvent<HTMLElement>) {
  event.preventDefault();
  const image = event.currentTarget.querySelector('img');
  const incoming = event.currentTarget.querySelector<HTMLImageElement>('[data-brand-incoming]');
  if (!image || !incoming || transitioning.has(image)) return;
  const index = logoSources.indexOf(image.getAttribute('src') ?? '');
  const nextSource = logoSources[(index + 1) % logoSources.length];
  if (!nextSource) return;
  transitioning.add(image);
  const next = new Image();
  try {
    // 先解码下一张，避免转场中等待图片加载而闪白。
    next.src = nextSource;
    await next.decode();
    if (!image.isConnected) return;
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      incoming.setAttribute('src', nextSource);
      const distance = (image.clientWidth / 96) * 8;
      const transition = { duration: 0.3, ease: [0.22, 1, 0.36, 1] as const };
      const outgoingAnimation = animate(
        image,
        { transform: ['translateX(0px)', `translateX(${-distance}px)`], opacity: [1, 0] },
        transition,
      );
      const incomingAnimation = animate(
        incoming,
        { transform: [`translateX(${distance}px)`, 'translateX(0px)'], opacity: [0, 1] },
        transition,
      );
      try {
        await Promise.all([outgoingAnimation, incomingAnimation]);
      } finally {
        outgoingAnimation.cancel();
        incomingAnimation.cancel();
      }
    }
    image.setAttribute('src', nextSource);
  } catch {
    // 图片或动效失败时保留当前 Logo。
  } finally {
    incoming.style.opacity = '';
    incoming.style.transform = '';
    image.style.opacity = '';
    image.style.transform = '';
    transitioning.delete(image);
  }
}
