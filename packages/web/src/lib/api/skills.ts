import type {
  CursorPage,
  Skill,
  SkillFile,
  SkillInput,
  SkillWithAgentCount,
} from '@agentport/shared';
import { rpc } from '../orpc.js';

export interface SkillImportResult {
  skill: Skill;
  warnings: string[];
}

export default {
  skills: (
    query: { status?: Skill['status']; cursor?: string; limit?: number } = {},
  ): Promise<CursorPage<SkillWithAgentCount>> => rpc.skills.list({ query }),
  createSkill: (input: SkillInput): Promise<Skill> => rpc.skills.create({ body: input }),
  importSkillFile: (content: string): Promise<SkillImportResult> =>
    rpc.skills.importFile({ body: { skillMd: content } }),
  updateSkill: (
    id: string,
    input: Partial<SkillInput>,
    expectedUpdatedAt?: string,
  ): Promise<Skill> =>
    rpc.skills.update({
      params: { id },
      body: {
        ...input,
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      },
    }),
  deleteSkill: (id: string): Promise<void> => rpc.skills.delete({ params: { id } }),
  submitSkill: (id: string): Promise<Skill> => rpc.skills.submit({ params: { id } }),
  approveSkill: (id: string): Promise<Skill> => rpc.skills.approve({ params: { id } }),
  rejectSkill: (id: string, note: string): Promise<Skill> =>
    rpc.skills.reject({ params: { id }, body: { note } }),
  skillFiles: (id: string): Promise<SkillFile[]> => rpc.skills.files({ params: { id } }),
  writeSkillFile: (id: string, path: string, content: string): Promise<SkillFile> =>
    rpc.skills.writeFile({ params: { id, path }, body: { content } }),
  deleteSkillFile: (id: string, path: string): Promise<void> =>
    rpc.skills.deleteFile({ params: { id, path } }),
};
