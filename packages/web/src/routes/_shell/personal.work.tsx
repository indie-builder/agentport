import { createFileRoute } from '@tanstack/react-router';
import { PersonalWorkPage } from '../../pages/personal/work.js';

export const Route = createFileRoute('/_shell/personal/work')({
  component: PersonalWorkPage,
});
