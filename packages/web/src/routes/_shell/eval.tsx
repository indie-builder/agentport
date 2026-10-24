import { createFileRoute } from '@tanstack/react-router';
import { EvalPage } from '../../pages/eval.js';
import { evalSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/eval')({
  validateSearch: evalSearchSchema,
  component: EvalPage,
});
