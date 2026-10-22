import { Link } from '@tanstack/react-router';
import { Page, PageHeader, PageNote } from '../components/page.js';
import { Button } from '../components/ui/button.js';

export function NotFoundPage() {
  return (
    <Page>
      <PageHeader title="页面不存在" />
      <PageNote
        title="找不到这个地址"
        description="请检查地址，或返回工作台继续。"
        action={
          <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
            返回工作台
          </Button>
        }
      />
    </Page>
  );
}
