import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ok, created, badRequest, notFound } from '../../utils/response';

const router = Router();

/**
 * GET /api/worker/transfers/incoming
 * Transfers pending acceptance at this worker's stage
 */
router.get('/incoming', async (req: Request, res: Response) => {
  const db = req.tenantDb!;

  // Get stages assigned to this worker
  const assignments = await db('user_stage_assignments').where({ user_id: req.user!.sub }).pluck('stage_id');

  if (!assignments.length) { ok(res, []); return; }

  const transfers = await db('material_transfers as mt')
    .join('lots as l', 'mt.lot_id', 'l.id')
    .join('stages as fs', 'mt.from_stage_id', 'fs.id')
    .join('stages as ts', 'mt.to_stage_id', 'ts.id')
    .leftJoin('users as u', 'mt.requested_by', 'u.id')
    .where({ 'mt.status': 'pending' })
    .whereIn('mt.to_stage_id', assignments)
    .select(
      'mt.*',
      'l.lot_number', 'l.crop', 'l.variety',
      'fs.name as from_stage_name',
      'ts.name as to_stage_name',
      'u.name as requested_by_name'
    )
    .orderBy('mt.requested_at', 'desc');

  ok(res, transfers);
});

/**
 * GET /api/worker/transfers/outgoing
 * Transfers sent by this worker
 */
router.get('/outgoing', async (req: Request, res: Response) => {
  const db = req.tenantDb!;

  const transfers = await db('material_transfers as mt')
    .join('lots as l', 'mt.lot_id', 'l.id')
    .join('stages as fs', 'mt.from_stage_id', 'fs.id')
    .join('stages as ts', 'mt.to_stage_id', 'ts.id')
    .where({ 'mt.requested_by': req.user!.sub })
    .select(
      'mt.*',
      'l.lot_number', 'l.crop', 'l.variety',
      'fs.name as from_stage_name',
      'ts.name as to_stage_name'
    )
    .orderBy('mt.requested_at', 'desc')
    .limit(50);

  ok(res, transfers);
});

/**
 * POST /api/worker/transfers
 * Worker sends material to next stage
 */
router.post('/', async (req: Request, res: Response) => {
  const schema = z.object({
    lotId: z.string().uuid(),
    fromStageId: z.string().uuid(),
    toStageId: z.string().uuid(),
    qty: z.number().positive(),
    unit: z.string().default('kg'),
    notes: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const { lotId, fromStageId, toStageId, qty, unit, notes } = parsed.data;

  if (fromStageId === toStageId) {
    badRequest(res, 'From and To stages must be different');
    return;
  }

  const db = req.tenantDb!;

  // Verify this connection is valid (exists in stage_connections)
  const connection = await db('stage_connections')
    .where({ from_stage_id: fromStageId, to_stage_id: toStageId, is_active: true })
    .first();

  if (!connection) {
    badRequest(res, 'Material transfer not allowed between these stages');
    return;
  }

  const lot = await db('lots').where({ id: lotId, status: 'active' }).first();
  if (!lot) { notFound(res, 'Lot not found or not active'); return; }

  const [transfer] = await db('material_transfers').insert({
    lot_id: lotId,
    from_stage_id: fromStageId,
    to_stage_id: toStageId,
    qty,
    unit,
    requested_by: req.user!.sub,
    notes,
  }).returning('*');

  created(res, transfer, 'Transfer request sent');
});

/**
 * PUT /api/worker/transfers/:id/accept
 */
router.put('/:id/accept', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const transfer = await db('material_transfers').where({ id: req.params.id, status: 'pending' }).first();
  if (!transfer) { notFound(res, 'Transfer not found or already processed'); return; }

  // Update the lot's current stage
  await db.transaction(async (trx) => {
    await trx('material_transfers').where({ id: req.params.id }).update({
      status: 'accepted',
      accepted_by: req.user!.sub,
      responded_at: new Date(),
    });

    // Move lot to the to_stage
    await trx('lots').where({ id: transfer.lot_id }).update({
      current_stage_id: transfer.to_stage_id,
      updated_at: new Date(),
    });
  });

  ok(res, null, 'Transfer accepted');
});

/**
 * PUT /api/worker/transfers/:id/reject
 */
router.put('/:id/reject', async (req: Request, res: Response) => {
  const schema = z.object({ notes: z.string().optional() });
  const parsed = schema.safeParse(req.body);

  const db = req.tenantDb!;
  const transfer = await db('material_transfers').where({ id: req.params.id, status: 'pending' }).first();
  if (!transfer) { notFound(res, 'Transfer not found or already processed'); return; }

  await db('material_transfers').where({ id: req.params.id }).update({
    status: 'rejected',
    accepted_by: req.user!.sub,
    responded_at: new Date(),
    notes: parsed.success ? parsed.data.notes : undefined,
  });

  ok(res, null, 'Transfer rejected');
});

export default router;
