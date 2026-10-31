import { Link } from '@tanstack/react-router';
import { Page, PageHeader, PageNote } from '../components/page.js';
import { buttonVariants } from '../components/ui/button.js';

export function NotFoundPage() {
  return (
    <Page>
      <PageHeader title="页面不存在" />
      <PageNote
        title="请检查地址"
        action={
          <Link to="/" className={buttonVariants({ variant: 'outline' })}>
            返回工作台
          </Link>
        }
      />
    </Page>
  );
}
