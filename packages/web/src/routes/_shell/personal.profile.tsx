import { createFileRoute } from '@tanstack/react-router';
import { PersonalProfilePage } from '../../pages/personal-profile.js';

export const Route = createFileRoute('/_shell/personal/profile')({
  component: PersonalProfilePage,
});
