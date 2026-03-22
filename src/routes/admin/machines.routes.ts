import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ok, created, badRequest, notFound } from '../../utils/response';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const { stageId } = req.query;

  let query = db('machines as m')
    .leftJoin('stages as s', 'm.stage_id', 's.id')
    .select('m.*', 's.name as stage_name');

  if (stageId) query = query.where({ 'm.stage_id': stageId });

  const machines = await query.where({ 'm.is_active': true }).orderBy('m.name');
  ok(res, machines);
});

router.post('/', async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(2),
    stageId: z.string().uuid().optional(),
    description: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const db = req.tenantDb!;
  const [machine] = await db('machines').insert({
    name: parsed.data.name,
    stage_id: parsed.data.stageId,
    description: parsed.data.description,
  }).returning('*');

  created(res, machine);
});

router.put('/:id', async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(2).optional(),
    stageId: z.string().uuid().nullable().optional(),
    description: z.string().optional(),
    isActive: z.boolean().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const db = req.tenantDb!;
  const machine = await db('machines').where({ id: req.params.id }).first();
  if (!machine) { notFound(res, 'Machine not found'); return; }

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.name) updates.name = parsed.data.name;
  if (parsed.data.stageId !== undefined) updates.stage_id = parsed.data.stageId;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (parsed.data.isActive !== undefined) updates.is_active = parsed.data.isActive;

  const [updated] = await db('machines').where({ id: req.params.id }).update(updates).returning('*');
  ok(res, updated);
});

export default router;
