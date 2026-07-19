import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../../config/prisma';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../utils/jwt';
import { sendMail } from '../../utils/mailer';
import { env } from '../../config/env';

const RESET_TOKEN_TTL_MINUTES = 30;
const VERIFICATION_CODE_TTL_MINUTES = 15;

export const register = async (email: string, password: string, name?: string) => {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new Error('Email already in use');

  const hashed = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({ data: { email, password: hashed, name } });

  await sendVerificationCode(user.id, email);

  return { id: user.id, email: user.email, name: user.name };
};

export const verifyEmail = async (email: string, code: string) => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error('Invalid code');

  const record = await prisma.emailVerification.findFirst({
    where: { userId: user.id, code, used: false, expiresAt: { gt: new Date() } },
  });
  if (!record) throw new Error('Invalid or expired code');

  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { isActive: true } }),
    prisma.emailVerification.update({ where: { id: record.id }, data: { used: true } }),
  ]);
};

export const login = async (email: string, password: string) => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error('Invalid credentials');

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) throw new Error('Invalid credentials');
  if (!user.isActive) throw new Error('Account not verified');

  const tokens = issueTokens(user.id);
  return { ...tokens, user: { id: user.id, email: user.email, name: user.name } };
};

export const refresh = async (token: string) => {
  let payload: { sub: number };
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw new Error('Invalid refresh token');
  }
  return issueTokens(payload.sub);
};

export const forgotPassword = async (email: string) => {
  const user = await prisma.user.findUnique({ where: { email } });
  // Always resolve to avoid user enumeration
  if (!user) return;

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

  await prisma.passwordReset.create({ data: { token, userId: user.id, expiresAt } });

  const resetUrl = `${env.appUrl}/reset-password?token=${token}`;
  await sendMail(
    email,
    'Reset your password',
    `<p>Click <a href="${resetUrl}">here</a> to reset your password. Link expires in ${RESET_TOKEN_TTL_MINUTES} minutes.</p>`
  );
};

export const resetPassword = async (token: string, newPassword: string) => {
  const record = await prisma.passwordReset.findUnique({ where: { token } });

  if (!record || record.used || record.expiresAt < new Date()) {
    throw new Error('Invalid or expired reset token');
  }

  const hashed = await bcrypt.hash(newPassword, 12);

  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { password: hashed } }),
    prisma.passwordReset.update({ where: { token }, data: { used: true } }),
  ]);
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const sendVerificationCode = async (userId: number, email: string) => {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MINUTES * 60 * 1000);

  await prisma.emailVerification.create({ data: { code, userId, expiresAt } });

  await sendMail(
    email,
    'Verify your account',
    `<p>Your verification code is: <strong>${code}</strong>. It expires in ${VERIFICATION_CODE_TTL_MINUTES} minutes.</p>`
  );
};

const issueTokens = (userId: number) => ({
  accessToken: signAccessToken(userId),
  refreshToken: signRefreshToken(userId),
});
