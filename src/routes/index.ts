import { Router } from 'express';
import authRouter from './auth.routes';
import superAdminRouter from './super-admin/index';
import adminRouter from './admin/index';
import managerRouter from './manager/index';
import workerRouter from './worker/index';

const router = Router();

router.use('/auth', authRouter);
router.use('/super-admin', superAdminRouter);
router.use('/admin', adminRouter);
router.use('/manager', managerRouter);
router.use('/worker', workerRouter);

export default router;
