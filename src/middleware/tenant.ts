import { Request, Response, NextFunction } from 'express';
import { Knex } from 'knex';
import { getTenantDb } from '../db/tenant';
import { forbidden } from '../utils/response';

declare global {
  namespace Express {
    interface Request {
      tenantDb?: Knex;
      orgSchema?: string;
    }
  }
}

/**
 * Injects the tenant-scoped DB connection based on JWT payload.
 * Must be used after authenticate middleware.
 */
export function injectTenantDb(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.orgSchema) {
    forbidden(res, 'Not associated with any organization');
    return;
  }
  req.tenantDb = getTenantDb(req.user.orgSchema);
  req.orgSchema = req.user.orgSchema;
  next();
}
