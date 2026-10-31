import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Page, PageHeader } from '../../components/page.js';
import { homePath } from '../../lib/access.js';
import { meQuery } from '../../lib/queries.js';

/** 根地址不固定跳专家：按当前账户的第一个可用入口落点；没有任何业务权限时进个人资料。 */
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
      <PageHeader title="正在打开…" />
    </Page>
  );
}

export const Route = createFileRoute('/_shell/')({
  component: HomeRedirect,
});
