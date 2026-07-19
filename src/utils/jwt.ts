import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';

export const signAccessToken = (userId: number): string =>
  jwt.sign({ sub: userId }, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpiresIn,
  } as SignOptions);

export const signRefreshToken = (userId: number): string =>
  jwt.sign({ sub: userId }, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpiresIn,
  } as SignOptions);

export const verifyAccessToken = (token: string): { sub: number } =>
  jwt.verify(token, env.jwt.accessSecret) as unknown as { sub: number };

export const verifyRefreshToken = (token: string): { sub: number } =>
  jwt.verify(token, env.jwt.refreshSecret) as unknown as { sub: number };
