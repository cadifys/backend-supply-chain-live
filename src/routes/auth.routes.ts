import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { centralDb } from '../db/central';
import { getTenantDb } from '../db/tenant';
import { comparePassword, hashPassword } from '../utils/password';
import { signToken } from '../utils/jwt';
import { ok, badRequest, unauthorized } from '../utils/response';
import { authenticate } from '../middleware/auth';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * POST /api/auth/login
 * Unified login for all user types.
 * Checks super_admins first, then org_admins, then tenant users.
 */
router.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, 'Invalid input', parsed.error.flatten());
    return;
  }

  const { email, password } = parsed.data;

  // 1. Check super admin
  const superAdmin = await centralDb('central.super_admins')
    .where({ email, is_active: true })
    .first();

  if (superAdmin) {
    const valid = await comparePassword(password, superAdmin.password_hash);
    if (!valid) { unauthorized(res, 'Invalid credentials'); return; }

    const token = signToken({
      sub: superAdmin.id,
      email: superAdmin.email,
      name: superAdmin.name,
      role: 'super_admin',
    });
    ok(res, { token, user: { id: superAdmin.id, name: superAdmin.name, email: superAdmin.email, role: 'super_admin' } });
    return;
  }

  // 2. Check org admin
  const orgAdmin = await centralDb('central.org_admins as oa')
    .join('central.organizations as o', 'oa.org_id', 'o.id')
    .where({ 'oa.email': email, 'oa.is_active': true, 'o.is_active': true })
    .select('oa.*', 'o.slug as org_slug', 'o.id as org_id', 'o.name as org_name')
    .first();

  if (orgAdmin) {
    const valid = await comparePassword(password, orgAdmin.password_hash);
    if (!valid) { unauthorized(res, 'Invalid credentials'); return; }

    const orgSchema = `org_${orgAdmin.org_slug}`;
    const token = signToken({
      sub: orgAdmin.id,
      email: orgAdmin.email,
      name: orgAdmin.name,
      role: 'admin',
      orgId: orgAdmin.org_id,
      orgSchema,
    });
    ok(res, {
      token,
      user: { id: orgAdmin.id, name: orgAdmin.name, email: orgAdmin.email, role: 'admin', orgId: orgAdmin.org_id, orgName: orgAdmin.org_name },
    });
    return;
  }

  // 3. Check tenant users (manager, lead, worker)
  // We need to find which org this email belongs to - check all org admins to find org first
  // Strategy: query central org_admins to get org list, then check each tenant schema
  // For performance, we store the org_slug hint in the login request or do a central user index
  // Here we do a central lookup of all active orgs and check tenant DBs
  const orgs = await centralDb('central.organizations').where({ is_active: true }).select('id', 'slug');

  for (const org of orgs) {
    const orgSchema = `org_${org.slug}`;
    try {
      const tenantDb = getTenantDb(orgSchema);
      const user = await tenantDb('users')
        .where({ email, is_active: true })
        .first();

      if (user) {
        const valid = await comparePassword(password, user.password_hash);
        if (!valid) continue; // wrong password for this org, try next

        const token = signToken({
          sub: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          orgId: org.id,
          orgSchema,
        });
        ok(res, {
          token,
          user: { id: user.id, name: user.name, email: user.email, role: user.role, orgId: org.id },
        });
        return;
      }
    } catch {
      // Schema may not exist yet, skip
      continue;
    }
  }

  unauthorized(res, 'Invalid credentials');
});

/**
 * POST /api/auth/change-password
 * Authenticated user changes their own password
 */
router.post('/change-password', authenticate, async (req: Request, res: Response) => {
  const schema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res, 'Invalid input', parsed.error.flatten()); return; }

  const { currentPassword, newPassword } = parsed.data;
  const user = req.user!;

  let record: any;
  let table: string;
  let db: any;

  if (user.role === 'super_admin') {
    db = centralDb;
    table = 'central.super_admins';
  } else if (user.role === 'admin') {
    db = centralDb;
    table = 'central.org_admins';
  } else {
    db = getTenantDb(user.orgSchema!);
    table = 'users';
  }

  record = await db(table).where({ id: user.sub }).first();
  if (!record) { unauthorized(res, 'User not found'); return; }

  const valid = await comparePassword(currentPassword, record.password_hash);
  if (!valid) { badRequest(res, 'Current password is incorrect'); return; }

  const newHash = await hashPassword(newPassword);
  await db(table).where({ id: user.sub }).update({ password_hash: newHash, updated_at: new Date() });

  ok(res, null, 'Password changed successfully');
});

/**
 * GET /api/auth/me
 */
router.get('/me', authenticate, (req: Request, res: Response) => {
  ok(res, req.user);
});

export default router;
