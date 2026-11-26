import { Link } from '@tanstack/react-router';
import { BusinessIllustration } from '../components/business-illustration.js';
import { Page, PageBody, PageHeader, PageTopbar } from '../components/page.js';
import { EmptyState } from '../components/states.js';
import { buttonVariants } from '../components/ui/button.js';

export function NotFoundPage() {
  return (
    <Page>
      <PageTopbar>
        <PageHeader title="页面不存在" />
      </PageTopbar>
      <PageBody>
        <EmptyState
          variant="stage"
          scale="page"
          illustration={<BusinessIllustration name="not-found" size="error" />}
          title="页面不存在"
          description="请检查访问地址，或返回工作台继续工作。"
          action={
            <Link to="/" className={buttonVariants({ variant: 'outline' })}>
              返回工作台
            </Link>
          }
        />
      </PageBody>
    </Page>
  );
}
