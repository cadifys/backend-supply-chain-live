import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import organizationsRouter from './organizations.routes';

const router = Router();

// All super-admin routes require authentication and super_admin role
router.use(authenticate, requireRole('super_admin'));

router.use('/organizations', organizationsRouter);

export default router;
