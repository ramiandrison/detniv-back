import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

export const errorHandler = (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
  const isDev = env.nodeEnv === 'development';
  console.error(err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    ...(isDev && { stack: err.stack }),
  });
};
