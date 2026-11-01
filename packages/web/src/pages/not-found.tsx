import { Link } from '@tanstack/react-router';
import { BusinessIllustration } from '../components/business-illustration.js';
import { Page, PageHeader } from '../components/page.js';
import { EmptyState } from '../components/states.js';
import { buttonVariants } from '../components/ui/button.js';

export function NotFoundPage() {
  return (
    <Page>
      <PageHeader title="页面不存在" />
      <EmptyState
        illustration={<BusinessIllustration name="not-found" size="error" />}
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
