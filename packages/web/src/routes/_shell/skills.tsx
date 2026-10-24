import { createFileRoute } from '@tanstack/react-router';
import { SkillsPage } from '../../pages/skills.js';
import { skillsSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/skills')({
  validateSearch: skillsSearchSchema,
  component: SkillsPage,
});
