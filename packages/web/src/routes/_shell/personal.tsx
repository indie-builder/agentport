import { createFileRoute, Outlet } from '@tanstack/react-router';

function PersonalLayout() {
  // 六页共用 1024px 内容轴；左对齐，不居中，不改动外壳与侧栏。
  return (
    <div className="w-full min-w-0 max-w-5xl">
      <Outlet />
    </div>
  );
}

export const Route = createFileRoute('/_shell/personal')({
  component: PersonalLayout,
});
