import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env';

/** Erreurs métier (throw new Error(...)) → statut HTTP correct. */
const BUSINESS_STATUS: Record<string, number> = {
  'Invalid credentials': 401,
  'Account not verified': 403,
  'Email already in use': 409,
  'Invalid code': 400,
  'Invalid or expired code': 400,
  'Invalid refresh token': 401,
  'Invalid or expired reset token': 400,
};

export const errorHandler = (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const message = first ? `${first.path.join('.')}: ${first.message}` : 'Validation error';
    res.status(400).json({ success: false, message });
    return;
  }

  const businessStatus = err.message ? BUSINESS_STATUS[err.message] : undefined;
  if (businessStatus) {
    res.status(businessStatus).json({ success: false, message: err.message });
    return;
  }

  const isDev = env.nodeEnv === 'development';
  console.error(err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    ...(isDev && { stack: err.stack }),
  });
};
