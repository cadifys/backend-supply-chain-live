import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ok, created, badRequest, notFound, paginated } from '../../utils/response';
import { getPagination } from '../../utils/pagination';

const router = Router();

/**
 * GET /api/admin/lots  (also accessible to manager)
 */
router.get('/', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const { page, limit, offset } = getPagination(req);
  const { status, search } = req.query;

  let query = db('lots as l')
    .leftJoin('stages as s', 'l.current_stage_id', 's.id')
    .leftJoin('users as u', 'l.created_by', 'u.id')
    .select('l.*', 's.name as current_stage_name', 'u.name as created_by_name');

  if (status) query = query.where({ 'l.status': status });
  if (search) {
    query = query.where((b) => {
      b.where('l.lot_number', 'ilike', `%${search}%`)
        .orWhere('l.crop', 'ilike', `%${search}%`)
        .orWhere('l.variety', 'ilike', `%${search}%`);
    });
  }

  const [{ count }] = await query.clone().clearSelect().count('l.id as count');
  const data = await query.orderBy('l.created_at', 'desc').limit(limit).offset(offset);
  paginated(res, data, Number(count), page, limit);
});

/**
 * GET /api/admin/lots/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const lot = await db('lots as l')
    .leftJoin('stages as s', 'l.current_stage_id', 's.id')
    .select('l.*', 's.name as current_stage_name')
    .where({ 'l.id': req.params.id })
    .first();

  if (!lot) { notFound(res, 'Lot not found'); return; }

  // Get transaction history
  const transactions = await db('stage_transactions as st')
    .join('stages as s', 'st.stage_id', 's.id')
    .leftJoin('users as u', 'st.worker_id', 'u.id')
    .leftJoin('machines as m', 'st.machine_id', 'm.id')
    .where({ 'st.lot_id': lot.id })
    .select(
      'st.id', 'st.transaction_date', 'st.unit', 'st.input_qty', 'st.processed_qty',
      'st.instock_qty', 'st.output_qty', 'st.loss_qty', 'st.notes', 'st.status',
      's.name as stage_name',
      'u.name as worker_name',
      'm.name as machine_name'
    )
    .orderBy('st.transaction_date', 'desc');

  ok(res, { ...lot, transactions });
});

/**
 * POST /api/admin/lots
 * Receive raw material (intake)
 */
router.post('/', async (req: Request, res: Response) => {
  const schema = z.object({
    lotNumber: z.string().min(1),
    crop: z.string().optional(),
    variety: z.string().optional(),
    totalQty: z.number().positive(),
    unit: z.string().default('kg'),
    currentStageId: z.string().uuid().optional(),
    supplierName: z.string().optional(),
    intakeDate: z.string().optional(),
    notes: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const db = req.tenantDb!;

  const exists = await db('lots').where({ lot_number: parsed.data.lotNumber }).first();
  if (exists) { badRequest(res, 'Lot number already exists'); return; }

  // Validate currentStageId if provided
  if (parsed.data.currentStageId) {
    const stage = await db('stages').where({ id: parsed.data.currentStageId, is_active: true }).first();
    if (!stage) { badRequest(res, 'Starting stage not found or inactive'); return; }
  }

  const [lot] = await db('lots').insert({
    lot_number: parsed.data.lotNumber,
    crop: parsed.data.crop,
    variety: parsed.data.variety,
    total_qty: parsed.data.totalQty,
    unit: parsed.data.unit,
    current_stage_id: parsed.data.currentStageId,
    supplier_name: parsed.data.supplierName,
    intake_date: parsed.data.intakeDate || new Date().toISOString().split('T')[0],
    notes: parsed.data.notes,
    created_by: req.user!.role === 'admin' ? null : req.user!.sub,
  }).returning('*');

  created(res, lot, 'Lot created');
});

/**
 * PUT /api/admin/lots/:id
 */
router.put('/:id', async (req: Request, res: Response) => {
  const schema = z.object({
    status: z.enum(['active', 'completed', 'cancelled']).optional(),
    currentStageId: z.string().uuid().nullable().optional(),
    notes: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const db = req.tenantDb!;
  const lot = await db('lots').where({ id: req.params.id }).first();
  if (!lot) { notFound(res, 'Lot not found'); return; }

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.status) updates.status = parsed.data.status;
  if (parsed.data.currentStageId !== undefined) updates.current_stage_id = parsed.data.currentStageId;
  if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;

  const [updated] = await db('lots').where({ id: req.params.id }).update(updates).returning('*');
  ok(res, updated);
});

export default router;
