import {
  cursorPageSchema,
  expectedUpdatedAtSchema,
  idParams,
  MARKDOWN_FILE_MAX_CODE_POINTS,
  pageQuerySchema,
  skillFileInputSchema,
  skillFileSchema,
  skillInputSchema,
  skillSchema,
  skillStatusSchema,
  skillWithAgentCountSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const skillFileParams = z.object({
  id: z.string().min(1),
  path: skillFileInputSchema.shape.path,
});
const skillFields = skillInputSchema.shape;
const patchSchema = z.object({
  name: skillFields.name.optional(),
  description: skillFields.description.optional(),
  body: skillFields.body.removeDefault().optional(),
  license: skillFields.license.nullable(),
  compatibility: skillFields.compatibility.nullable(),
  metadata: skillFields.metadata.nullable(),
  expectedUpdatedAt: expectedUpdatedAtSchema,
});
const importSchema = z.object({ skillMd: z.string().max(MARKDOWN_FILE_MAX_CODE_POINTS) });
const skillListQuery = pageQuerySchema.extend({
  status: skillStatusSchema.optional(),
});
export const skillsContract = {
  list: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'skills.read' } })
    .route({ method: 'GET', path: '/skills', successStatus: 200 })
    .input(z.object({ query: skillListQuery }))
    .output(cursorPageSchema(skillWithAgentCountSchema)),
  create: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'skills.create' } })
    .route({ method: 'POST', path: '/skills', successStatus: 201 })
    .input(z.object({ body: skillInputSchema }))
    .output(skillSchema),
  importFile: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'skills.import' } })
    .route({ method: 'POST', path: '/skills/import', successStatus: 201 })
    .input(z.object({ body: importSchema }))
    .output(z.object({ skill: skillSchema, warnings: z.array(z.string()) })),
  get: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'skills.read' } })
    .route({ method: 'GET', path: '/skills/{id}', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(skillSchema),
  update: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'skills.update' } })
    .route({ method: 'PATCH', path: '/skills/{id}', successStatus: 200 })
    .input(z.object({ params: idParams, body: patchSchema }))
    .output(skillSchema),
  delete: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'skills.delete' } })
    .route({ method: 'DELETE', path: '/skills/{id}', successStatus: 204 })
    .input(z.object({ params: idParams }))
    .output(z.void()),
  files: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'skills.files.read' } })
    .route({ method: 'GET', path: '/skills/{id}/files', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(z.array(skillFileSchema)),
  writeFile: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'skills.files.write' } })
    .route({ method: 'PUT', path: '/skills/{id}/files/{+path}', successStatus: 200 })
    .input(
      z.object({ params: skillFileParams, body: skillFileInputSchema.pick({ content: true }) }),
    )
    .output(skillFileSchema),
  deleteFile: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'skills.files.write' } })
    .route({ method: 'DELETE', path: '/skills/{id}/files/{+path}', successStatus: 204 })
    .input(z.object({ params: skillFileParams }))
    .output(z.void()),
  submit: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'skills.update' } })
    .route({ method: 'POST', path: '/skills/{id}/submit', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(skillSchema),
  approve: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'skills.review' } })
    .route({ method: 'POST', path: '/skills/{id}/approve', successStatus: 200 })
    .input(z.object({ params: idParams }))
    .output(skillSchema),
  reject: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'skills.review' } })
    .route({ method: 'POST', path: '/skills/{id}/reject', successStatus: 200 })
    .input(
      z.object({
        params: idParams,
        body: z.object({ note: z.string().trim().min(1).max(500) }),
      }),
    )
    .output(skillSchema),
};
