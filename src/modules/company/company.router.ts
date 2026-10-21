import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as CompanyController from './company.controller.js';
import { saveCompanySchema } from './company.schema.js';

const router = Router();
router.get('/', authorize('company', 'read'), CompanyController.getCompany);
router.put('/', authorize('company', 'update'), validate({ body: saveCompanySchema }), CompanyController.saveCompany);
export default router;
