import { createFileRoute, Outlet } from '@tanstack/react-router';

function PersonalLayout() {
  // 六页与普通页面同宽、左对齐，不居中，不改动外壳与侧栏；
  // 长文本阅读宽度由各页内部约束（个人记忆 75ch、短字段 448px 等），不在路由层限制整页宽度。
  return (
    <div className="w-full min-w-0">
      <Outlet />
    </div>
  );
}

export const Route = createFileRoute('/_shell/personal')({
  component: PersonalLayout,
});
