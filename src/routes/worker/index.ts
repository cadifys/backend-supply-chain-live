import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireMinRole } from '../../middleware/rbac';
import { injectTenantDb } from '../../middleware/tenant';
import transactionsRouter from './transactions.routes';
import transfersRouter from './transfers.routes';
import lotsRouter from './lots.routes';

const router = Router();

router.use(authenticate, requireMinRole('worker'), injectTenantDb);

router.use('/transactions', transactionsRouter);
router.use('/transfers', transfersRouter);
router.use('/lots', lotsRouter);

export default router;
