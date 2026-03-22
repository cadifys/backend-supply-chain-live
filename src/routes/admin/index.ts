import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireMinRole } from '../../middleware/rbac';
import { injectTenantDb } from '../../middleware/tenant';
import usersRouter from './users.routes';
import stagesRouter from './stages.routes';
import machinesRouter from './machines.routes';
import lotsRouter from './lots.routes';
import reportsRouter from './reports.routes';

const router = Router();

// All admin routes: authenticated + at least manager role + tenant DB
router.use(authenticate, injectTenantDb);

// Users management - admin only
router.use('/users', requireMinRole('admin'), usersRouter);

// Stages & machines config - admin only
router.use('/stages', requireMinRole('admin'), stagesRouter);
router.use('/machines', requireMinRole('admin'), machinesRouter);

// Lots - admin + manager can view
router.use('/lots', requireMinRole('manager'), lotsRouter);

// Reports - admin + manager
router.use('/reports', requireMinRole('manager'), reportsRouter);

export default router;
