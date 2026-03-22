import { Router, Request, Response } from 'express';
import { ok, notFound } from '../../utils/response';

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

  const lots = await db('lots as l')
    .leftJoin('stages as s', 'l.current_stage_id', 's.id')
    .whereIn('l.current_stage_id', assignments)
    .where({ 'l.status': 'active' })
    .select('l.id', 'l.lot_number', 'l.crop', 'l.variety', 'l.total_qty', 'l.unit', 'l.intake_date', 's.name as stage_name')
    .orderBy('l.intake_date', 'desc');

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

  // Allowed next stages (from current stage)
  const nextStages = await db('stage_connections as sc')
    .join('stages as s', 'sc.to_stage_id', 's.id')
    .where({ 'sc.from_stage_id': lot.current_stage_id, 'sc.is_active': true, 's.is_active': true })
    .select('s.id', 's.name');

  ok(res, { ...lot, nextStages });
});

export default router;
