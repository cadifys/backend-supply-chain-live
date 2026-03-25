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
    .leftJoin('lots as l', 'st.lot_id', 'l.id')
    .leftJoin('machines as m', 'st.machine_id', 'm.id')
    .where({ 'st.worker_id': req.user!.sub })
    .whereBetween('st.transaction_date', [from, to])
    .select(
      'st.id', 'st.transaction_date', 'st.unit', 'st.input_qty', 'st.processed_qty',
      'st.instock_qty', 'st.output_qty', 'st.loss_qty', 'st.notes', 'st.status', 'st.created_at',
      's.name as stage_name',
      'l.lot_number', 'l.crop', 'l.variety',
      'm.name as machine_name'
    );

  const [{ count }] = await query.clone().clearSelect().count('st.id as count');
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
      .leftJoin('lots as l', 'st.lot_id', 'l.id')
      .join('stages as s', 'st.stage_id', 's.id')
      .where({ 'st.worker_id': req.user!.sub })
      .orderBy('st.created_at', 'desc')
      .limit(5)
      .select('st.id', 'st.transaction_date', 'st.unit', 'st.input_qty', 'st.output_qty', 'st.loss_qty', 'l.lot_number', 'l.crop', 's.name as stage_name'),
  ]);

  ok(res, { todayStats, weekStats, recentTransactions });
});

/**
 * POST /api/worker/transactions
 * Worker logs work done on a lot
 */
router.post('/', async (req: Request, res: Response) => {
  const schema = z.object({
    lotId: z.string().uuid().optional(),          // Lot is optional
    stageId: z.string().uuid(),
    machineId: z.string().uuid().optional(),
    unit: z.string().min(1).default('kg'),        // Flexible unit
    transactionDate: z.string().optional(),
    inputQty: z.number().min(0),
    processedQty: z.number().min(0),
    outputQty: z.number().min(0),
    notes: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const { lotId, stageId, machineId, unit, transactionDate, inputQty, processedQty, outputQty, notes } = parsed.data;

  // Processed cannot exceed what was received (input)
  if (processedQty > inputQty + 0.0001) {
    badRequest(res, 'Processed quantity cannot exceed Input quantity');
    return;
  }
  // Output cannot exceed what was processed
  if (outputQty > processedQty + 0.0001) {
    badRequest(res, 'Output quantity cannot exceed Processed quantity');
    return;
  }

  // Auto-calculate in-stock: material received but not yet processed
  const instockQty = Math.max(0, inputQty - processedQty);

  const db = req.tenantDb!;

  // Worker must be assigned to this stage
  const assignment = await db('user_stage_assignments')
    .where({ user_id: req.user!.sub, stage_id: stageId })
    .first();
  if (!assignment) {
    badRequest(res, 'You are not assigned to this stage');
    return;
  }

  // Stage must exist and be active
  const stage = await db('stages').where({ id: stageId, is_active: true }).first();
  if (!stage) { notFound(res, 'Stage not found or inactive'); return; }

  // If lot provided: validate it and check it's at this stage
  if (lotId) {
    const lot = await db('lots').where({ id: lotId, status: 'active' }).first();
    if (!lot) { notFound(res, 'Lot not found or not active'); return; }
    if (lot.current_stage_id && lot.current_stage_id !== stageId) {
      badRequest(res, 'This lot is not currently at your stage');
      return;
    }
  }

  // Machine must belong to this stage if provided
  if (machineId) {
    const machine = await db('machines').where({ id: machineId, stage_id: stageId, is_active: true }).first();
    if (!machine) {
      badRequest(res, 'Machine not found or not assigned to this stage');
      return;
    }
  }

  const [transaction] = await db('stage_transactions').insert({
    lot_id: lotId || null,
    stage_id: stageId,
    machine_id: machineId || null,
    worker_id: req.user!.sub,
    unit,
    transaction_date: transactionDate || new Date().toISOString().split('T')[0],
    input_qty: inputQty,
    processed_qty: processedQty,
    instock_qty: instockQty,
    output_qty: outputQty,
    notes: notes || null,
  }).returning('*');

  created(res, transaction, 'Transaction logged');
});

/**
 * GET /api/worker/transactions/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const transaction = await db('stage_transactions as st')
    .leftJoin('lots as l', 'st.lot_id', 'l.id')
    .join('stages as s', 'st.stage_id', 's.id')
    .leftJoin('machines as m', 'st.machine_id', 'm.id')
    .where({ 'st.id': req.params.id, 'st.worker_id': req.user!.sub })
    .select('st.*', 'l.lot_number', 'l.crop', 'l.variety', 's.name as stage_name', 'm.name as machine_name')
    .first();

  if (!transaction) { notFound(res, 'Transaction not found'); return; }
  ok(res, transaction);
});

/**
 * PUT /api/worker/transactions/:id
 * Worker edits their own transaction — today's entries only
 */
router.put('/:id', async (req: Request, res: Response) => {
  const schema = z.object({
    inputQty:     z.number().min(0).optional(),
    processedQty: z.number().min(0).optional(),
    outputQty:    z.number().min(0).optional(),
    unit:         z.string().optional(),
    notes:        z.string().nullable().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const db = req.tenantDb!;
  const today = new Date().toISOString().split('T')[0];

  const tx = await db('stage_transactions')
    .where({ id: req.params.id, worker_id: req.user!.sub })
    .whereRaw(`transaction_date::date = ?`, [today])
    .first();

  if (!tx) { notFound(res, 'Transaction not found or only today\'s entries can be edited'); return; }

  const d = parsed.data;
  const finalInput = d.inputQty     !== undefined ? d.inputQty     : Number(tx.input_qty);
  const finalProc  = d.processedQty !== undefined ? d.processedQty : Number(tx.processed_qty);
  const finalOut   = d.outputQty    !== undefined ? d.outputQty    : Number(tx.output_qty);

  if (finalProc > finalInput + 0.0001) {
    badRequest(res, 'Processed cannot exceed Input');
    return;
  }
  if (finalOut > finalProc + 0.0001) {
    badRequest(res, 'Output cannot exceed Processed');
    return;
  }

  // Recalculate in-stock: input - processed
  const instockQty = Math.max(0, finalInput - finalProc);

  const updates: Record<string, any> = { updated_at: new Date(), instock_qty: instockQty };
  if (d.inputQty     !== undefined) updates.input_qty     = d.inputQty;
  if (d.processedQty !== undefined) updates.processed_qty = d.processedQty;
  if (d.outputQty    !== undefined) updates.output_qty    = d.outputQty;
  if (d.unit         !== undefined) updates.unit          = d.unit;
  if (d.notes        !== undefined) updates.notes         = d.notes;

  const [updated] = await db('stage_transactions')
    .where({ id: req.params.id })
    .update(updates)
    .returning('*');

  ok(res, updated, 'Transaction updated');
});

export default router;
