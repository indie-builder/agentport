import { createFileRoute } from '@tanstack/react-router';
import { PersonalLayout } from '../../pages/personal-profile.js';

export const Route = createFileRoute('/_shell/personal')({
  component: PersonalLayout,
});
