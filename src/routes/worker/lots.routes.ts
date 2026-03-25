import { Router, Request, Response } from 'express';
import { ok, notFound, badRequest } from '../../utils/response';

const router = Router();

/**
 * GET /api/worker/lots
 * Lots currently at stages assigned to this worker
 */
router.get('/', async (req: Request, res: Response) => {
  const db = req.tenantDb!;

  const assignments = await db('user_stage_assignments')
    .where({ user_id: req.user!.sub })
    .pluck('stage_id');

  if (!assignments.length) { ok(res, []); return; }

  // Subtract pending outgoing transfer qtys so the sender sees effective remaining qty.
  // Lots where everything is pending transfer are hidden (effective qty = 0).
  const lots = await db('lots as l')
    .leftJoin('stages as s', 'l.current_stage_id', 's.id')
    .leftJoin(
      db('material_transfers')
        .where({ status: 'pending' })
        .whereNotNull('lot_id')
        .groupBy('lot_id')
        .select('lot_id', db.raw('SUM(qty) as pending_qty'))
        .as('p'),
      'l.id', 'p.lot_id'
    )
    .whereIn('l.current_stage_id', assignments)
    .where({ 'l.status': 'active' })
    .whereRaw('GREATEST(l.total_qty - COALESCE(p.pending_qty, 0), 0) > 0')
    .select(
      'l.id', 'l.lot_number', 'l.crop', 'l.variety',
      db.raw('GREATEST(l.total_qty - COALESCE(p.pending_qty, 0), 0) as total_qty'),
      'l.unit', 'l.intake_date', 'l.current_stage_id', 's.name as stage_name'
    )
    .orderBy('l.intake_date', 'desc');

  ok(res, lots);
});

/**
 * GET /api/worker/lots/search?q=
 * Search all active lots by lot_number (not restricted to worker's current stage)
 */
router.get('/search', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const q = (req.query.q as string || '').trim();
  if (!q) { ok(res, []); return; }

  const lots = await db('lots as l')
    .leftJoin('stages as s', 'l.current_stage_id', 's.id')
    .where({ 'l.status': 'active' })
    .whereRaw('LOWER(l.lot_number) LIKE LOWER(?)', [`%${q}%`])
    .select('l.id', 'l.lot_number', 'l.crop', 'l.variety', 'l.total_qty', 'l.unit', 's.name as stage_name', 'l.current_stage_id')
    .orderBy('l.lot_number')
    .limit(10);

  ok(res, lots);
});

/**
 * GET /api/worker/lots/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const lot = await db('lots as l')
    .leftJoin('stages as s', 'l.current_stage_id', 's.id')
    .where({ 'l.id': req.params.id, 'l.status': 'active' })
    .select('l.*', 's.name as current_stage_name')
    .first();

  if (!lot) { notFound(res, 'Lot not found'); return; }

  // Verify worker is assigned to the lot's current stage
  const assignments = await db('user_stage_assignments')
    .where({ user_id: req.user!.sub })
    .pluck('stage_id');

  if (lot.current_stage_id && !assignments.includes(lot.current_stage_id)) {
    badRequest(res, 'You do not have access to this lot');
    return;
  }

  // Allowed next stages (from current stage)
  const nextStages = await db('stage_connections as sc')
    .join('stages as s', 'sc.to_stage_id', 's.id')
    .where({ 'sc.from_stage_id': lot.current_stage_id, 'sc.is_active': true, 's.is_active': true })
    .select('s.id', 's.name');

  ok(res, { ...lot, nextStages });
});

export default router;
