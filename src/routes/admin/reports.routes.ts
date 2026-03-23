import { Router, Request, Response } from 'express';
import { ok } from '../../utils/response';

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

/**
 * GET /api/admin/reports/dashboard
 * Key metrics for admin dashboard
 */
router.get('/dashboard', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const today = new Date().toISOString().split('T')[0];
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const [activeLots, totalTransactions, todayStats, weeklyStats, stageStats, pendingTransfers] =
    await Promise.all([
      // Active lots count
      db('lots').where({ status: 'active' }).count('id as count').first(),

      // Total transactions today
      db('stage_transactions').where('transaction_date', today).count('id as count').first(),

      // Today's totals
      db('stage_transactions')
        .where('transaction_date', today)
        .select(
          db.raw('COALESCE(SUM(input_qty), 0) as total_input'),
          db.raw('COALESCE(SUM(output_qty), 0) as total_output'),
          db.raw('COALESCE(SUM(loss_qty), 0) as total_loss'),
          db.raw('COALESCE(SUM(processed_qty), 0) as total_processed')
        )
        .first(),

      // Last 7 days daily summary
      db('stage_transactions')
        .where('transaction_date', '>=', sevenDaysAgo)
        .groupBy('transaction_date')
        .orderBy('transaction_date')
        .select(
          'transaction_date',
          db.raw('SUM(input_qty) as input_qty'),
          db.raw('SUM(output_qty) as output_qty'),
          db.raw('SUM(loss_qty) as loss_qty'),
          db.raw('COUNT(id) as transaction_count')
        ),

      // Per-stage stats today
      db('stage_transactions as st')
        .join('stages as s', 'st.stage_id', 's.id')
        .where('st.transaction_date', today)
        .groupBy('s.id', 's.name')
        .select(
          's.id as stage_id',
          's.name as stage_name',
          db.raw('SUM(st.input_qty) as input_qty'),
          db.raw('SUM(st.processed_qty) as processed_qty'),
          db.raw('SUM(st.output_qty) as output_qty'),
          db.raw('SUM(st.loss_qty) as loss_qty'),
          db.raw('COUNT(st.id) as transaction_count')
        ),

      // Pending material transfer requests
      db('material_transfers').where({ status: 'pending' }).count('id as count').first(),
    ]);

  ok(res, {
    activeLots: Number(activeLots?.count),
    todayTransactions: Number(totalTransactions?.count),
    pendingTransfers: Number(pendingTransfers?.count),
    todayStats,
    weeklyStats,
    stageStats,
  });
});

/**
 * GET /api/admin/reports/efficiency
 * Worker/machine efficiency report
 */
router.get('/efficiency', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const { dateFrom, dateTo, stageId } = req.query;

  const from = (dateFrom as string) || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const to = (dateTo as string) || new Date().toISOString().split('T')[0];

  let workerQuery = db('stage_transactions as st')
    .join('users as u', 'st.worker_id', 'u.id')
    .join('stages as s', 'st.stage_id', 's.id')
    .whereBetween('st.transaction_date', [from, to])
    .groupBy('u.id', 'u.name', 's.id', 's.name')
    .select(
      'u.id as worker_id',
      'u.name as worker_name',
      's.id as stage_id',
      's.name as stage_name',
      db.raw('SUM(st.input_qty) as total_input'),
      db.raw('SUM(st.output_qty) as total_output'),
      db.raw('SUM(st.loss_qty) as total_loss'),
      db.raw('SUM(st.processed_qty) as total_processed'),
      db.raw('COUNT(st.id) as transaction_count'),
      db.raw('ROUND(SUM(st.output_qty) / NULLIF(SUM(st.processed_qty), 0) * 100, 2) as efficiency_pct')
    );

  let machineQuery = db('stage_transactions as st')
    .join('machines as m', 'st.machine_id', 'm.id')
    .join('stages as s', 'st.stage_id', 's.id')
    .whereBetween('st.transaction_date', [from, to])
    .whereNotNull('st.machine_id')
    .groupBy('m.id', 'm.name', 's.id', 's.name')
    .select(
      'm.id as machine_id',
      'm.name as machine_name',
      's.id as stage_id',
      's.name as stage_name',
      db.raw('SUM(st.input_qty) as total_input'),
      db.raw('SUM(st.output_qty) as total_output'),
      db.raw('SUM(st.loss_qty) as total_loss'),
      db.raw('ROUND(SUM(st.output_qty) / NULLIF(SUM(st.processed_qty), 0) * 100, 2) as efficiency_pct')
    );

  if (stageId) {
    workerQuery = workerQuery.where({ 'st.stage_id': stageId });
    machineQuery = machineQuery.where({ 'st.stage_id': stageId });
  }

  const [workerEfficiency, machineEfficiency] = await Promise.all([workerQuery, machineQuery]);

  ok(res, { dateFrom: from, dateTo: to, workerEfficiency, machineEfficiency });
});

