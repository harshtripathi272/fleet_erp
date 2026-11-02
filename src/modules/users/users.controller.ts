import { ApiResponse } from '../../core/response/index.js';
import { contextOf } from '../../core/masters/controller.js';
import { getById } from '../../core/masters/service.js';
import type { Plain } from '../../core/masters/types.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as UsersService from './users.service.js';
import * as DriverAccess from './driverAccess.service.js';

export const createUser = asyncHandler(async (req, res) => {
  ApiResponse.created(res, await UsersService.createUser(req.body as Plain, contextOf(req, 'users')), 'User created');
});

export const revokeUserSessions = asyncHandler(async (req, res) => {
  const { id } = req.params as { id: string };
  await getById(UsersService.userDefinition, id);
  await UsersService.revokeSessions(id);
  ApiResponse.success(res, { revoked: true }, 'All sessions for this user were signed out');
});

export const unlockUser = asyncHandler(async (req, res) => {
  const { id } = req.params as { id: string };
  await getById(UsersService.userDefinition, id);
  await UsersService.unlockUser(id);
  ApiResponse.success(res, await getById(UsersService.userDefinition, id, contextOf(req, 'users')), 'User unlocked');
});

const driverIdOf = (req: { params: unknown }) => (req.params as { driverId: string }).driverId;
export const getDriverAccess = asyncHandler(async (req, res) => ApiResponse.success(res, await DriverAccess.getAccess(driverIdOf(req))));
export const setDriverAccess = asyncHandler(async (req, res) => ApiResponse.success(res, await DriverAccess.setAccess(driverIdOf(req), req.body, req.auth!.userId), 'Driver app access saved'));
export const removeDriverAccess = asyncHandler(async (req, res) => ApiResponse.success(res, await DriverAccess.removeAccess(driverIdOf(req), req.auth!.userId), 'Driver app access removed'));
