import { Link } from '@tanstack/react-router';
import { Compass } from 'lucide-react';
import { EmptyState } from '../components/states.js';
import { buttonVariants } from '../components/ui/button.js';

export function NotFoundPage() {
  return (
    <EmptyState
      icon={<Compass className="size-5" />}
      title="页面不存在"
      description="地址可能已变更，或该功能尚未上线。"
      action={
        <Link to="/" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
          返回概览
        </Link>
      }
    />
  );
}