/**
 * GET /api/admin/reports/material-flow
 * Material flow report per lot
 */
router.get('/material-flow', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const { lotId, stageId, dateFrom, dateTo } = req.query;

  const from = (dateFrom as string) || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const to = (dateTo as string) || new Date().toISOString().split('T')[0];

  let query = db('stage_transactions as st')
    .join('stages as s', 'st.stage_id', 's.id')
    .leftJoin('lots as l', 'st.lot_id', 'l.id')
    .leftJoin('users as u', 'st.worker_id', 'u.id')
    .whereBetween('st.transaction_date', [from, to])
    .select(
      'st.id', 'st.transaction_date', 'st.unit', 'st.input_qty', 'st.processed_qty',
      'st.instock_qty', 'st.output_qty', 'st.loss_qty', 'st.notes',
      's.name as stage_name',
      'l.lot_number', 'l.crop', 'l.variety',
      'u.name as worker_name'
    )
    .orderBy('st.transaction_date', 'desc');

  if (lotId) query = query.where({ 'st.lot_id': lotId });
  if (stageId) query = query.where({ 'st.stage_id': stageId });

  const data = await query.limit(500);
  ok(res, data);
});

/**
 * GET /api/admin/reports/worker-history/:userId
 * Full transaction history for a specific worker
 */
router.get('/worker-history/:userId', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const { dateFrom, dateTo } = req.query;
  const from = (dateFrom as string) || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const to = (dateTo as string) || new Date().toISOString().split('T')[0];

  const transactions = await db('stage_transactions as st')
    .join('stages as s', 'st.stage_id', 's.id')
    .leftJoin('lots as l', 'st.lot_id', 'l.id')
    .leftJoin('machines as m', 'st.machine_id', 'm.id')
    .where({ 'st.worker_id': req.params.userId })
    .whereBetween('st.transaction_date', [from, to])
    .select(
      'st.id', 'st.transaction_date', 'st.unit', 'st.input_qty', 'st.processed_qty',
      'st.instock_qty', 'st.output_qty', 'st.loss_qty', 'st.notes',
      's.name as stage_name',
      'l.lot_number', 'l.crop',
      'm.name as machine_name'
    )
    .orderBy('st.transaction_date', 'desc');

  const worker = await db('users').where({ id: req.params.userId }).select('name', 'role').first();
  ok(res, { worker, transactions, dateFrom: from, dateTo: to });
});

/**
 * GET /api/admin/reports/export?dateFrom=&dateTo=&stageId=&workerId=
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
      's.name as stage_name', 'l.lot_number', 'l.crop', 'l.variety',
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
    { key: 'variety', label: 'Variety' },
    { key: 'machine_name', label: 'Machine' },
    { key: 'unit', label: 'Unit' },
    { key: 'input_qty', label: 'Input Qty' },
    { key: 'processed_qty', label: 'Processed Qty' },
    { key: 'instock_qty', label: 'In-Stock Qty' },
    { key: 'output_qty', label: 'Output Qty' },
    { key: 'loss_qty', label: 'Loss Qty' },
    { key: 'notes', label: 'Notes' },
  ]);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=transactions_${from}_to_${to}.csv`);
  res.send(csv);
});

export default router;
