import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as MessagingService from './messaging.service.js';

export const previewTemplate = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await MessagingService.previewTemplate((req.params as { id: string }).id, req.body));
});
