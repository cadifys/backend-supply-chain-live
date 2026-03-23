import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireMinRole } from '../../middleware/rbac';
import { injectTenantDb } from '../../middleware/tenant';
import { ok } from '../../utils/response';
import transactionsRouter from './transactions.routes';
import transfersRouter from './transfers.routes';
import lotsRouter from './lots.routes';

const router = Router();

router.use(authenticate, requireMinRole('worker'), injectTenantDb);

router.use('/transactions', transactionsRouter);
router.use('/transfers', transfersRouter);
router.use('/lots', lotsRouter);

/** GET /api/worker/my-stages — stages assigned to this worker */
router.get('/my-stages', async (req: Request, res: Response) => {
  const stages = await req.tenantDb!('user_stage_assignments as usa')
    .join('stages as s', 'usa.stage_id', 's.id')
    .where({ 'usa.user_id': req.user!.sub, 's.is_active': true })
    .select('s.id', 's.name', 's.stage_order', 's.description')
    .orderBy('s.stage_order');
  ok(res, stages);
});

/** GET /api/worker/stages — all active stages (for transfer destination picker) */
router.get('/stages', async (req: Request, res: Response) => {
  const stages = await req.tenantDb!('stages')
    .where({ is_active: true })
    .orderBy('stage_order')
    .select('id', 'name', 'stage_order');
  ok(res, stages);
});

/** GET /api/worker/machines?stageId=... — machines at a stage (for log-work picker) */
router.get('/machines', async (req: Request, res: Response) => {
  const { stageId } = req.query;
  let query = req.tenantDb!('machines').where({ is_active: true }).select('id', 'name', 'stage_id');
  if (stageId) query = query.where({ stage_id: stageId });
  ok(res, await query.orderBy('name'));
});

export default router;
