import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { hashPassword, generateTempPassword } from '../../utils/password';
import { ok, created, badRequest, notFound, paginated } from '../../utils/response';
import { getPagination } from '../../utils/pagination';

const router = Router();

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  password: z.string().min(6).optional(),
  role: z.enum(['manager', 'lead', 'worker']),
  stageIds: z.array(z.string().uuid()).optional(),
});

/**
 * GET /api/admin/users
 */
router.get('/', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const { page, limit, offset } = getPagination(req);
  const { role, search } = req.query;

  let query = db('users').select('id', 'name', 'email', 'phone', 'role', 'is_active', 'created_at');
  if (role) query = query.where({ role });
  if (search) query = query.where('name', 'ilike', `%${search}%`);

  const [{ count }] = await query.clone().clearSelect().count('id as count');
  const data = await query.orderBy('created_at', 'desc').limit(limit).offset(offset);

  paginated(res, data, Number(count), page, limit);
});

/**
 * GET /api/admin/users/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const user = await db('users')
    .select('id', 'name', 'email', 'phone', 'role', 'is_active', 'created_at')
    .where({ id: req.params.id })
    .first();

  if (!user) { notFound(res, 'User not found'); return; }

  const stages = await db('user_stage_assignments as usa')
    .join('stages as s', 'usa.stage_id', 's.id')
    .where({ 'usa.user_id': user.id })
    .select('s.id', 's.name', 's.stage_order');

  ok(res, { ...user, stages });
});

/**
 * POST /api/admin/users
 */
router.post('/', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const { name, email, phone, password, role, stageIds } = parsed.data;

  if (!email && !phone) { badRequest(res, 'Either email or phone is required'); return; }

  if (email) {
    const exists = await db('users').where({ email }).first();
    if (exists) { badRequest(res, 'Email already in use'); return; }
  }
  if (phone) {
    const exists = await db('users').where({ phone }).first();
    if (exists) { badRequest(res, 'Phone already in use'); return; }
  }

  const tempPassword = password || generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  const trx = await db.transaction();
  try {
    const [user] = await trx('users').insert({
      name, email, phone, password_hash: passwordHash, role, created_by: req.user!.sub,
    }).returning('id', 'name', 'email', 'phone', 'role', 'is_active', 'created_at');

    if (stageIds?.length) {
      await trx('user_stage_assignments').insert(
        stageIds.map((stageId) => ({ user_id: user.id, stage_id: stageId }))
      );
    }
    await trx.commit();
    created(res, { ...user, tempPassword: password ? undefined : tempPassword });
  } catch (err) {
    await trx.rollback();
    throw err;
  }
});

/**
 * PUT /api/admin/users/:id
 */
router.put('/:id', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const schema = z.object({
    name: z.string().min(2).optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    role: z.enum(['manager', 'lead', 'worker']).optional(),
    isActive: z.boolean().optional(),
    stageIds: z.array(z.string().uuid()).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const user = await db('users').where({ id: req.params.id }).first();
  if (!user) { notFound(res, 'User not found'); return; }

  const { stageIds, isActive, ...fields } = parsed.data;
  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (fields.name) updates.name = fields.name;
  if (fields.email) updates.email = fields.email;
  if (fields.phone) updates.phone = fields.phone;
  if (fields.role) updates.role = fields.role;
  if (isActive !== undefined) updates.is_active = isActive;

  const trx = await db.transaction();
  try {
    const [updated] = await trx('users').where({ id: req.params.id }).update(updates).returning('id', 'name', 'email', 'phone', 'role', 'is_active');

    if (stageIds !== undefined) {
      await trx('user_stage_assignments').where({ user_id: req.params.id }).delete();
      if (stageIds.length) {
        await trx('user_stage_assignments').insert(
          stageIds.map((stageId) => ({ user_id: req.params.id, stage_id: stageId }))
        );
      }
    }
    await trx.commit();
    ok(res, updated, 'User updated');
  } catch (err) {
    await trx.rollback();
    throw err;
  }
});

/**
 * PUT /api/admin/users/:id/password
 * Admin resets a user's password
 */
router.put('/:id/password', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const schema = z.object({ newPassword: z.string().min(6) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Password must be at least 6 characters'); return; }

  const user = await db('users').where({ id: req.params.id }).first();
  if (!user) { notFound(res, 'User not found'); return; }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  await db('users').where({ id: req.params.id }).update({ password_hash: passwordHash, updated_at: new Date() });

  ok(res, null, 'Password updated');
});

export default router;
