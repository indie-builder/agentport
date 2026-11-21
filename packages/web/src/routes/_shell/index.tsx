import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Page, PageHeader, PageTopbar } from '../../components/page.js';
import { homePath } from '../../lib/access.js';
import { meQuery } from '../../lib/queries.js';

function HomeRedirect() {
  const me = useQuery(meQuery);
  const navigate = useNavigate();
  const target = homePath(me.data);

  useEffect(() => {
    if (!me.isSuccess) return;
    void navigate({ href: target ?? '/personal/profile', replace: true });
  }, [me.isSuccess, navigate, target]);

  return (
    <Page>
      <PageTopbar>
        <PageHeader title="正在打开…" />
      </PageTopbar>
    </Page>
  );
}

export const Route = createFileRoute('/_shell/')({
  component: HomeRedirect,
});
