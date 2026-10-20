import { Link } from '@tanstack/react-router';
import { Page, PageHeader } from '../components/page.js';
import { buttonVariants } from '../components/ui/button.js';

export function NotFoundPage() {
  return (
    <Page>
      <PageHeader
        title="页面不存在"
        description="地址可能已变更，或该功能尚未上线。"
        actions={
          <Link to="/" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
            返回概览
          </Link>
        }
      />
    </Page>
  );
}
