import { createFileRoute } from '@tanstack/react-router';
import { PersonalSecurityPage } from '../../pages/personal-security.js';

export const Route = createFileRoute('/_shell/personal/security')({
  component: PersonalSecurityPage,
});
