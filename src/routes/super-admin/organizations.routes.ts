import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { centralDb } from '../../db/central';
import { bootstrapTenantSchema } from '../../db/tenant';
import { hashPassword, generateTempPassword } from '../../utils/password';
import { ok, created, badRequest, notFound, paginated } from '../../utils/response';
import { getPagination } from '../../utils/pagination';

const router = Router();

const createOrgSchema = z.object({
  name: z.string().min(2).max(255),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9_]+$/, 'Slug must be lowercase letters, numbers, underscores'),
  industry: z.string().optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().optional(),
  address: z.string().optional(),
  adminName: z.string().min(2),
  adminEmail: z.string().email(),
  adminPhone: z.string().optional(),
  adminPassword: z.string().min(8).optional(),
});

/**
 * GET /api/super-admin/organizations
 */
router.get('/', async (req: Request, res: Response) => {
  const { page, limit, offset } = getPagination(req);
  const search = req.query.search as string | undefined;

  let query = centralDb('central.organizations as o')
    .leftJoin(
      centralDb('central.org_admins').select('org_id').count('id as count').groupBy('org_id').as('ac'),
      'ac.org_id', 'o.id'
    )
    .select('o.*', centralDb.raw('COALESCE(ac.count, 0) as admin_count'));

  if (search) {
    query = query.where('o.name', 'ilike', `%${search}%`);
  }

  const [{ count }] = await query.clone().clearSelect().count('o.id as count');
  const data = await query.orderBy('o.created_at', 'desc').limit(limit).offset(offset);

  paginated(res, data, Number(count), page, limit);
});

/**
 * GET /api/super-admin/organizations/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  const org = await centralDb('central.organizations').where({ id: req.params.id }).first();
  if (!org) { notFound(res, 'Organization not found'); return; }

  const admins = await centralDb('central.org_admins')
    .where({ org_id: org.id })
    .select('id', 'name', 'email', 'phone', 'is_active', 'created_at');

  ok(res, { ...org, admins });
});

/**
 * POST /api/super-admin/organizations
 * Creates org + sets up its DB schema + creates first admin
 */
router.post('/', async (req: Request, res: Response) => {
  const parsed = createOrgSchema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const { name, slug, industry, contactEmail, contactPhone, address, adminName, adminEmail, adminPhone, adminPassword } = parsed.data;

  // Check slug uniqueness
  const existing = await centralDb('central.organizations').where({ slug }).first();
  if (existing) { badRequest(res, 'Organization slug already exists'); return; }

  // Check admin email uniqueness
  const adminExists = await centralDb('central.org_admins').where({ email: adminEmail }).first();
  if (adminExists) { badRequest(res, 'Admin email already in use'); return; }

  const tempPassword = adminPassword || generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  const orgSchema = `org_${slug}`;

  // Transaction: create org + admin in central DB
  const trx = await centralDb.transaction();
  let org: any;
  let admin: any;

  try {
    [org] = await trx('central.organizations').insert({
      name,
      slug,
      industry,
      contact_email: contactEmail,
      contact_phone: contactPhone,
      address,
      created_by: req.user!.sub,
    }).returning('*');

    [admin] = await trx('central.org_admins').insert({
      org_id: org.id,
      name: adminName,
      email: adminEmail,
      phone: adminPhone,
      password_hash: passwordHash,
      created_by: req.user!.sub,
    }).returning('id', 'name', 'email', 'phone', 'is_active', 'created_at');

    await trx.commit();
  } catch (err) {
    await trx.rollback();
    throw err;
  }

  // Bootstrap tenant schema (outside transaction - schema creation is DDL)
  await bootstrapTenantSchema(`org_${slug}`);

  created(res, {
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      industry: org.industry,
      contactEmail: org.contact_email,
      contactPhone: org.contact_phone,
      address: org.address,
      isActive: org.is_active,
      orgSchema,
      createdAt: org.created_at,
    },
    admin: {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      phone: admin.phone,
    },
    tempPassword: adminPassword ? undefined : tempPassword,
  }, 'Organization created successfully');
});

/**
 * PUT /api/super-admin/organizations/:id
 */
router.put('/:id', async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(2).optional(),
    industry: z.string().optional(),
    contactEmail: z.string().email().optional(),
    contactPhone: z.string().optional(),
    address: z.string().optional(),
    isActive: z.boolean().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const org = await centralDb('central.organizations').where({ id: req.params.id }).first();
  if (!org) { notFound(res, 'Organization not found'); return; }

  const { name, industry, contactEmail, contactPhone, address, isActive } = parsed.data;
  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (name) updates.name = name;
  if (industry) updates.industry = industry;
  if (contactEmail) updates.contact_email = contactEmail;
  if (contactPhone) updates.contact_phone = contactPhone;
  if (address) updates.address = address;
  if (isActive !== undefined) updates.is_active = isActive;

  const [updated] = await centralDb('central.organizations').where({ id: req.params.id }).update(updates).returning('*');
  ok(res, updated, 'Organization updated');
});

/**
 * POST /api/super-admin/organizations/:id/admins
 * Add another admin to an org
 */
router.post('/:id/admins', async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(2),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().min(8).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Validation failed', parsed.error.flatten()); return; }

  const org = await centralDb('central.organizations').where({ id: req.params.id }).first();
  if (!org) { notFound(res, 'Organization not found'); return; }

  const emailExists = await centralDb('central.org_admins').where({ email: parsed.data.email }).first();
  if (emailExists) { badRequest(res, 'Email already in use'); return; }

  const tempPassword = parsed.data.password || generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  const [admin] = await centralDb('central.org_admins').insert({
    org_id: req.params.id,
    name: parsed.data.name,
    email: parsed.data.email,
    phone: parsed.data.phone,
    password_hash: passwordHash,
    created_by: req.user!.sub,
  }).returning('id', 'name', 'email', 'phone', 'is_active', 'created_at');

  created(res, { ...admin, tempPassword: parsed.data.password ? undefined : tempPassword });
});

/**
 * PUT /api/super-admin/organizations/:orgId/admins/:adminId/password
 */
router.put('/:orgId/admins/:adminId/password', async (req: Request, res: Response) => {
  const schema = z.object({ newPassword: z.string().min(8) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Password must be at least 8 characters'); return; }

  const admin = await centralDb('central.org_admins')
    .where({ id: req.params.adminId, org_id: req.params.orgId })
    .first();

  if (!admin) { notFound(res, 'Admin not found'); return; }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  await centralDb('central.org_admins')
    .where({ id: req.params.adminId })
    .update({ password_hash: passwordHash, updated_at: new Date() });

  ok(res, null, 'Password updated');
});

export default router;
