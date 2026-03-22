import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ok, created, badRequest, notFound, paginated } from '../../utils/response';
import { getPagination } from '../../utils/pagination';

const router = Router();

/**
 * GET /api/worker/transactions
 * Worker sees their own transactions (last 7 days by default)
 */
router.get('/', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const { page, limit, offset } = getPagination(req);
  const { dateFrom, dateTo } = req.query;

  const from = (dateFrom as string) || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const to = (dateTo as string) || new Date().toISOString().split('T')[0];

  const query = db('stage_transactions as st')
    .join('stages as s', 'st.stage_id', 's.id')
    .join('lots as l', 'st.lot_id', 'l.id')
    .leftJoin('machines as m', 'st.machine_id', 'm.id')
    .where({ 'st.worker_id': req.user!.sub })
    .whereBetween('st.transaction_date', [from, to])
    .select(
      'st.id', 'st.transaction_date', 'st.input_qty', 'st.processed_qty',
      'st.instock_qty', 'st.output_qty', 'st.loss_qty', 'st.notes', 'st.status', 'st.created_at',
      's.name as stage_name',
      'l.lot_number', 'l.crop', 'l.variety', 'l.unit',
      'm.name as machine_name'
    );

  const [{ count }] = await query.clone().count('st.id as count');
  const data = await query.orderBy('st.transaction_date', 'desc').orderBy('st.created_at', 'desc').limit(limit).offset(offset);

  // Daily summary for the period
  const dailySummary = await db('stage_transactions')
    .where({ worker_id: req.user!.sub })
    .whereBetween('transaction_date', [from, to])
    .groupBy('transaction_date')
    .orderBy('transaction_date', 'desc')
    .select(
      'transaction_date',
      db.raw('SUM(input_qty) as total_input'),
      db.raw('SUM(output_qty) as total_output'),
      db.raw('SUM(loss_qty) as total_loss'),
      db.raw('COUNT(id) as count')
    );

  paginated(res, data, Number(count), page, limit);
});

/**
 * GET /api/worker/transactions/today-summary
 * Quick summary for the worker's home screen
 */
router.get('/today-summary', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const today = new Date().toISOString().split('T')[0];
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const [todayStats, weekStats, recentTransactions] = await Promise.all([
    db('stage_transactions')
      .where({ worker_id: req.user!.sub, transaction_date: today })
      .select(
        db.raw('COALESCE(SUM(input_qty), 0) as total_input'),
        db.raw('COALESCE(SUM(output_qty), 0) as total_output'),
        db.raw('COALESCE(SUM(loss_qty), 0) as total_loss'),
        db.raw('COUNT(id) as count')
      )
      .first(),

    db('stage_transactions')
      .where({ worker_id: req.user!.sub })
      .whereBetween('transaction_date', [sevenDaysAgo, today])
      .groupBy('transaction_date')
      .orderBy('transaction_date', 'desc')
      .select(
        'transaction_date',
        db.raw('SUM(input_qty) as total_input'),
        db.raw('SUM(output_qty) as total_output'),
        db.raw('SUM(loss_qty) as total_loss')
      ),

    db('stage_transactions as st')
      .join('lots as l', 'st.lot_id', 'l.id')
      .join('stages as s', 'st.stage_id', 's.id')
      .where({ 'st.worker_id': req.user!.sub })
      .orderBy('st.created_at', 'desc')
      .limit(5)
      .select('st.id', 'st.transaction_date', 'st.input_qty', 'st.output_qty', 'st.loss_qty', 'l.lot_number', 'l.crop', 's.name as stage_name'),
  ]);

  ok(res, { todayStats, weekStats, recentTransactions });
});

/**
 * POST /api/worker/transactions
 * Worker logs work done on a lot
 */
router.post('/', async (req: Request, res: Response) => {
  const schema = z.object({
    lotId: z.string().uuid(),
    stageId: z.string().uuid(),
    machineId: z.string().uuid().optional(),
    transactionDate: z.string().optional(),
    inputQty: z.number().min(0),
    processedQty: z.number().min(0),
    instockQty: z.number().min(0).default(0),
    outputQty: z.number().min(0),
    notes: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const { lotId, stageId, machineId, transactionDate, inputQty, processedQty, instockQty, outputQty, notes } = parsed.data;

  // Validate: output can't exceed processed
  if (outputQty > processedQty) {
    badRequest(res, 'Output quantity cannot exceed processed quantity');
    return;
  }

  const db = req.tenantDb!;

  // Verify lot exists and is active
  const lot = await db('lots').where({ id: lotId, status: 'active' }).first();
  if (!lot) { notFound(res, 'Lot not found or not active'); return; }

  // Verify stage exists
  const stage = await db('stages').where({ id: stageId, is_active: true }).first();
  if (!stage) { notFound(res, 'Stage not found'); return; }

  const [transaction] = await db('stage_transactions').insert({
    lot_id: lotId,
    stage_id: stageId,
    machine_id: machineId,
    worker_id: req.user!.sub,
    transaction_date: transactionDate || new Date().toISOString().split('T')[0],
    input_qty: inputQty,
    processed_qty: processedQty,
    instock_qty: instockQty,
    output_qty: outputQty,
    notes,
  }).returning('*');

  created(res, transaction, 'Transaction logged');
});

/**
 * GET /api/worker/transactions/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const transaction = await db('stage_transactions as st')
    .join('lots as l', 'st.lot_id', 'l.id')
    .join('stages as s', 'st.stage_id', 's.id')
    .leftJoin('machines as m', 'st.machine_id', 'm.id')
    .where({ 'st.id': req.params.id, 'st.worker_id': req.user!.sub })
    .select('st.*', 'l.lot_number', 'l.crop', 'l.variety', 'l.unit', 's.name as stage_name', 'm.name as machine_name')
    .first();

  if (!transaction) { notFound(res, 'Transaction not found'); return; }
  ok(res, transaction);
});

export default router;
