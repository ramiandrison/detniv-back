import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { sendError } from '../utils/response';

export interface AuthRequest extends Request {
  userId?: number;
}

export const authenticate = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  try {
    const payload = verifyAccessToken(authHeader.split(' ')[1]);
    req.userId = payload.sub;
    next();
  } catch {
    sendError(res, 'Invalid or expired token', 401);
  }
};
