import {
  idParams,
  skillFileInputSchema,
  skillFileSchema,
  skillInputSchema,
  skillSchema,
  skillWithAgentCountSchema,
  slugSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const skillFileParams = z.object({
  id: z.string().min(1),
  path: skillFileInputSchema.shape.path,
});
const patchSchema = z.object({
  slug: slugSchema.optional(),
  name: z.string().min(1).max(128).optional(),
  description: z.string().min(1).max(500).optional(),
  body: z.string().optional(),
  license: z.string().max(200).nullable().optional(),
  compatibility: z.string().max(200).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  expectedUpdatedAt: z.iso.datetime().optional(),
});
const importSchema = z.object({ skillMd: z.string().max(131072) });
export const skillsContract = {
  list: contractProcedure
    .meta({ access: { kind: 'permission', permissionId: 'skills.read' } })
    .route({ method: 'GET', path: '/skills', successStatus: 200 })
    .input(z.object({}))
    .output(z.array(skillWithAgentCountSchema)),
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
};
