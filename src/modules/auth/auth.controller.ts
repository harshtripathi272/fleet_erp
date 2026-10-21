import type { Request } from 'express';
import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { clientIp } from '../../core/rateLimit/index.js';
import * as AuthService from './auth.service.js';

const client = (req: Request): AuthService.ClientInfo => ({ ip: clientIp(req), userAgent: req.get('user-agent') });
const auth = (req: Request) => req.auth!;

export const register = asyncHandler(async (req, res) => {
  ApiResponse.created(res, await AuthService.register(req.body, client(req)), 'Account created');
});
export const login = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await AuthService.login(req.body, client(req)), 'Signed in');
});
export const refresh = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await AuthService.refresh(req.body.refreshToken, client(req)), 'Session renewed');
});
export const logout = asyncHandler(async (req, res) => {
  await AuthService.logout(auth(req).sessionId);
  ApiResponse.noContent(res);
});
export const logoutAll = asyncHandler(async (req, res) => {
  await AuthService.logoutAll(auth(req).userId);
  ApiResponse.noContent(res);
});
export const me = asyncHandler(async (req, res) => {
  ApiResponse.success(res, { ...(await AuthService.me(auth(req).userId)), permissions: auth(req).permissions });
});
export const updateMe = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await AuthService.updateMe(auth(req).userId, req.body), 'Profile updated');
});
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
  ApiResponse.success(res, await AuthService.changePassword(auth(req).userId, currentPassword, newPassword, client(req)), 'Password changed; other sessions signed out');
});
export const forgotPassword = asyncHandler(async (req, res) => {
  const extra = await AuthService.forgotPassword(req.body.email);
  ApiResponse.success(res, extra, 'If an account exists for this e-mail, a reset link has been sent');
});
export const resetPassword = asyncHandler(async (req, res) => {
  await AuthService.resetPassword(req.body.token, req.body.password);
  ApiResponse.success(res, {}, 'Password updated. Sign in with the new password.');
});
export const sessions = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await AuthService.listSessions(auth(req).userId, auth(req).sessionId));
});
