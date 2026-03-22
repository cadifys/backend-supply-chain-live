import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ok, created, badRequest, notFound } from '../../utils/response';

const router = Router();

/**
 * GET /api/admin/stages
 * Returns all stages with their connections
 */
router.get('/', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const stages = await db('stages').where({ is_active: true }).orderBy('stage_order');

  const connections = await db('stage_connections as sc')
    .join('stages as fs', 'sc.from_stage_id', 'fs.id')
    .join('stages as ts', 'sc.to_stage_id', 'ts.id')
    .where({ 'sc.is_active': true })
    .select(
      'sc.id', 'sc.from_stage_id', 'sc.to_stage_id',
      'fs.name as from_stage_name', 'ts.name as to_stage_name'
    );

  ok(res, { stages, connections });
});

/**
 * POST /api/admin/stages
 */
router.post('/', async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(2),
    description: z.string().optional(),
    stageOrder: z.number().int().min(0).default(0),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const db = req.tenantDb!;
  const [stage] = await db('stages').insert({
    name: parsed.data.name,
    description: parsed.data.description,
    stage_order: parsed.data.stageOrder,
  }).returning('*');

  created(res, stage, 'Stage created');
});

/**
 * PUT /api/admin/stages/:id
 */
router.put('/:id', async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(2).optional(),
    description: z.string().optional(),
    stageOrder: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const db = req.tenantDb!;
  const stage = await db('stages').where({ id: req.params.id }).first();
  if (!stage) { notFound(res, 'Stage not found'); return; }

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.name) updates.name = parsed.data.name;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (parsed.data.stageOrder !== undefined) updates.stage_order = parsed.data.stageOrder;
  if (parsed.data.isActive !== undefined) updates.is_active = parsed.data.isActive;

  const [updated] = await db('stages').where({ id: req.params.id }).update(updates).returning('*');
  ok(res, updated, 'Stage updated');
});

/**
 * POST /api/admin/stages/connections
 * Add a connection between two stages (material flow path)
 */
router.post('/connections', async (req: Request, res: Response) => {
  const schema = z.object({
    fromStageId: z.string().uuid(),
    toStageId: z.string().uuid(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  if (parsed.data.fromStageId === parsed.data.toStageId) {
    badRequest(res, 'From and To stages must be different');
    return;
  }

  const db = req.tenantDb!;

  // Verify both stages exist
  const fromStage = await db('stages').where({ id: parsed.data.fromStageId, is_active: true }).first();
  const toStage = await db('stages').where({ id: parsed.data.toStageId, is_active: true }).first();
  if (!fromStage || !toStage) { notFound(res, 'One or both stages not found'); return; }

  // Check if connection already exists
  const existing = await db('stage_connections')
    .where({ from_stage_id: parsed.data.fromStageId, to_stage_id: parsed.data.toStageId })
    .first();

  if (existing) {
    // Reactivate if was inactive
    if (!existing.is_active) {
      await db('stage_connections').where({ id: existing.id }).update({ is_active: true });
      ok(res, existing, 'Connection reactivated');
    } else {
      badRequest(res, 'Connection already exists');
    }
    return;
  }

  const [connection] = await db('stage_connections').insert({
    from_stage_id: parsed.data.fromStageId,
    to_stage_id: parsed.data.toStageId,
  }).returning('*');

  created(res, connection, 'Stage connection created');
});

/**
 * DELETE /api/admin/stages/connections/:id
 */
router.delete('/connections/:id', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const connection = await db('stage_connections').where({ id: req.params.id }).first();
  if (!connection) { notFound(res, 'Connection not found'); return; }

  await db('stage_connections').where({ id: req.params.id }).update({ is_active: false });
  ok(res, null, 'Connection removed');
});

export default router;
