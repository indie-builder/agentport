import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/_shell/personal/')({
  component: () => <Navigate to="/personal/profile" replace />,
});
