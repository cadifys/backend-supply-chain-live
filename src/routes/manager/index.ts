import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireMinRole } from '../../middleware/rbac';
import { injectTenantDb } from '../../middleware/tenant';
import { ok } from '../../utils/response';
import { getPagination } from '../../utils/pagination';

function toCSV(rows: any[], columns: { key: string; label: string }[]): string {
  const header = columns.map(c => `"${c.label}"`).join(',');
  const lines = rows.map(row =>
    columns.map(c => {
      const val = row[c.key] ?? '';
      return `"${String(val).replace(/"/g, '""')}"`;
    }).join(',')
  );
  return [header, ...lines].join('\r\n');
}

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
    .whereIn('u.role', ['worker', 'lead'])
    .where({ 'u.is_active': true })
    .select('u.id', 'u.name', 'u.email', 'u.phone', 'u.role')
    .orderBy('u.name')
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
    .leftJoin('lots as l', 'st.lot_id', 'l.id')
    .join('users as u', 'st.worker_id', 'u.id')
    .leftJoin('machines as m', 'st.machine_id', 'm.id')
    .whereBetween('st.transaction_date', [from, to])
    .select(
      'st.id', 'st.transaction_date', 'st.unit', 'st.input_qty', 'st.processed_qty',
      'st.instock_qty', 'st.output_qty', 'st.loss_qty', 'st.notes',
      's.name as stage_name', 'l.lot_number', 'l.crop', 'l.variety',
      'u.name as worker_name', 'm.name as machine_name'
    );

  if (stageId) query = query.where({ 'st.stage_id': stageId });
  if (workerId) query = query.where({ 'st.worker_id': workerId });

  const [{ count }] = await query.clone().clearSelect().count('st.id as count');
  const data = await query.orderBy('st.transaction_date', 'desc').limit(limit).offset(offset);

  ok(res, { data, total: Number(count), page, limit });
});

/**
 * GET /api/manager/stages
 * Read-only stage list for manager (for filters)
 */
router.get('/stages', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const stages = await db('stages').where({ is_active: true }).orderBy('stage_order');
  ok(res, stages);
});

/**
 * GET /api/manager/workers/:id/history
 * Full history of a specific worker for manager view
 */
router.get('/workers/:id/history', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const { dateFrom, dateTo } = req.query;
  const from = (dateFrom as string) || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const to = (dateTo as string) || new Date().toISOString().split('T')[0];

  const worker = await db('users').where({ id: req.params.id }).select('id', 'name', 'role', 'email', 'phone').first();
  if (!worker) { ok(res, null); return; }

  const transactions = await db('stage_transactions as st')
    .join('stages as s', 'st.stage_id', 's.id')
    .leftJoin('lots as l', 'st.lot_id', 'l.id')
    .leftJoin('machines as m', 'st.machine_id', 'm.id')
    .where({ 'st.worker_id': req.params.id })
    .whereBetween('st.transaction_date', [from, to])
    .select(
      'st.id', 'st.transaction_date', 'st.unit', 'st.input_qty', 'st.processed_qty',
      'st.instock_qty', 'st.output_qty', 'st.loss_qty', 'st.notes',
      's.name as stage_name', 'l.lot_number', 'l.crop', 'm.name as machine_name'
    )
    .orderBy('st.transaction_date', 'desc');

  const summary = await db('stage_transactions')
    .where({ worker_id: req.params.id })
    .whereBetween('transaction_date', [from, to])
    .select(
      db.raw('SUM(input_qty) as total_input'),
      db.raw('SUM(processed_qty) as total_processed'),
      db.raw('SUM(output_qty) as total_output'),
      db.raw('SUM(loss_qty) as total_loss'),
      db.raw('COUNT(id) as transaction_count'),
      db.raw('COUNT(DISTINCT stage_id) as stages_worked')
    )
    .first();

  ok(res, { worker, summary, transactions, dateFrom: from, dateTo: to });
});

/**
 * GET /api/manager/export?dateFrom=&dateTo=&stageId=&workerId=
 * Export transactions as CSV
 */
router.get('/export', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const { dateFrom, dateTo, stageId, workerId } = req.query;
  const from = (dateFrom as string) || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const to = (dateTo as string) || new Date().toISOString().split('T')[0];

  let query = db('stage_transactions as st')
    .join('stages as s', 'st.stage_id', 's.id')
    .join('users as u', 'st.worker_id', 'u.id')
    .leftJoin('lots as l', 'st.lot_id', 'l.id')
    .leftJoin('machines as m', 'st.machine_id', 'm.id')
    .whereBetween('st.transaction_date', [from, to])
    .select(
      'st.transaction_date', 'u.name as worker_name', 'u.role as worker_role',
      's.name as stage_name', 'l.lot_number', 'l.crop',
      'm.name as machine_name', 'st.unit',
      'st.input_qty', 'st.processed_qty', 'st.instock_qty', 'st.output_qty', 'st.loss_qty',
      'st.notes'
    )
    .orderBy('st.transaction_date', 'desc');

  if (stageId) query = query.where({ 'st.stage_id': stageId });
  if (workerId) query = query.where({ 'st.worker_id': workerId });

  const rows = await query.limit(10000);
  const csv = toCSV(rows, [
    { key: 'transaction_date', label: 'Date' },
    { key: 'worker_name', label: 'Worker' },
    { key: 'worker_role', label: 'Role' },
    { key: 'stage_name', label: 'Stage' },
    { key: 'lot_number', label: 'Lot #' },
    { key: 'crop', label: 'Crop' },
    { key: 'machine_name', label: 'Machine' },
    { key: 'unit', label: 'Unit' },
    { key: 'input_qty', label: 'Input' },
    { key: 'processed_qty', label: 'Processed' },
    { key: 'instock_qty', label: 'In-Stock' },
    { key: 'output_qty', label: 'Output' },
    { key: 'loss_qty', label: 'Loss' },
    { key: 'notes', label: 'Notes' },
  ]);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=transactions_${from}_to_${to}.csv`);
  res.send(csv);
});

export default router;
