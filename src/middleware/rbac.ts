import { Request, Response, NextFunction } from 'express';
import { UserRole } from '../utils/jwt';
import { forbidden } from '../utils/response';

// Role hierarchy: higher index = more access
const ROLE_HIERARCHY: UserRole[] = ['worker', 'lead', 'manager', 'admin', 'super_admin'];

/**
 * Allow only specific roles
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      forbidden(res, 'Authentication required');
      return;
    }
    if (!roles.includes(req.user.role)) {
      forbidden(res, `Requires role: ${roles.join(' or ')}`);
      return;
    }
    next();
  };
}

/**
 * Allow roles at or above the minimum level in hierarchy
 */
export function requireMinRole(minRole: UserRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      forbidden(res, 'Authentication required');
      return;
    }
    const userLevel = ROLE_HIERARCHY.indexOf(req.user.role);
    const minLevel = ROLE_HIERARCHY.indexOf(minRole);
    if (userLevel < minLevel) {
      forbidden(res, `Requires ${minRole} level or above`);
      return;
    }
    next();
  };
}
