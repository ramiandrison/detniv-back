import { Request, Response, NextFunction } from 'express';
import * as authService from './auth.service';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from './auth.validators';
import { sendSuccess, sendError } from '../../utils/response';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export const registerHandler = wrap(async (req, res) => {
  const { email, password, name } = registerSchema.parse(req.body);
  const user = await authService.register(email, password, name);
  sendSuccess(res, user, 201);
});

export const loginHandler = wrap(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const tokens = await authService.login(email, password);
  sendSuccess(res, tokens);
});

export const refreshHandler = wrap(async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  const tokens = await authService.refresh(refreshToken);
  sendSuccess(res, tokens);
});

export const forgotPasswordHandler = wrap(async (req, res) => {
  const { email } = forgotPasswordSchema.parse(req.body);
  await authService.forgotPassword(email);
  sendSuccess(res, { message: 'If this email exists, a reset link has been sent.' });
});

export const resetPasswordHandler = wrap(async (req, res) => {
  const { token, password } = resetPasswordSchema.parse(req.body);
  await authService.resetPassword(token, password);
  sendSuccess(res, { message: 'Password updated successfully.' });
});
