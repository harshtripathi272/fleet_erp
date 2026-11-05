import type { Request } from 'express';
import { ApiResponse, buildPaginationMeta } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { channelStatus } from './connections.service.js';
import * as Dispatcher from './dispatcher.js';
import * as MessagingService from './messaging.service.js';

const id = (req: Request) => (req.params as { id: string }).id;

export const previewTemplate = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await MessagingService.previewTemplate((req.params as { id: string }).id, req.body));
});

export const channels = asyncHandler(async (_req, res) => ApiResponse.success(res, await channelStatus()));
export const outbox = asyncHandler(async (req, res) => {
  const result = await Dispatcher.listOutbox(req.query as unknown as Dispatcher.OutboxQuery);
  ApiResponse.paginated(res, result.data, buildPaginationMeta(result.total, result.page, result.limit));
});
export const outboxMessage = asyncHandler(async (req, res) => ApiResponse.success(res, await Dispatcher.getOutboxMessage(id(req))));
export const resend = asyncHandler(async (req, res) => ApiResponse.created(res, await Dispatcher.resend(id(req), req.auth?.userId), 'Sent again'));
