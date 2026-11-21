import { createFileRoute, Outlet } from '@tanstack/react-router';

function PersonalLayout() {
  return (
    <div className="h-full min-h-0 w-full min-w-0">
      <Outlet />
    </div>
  );
}

export const Route = createFileRoute('/_shell/personal')({
  component: PersonalLayout,
});
