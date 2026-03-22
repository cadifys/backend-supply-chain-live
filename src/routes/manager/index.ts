import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireMinRole } from '../../middleware/rbac';
import { injectTenantDb } from '../../middleware/tenant';
import { ok } from '../../utils/response';
import { getPagination } from '../../utils/pagination';

const router = Router();

router.use(authenticate, requireMinRole('manager'), injectTenantDb);

/**
 * GET /api/manager/overview
 * Manager dashboard: all stage data they have access to
 */
router.get('/overview', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const today = new Date().toISOString().split('T')[0];
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const [stageOverview, pendingTransfers, weeklyByStage] = await Promise.all([
    // Per stage activity today
    db('stage_transactions as st')
      .join('stages as s', 'st.stage_id', 's.id')
      .where('st.transaction_date', today)
      .groupBy('s.id', 's.name', 's.stage_order')
      .orderBy('s.stage_order')
      .select(
        's.id', 's.name', 's.stage_order',
        db.raw('SUM(st.input_qty) as input_qty'),
        db.raw('SUM(st.output_qty) as output_qty'),
        db.raw('SUM(st.loss_qty) as loss_qty'),
        db.raw('COUNT(DISTINCT st.worker_id) as active_workers'),
        db.raw('COUNT(st.id) as transaction_count')
      ),

    // Pending transfers
    db('material_transfers as mt')
      .join('stages as ts', 'mt.to_stage_id', 'ts.id')
      .join('stages as fs', 'mt.from_stage_id', 'fs.id')
      .join('lots as l', 'mt.lot_id', 'l.id')
      .where({ 'mt.status': 'pending' })
      .select(
        'mt.id', 'mt.qty', 'mt.unit', 'mt.requested_at',
        'l.lot_number', 'l.crop',
        'fs.name as from_stage', 'ts.name as to_stage'
      )
      .limit(20),

    // Last 7 days by stage
    db('stage_transactions as st')
      .join('stages as s', 'st.stage_id', 's.id')
      .whereBetween('st.transaction_date', [sevenDaysAgo, today])
      .groupBy('st.transaction_date', 's.id', 's.name')
      .orderBy('st.transaction_date')
      .select(
        'st.transaction_date',
        's.id as stage_id', 's.name as stage_name',
        db.raw('SUM(st.input_qty) as input_qty'),
        db.raw('SUM(st.output_qty) as output_qty'),
        db.raw('SUM(st.loss_qty) as loss_qty')
      ),
  ]);

  ok(res, { stageOverview, pendingTransfers, weeklyByStage });
});

/**
 * GET /api/manager/workers
 * Workers and their today's stats
 */
router.get('/workers', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const { page, limit, offset } = getPagination(req);
  const today = new Date().toISOString().split('T')[0];

  const workers = await db('users as u')
    .where({ 'u.role': 'worker', 'u.is_active': true })
    .orWhere({ 'u.role': 'lead', 'u.is_active': true })
    .select('u.id', 'u.name', 'u.email', 'u.phone', 'u.role')
    .limit(limit)
    .offset(offset);

  // For each worker, get today's stats
  const workerIds = workers.map((w: any) => w.id);
  const todayStats = await db('stage_transactions')
    .whereIn('worker_id', workerIds)
    .where({ transaction_date: today })
    .groupBy('worker_id')
    .select(
      'worker_id',
      db.raw('SUM(input_qty) as input_qty'),
      db.raw('SUM(output_qty) as output_qty'),
      db.raw('SUM(loss_qty) as loss_qty'),
      db.raw('COUNT(id) as count')
    );

  const statsMap = todayStats.reduce((acc: any, s: any) => {
    acc[s.worker_id] = s;
    return acc;
  }, {});

  const result = workers.map((w: any) => ({
    ...w,
    todayStats: statsMap[w.id] || { input_qty: 0, output_qty: 0, loss_qty: 0, count: 0 },
  }));

  ok(res, result);
});

/**
 * GET /api/manager/transactions
 * All transactions with filters
 */
router.get('/transactions', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const { page, limit, offset } = getPagination(req);
  const { stageId, workerId, dateFrom, dateTo } = req.query;

  const from = (dateFrom as string) || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const to = (dateTo as string) || new Date().toISOString().split('T')[0];

  let query = db('stage_transactions as st')
    .join('stages as s', 'st.stage_id', 's.id')
    .join('lots as l', 'st.lot_id', 'l.id')
    .join('users as u', 'st.worker_id', 'u.id')
    .leftJoin('machines as m', 'st.machine_id', 'm.id')
    .whereBetween('st.transaction_date', [from, to])
    .select(
      'st.*',
      's.name as stage_name', 'l.lot_number', 'l.crop', 'l.variety',
      'u.name as worker_name', 'm.name as machine_name'
    );

  if (stageId) query = query.where({ 'st.stage_id': stageId });
  if (workerId) query = query.where({ 'st.worker_id': workerId });

  const [{ count }] = await query.clone().count('st.id as count');
  const data = await query.orderBy('st.transaction_date', 'desc').limit(limit).offset(offset);

  ok(res, { data, total: Number(count), page, limit });
});

export default router;
