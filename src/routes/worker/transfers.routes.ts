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
    .leftJoin('lots as l', 'mt.lot_id', 'l.id')
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
 * GET /api/worker/transfers/received
 * Transfers accepted by this worker — shows received material waiting to be processed
 */
router.get('/received', async (req: Request, res: Response) => {
  const db = req.tenantDb!;

  const transfers = await db('material_transfers as mt')
    .leftJoin('lots as l', 'mt.lot_id', 'l.id')
    .join('stages as fs', 'mt.from_stage_id', 'fs.id')
    .join('stages as ts', 'mt.to_stage_id', 'ts.id')
    .leftJoin('users as u', 'mt.requested_by', 'u.id')
    .where({ 'mt.accepted_by': req.user!.sub, 'mt.status': 'accepted' })
    .whereRaw(`mt.responded_at >= NOW() - INTERVAL '7 days'`)
    .select(
      'mt.id', 'mt.qty', 'mt.unit', 'mt.responded_at',
      'mt.lot_id', 'mt.to_stage_id',
      'l.lot_number', 'l.crop',
      'fs.name as from_stage_name',
      'ts.name as to_stage_name',
      'u.name as sent_by_name'
    )
    .orderBy('mt.responded_at', 'desc')
    .limit(20);

  ok(res, transfers);
});

/**
 * GET /api/worker/transfers/outgoing
 * Transfers sent by this worker
 */
router.get('/outgoing', async (req: Request, res: Response) => {
  const db = req.tenantDb!;

  const transfers = await db('material_transfers as mt')
    .leftJoin('lots as l', 'mt.lot_id', 'l.id')
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
    lotId: z.string().uuid().optional(),    // Lot is optional
    fromStageId: z.string().uuid(),
    toStageId: z.string().uuid(),
    qty: z.number().positive(),
    unit: z.string().min(1).default('kg'),
    notes: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const { lotId, fromStageId, toStageId, qty, unit, notes } = parsed.data;

  if (fromStageId === toStageId) {
    badRequest(res, 'Source and destination stages must be different');
    return;
  }

  const db = req.tenantDb!;

  // Worker must be assigned to the fromStage
  const assignment = await db('user_stage_assignments')
    .where({ user_id: req.user!.sub, stage_id: fromStageId })
    .first();
  if (!assignment) {
    badRequest(res, 'You are not assigned to the source stage');
    return;
  }

  // Destination stage must exist and be active
  const toStage = await db('stages').where({ id: toStageId, is_active: true }).first();
  if (!toStage) {
    notFound(res, 'Destination stage not found or inactive');
    return;
  }

  // If lot provided, validate it
  if (lotId) {
    const lot = await db('lots').where({ id: lotId, status: 'active' }).first();
    if (!lot) { notFound(res, 'Lot not found or not active'); return; }
  }

  const [transfer] = await db('material_transfers').insert({
    lot_id: lotId || null,
    from_stage_id: fromStageId,
    to_stage_id: toStageId,
    qty,
    unit,
    requested_by: req.user!.sub,
    notes: notes || null,
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

  // Verify accepting worker is assigned to the destination stage
  const assignment = await db('user_stage_assignments')
    .where({ user_id: req.user!.sub, stage_id: transfer.to_stage_id })
    .first();
  if (!assignment) {
    badRequest(res, 'You are not assigned to the destination stage of this transfer');
    return;
  }

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

  // Verify rejecting worker is assigned to the destination stage
  const assignment = await db('user_stage_assignments')
    .where({ user_id: req.user!.sub, stage_id: transfer.to_stage_id })
    .first();
  if (!assignment) {
    badRequest(res, 'You are not assigned to the destination stage of this transfer');
    return;
  }

  await db('material_transfers').where({ id: req.params.id }).update({
    status: 'rejected',
    accepted_by: req.user!.sub,
    responded_at: new Date(),
    notes: parsed.success ? parsed.data.notes : undefined,
  });

  ok(res, null, 'Transfer rejected');
});

/**
 * DELETE /api/worker/transfers/:id
 * Sender cancels (deletes) their own pending transfer
 */
router.delete('/:id', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const transfer = await db('material_transfers')
    .where({ id: req.params.id, requested_by: req.user!.sub, status: 'pending' })
    .first();

  if (!transfer) { notFound(res, 'Transfer not found or cannot be cancelled'); return; }

  await db('material_transfers').where({ id: req.params.id }).delete();
  ok(res, null, 'Transfer cancelled');
});

export default router;
