import dotenv from 'dotenv';
dotenv.config();

const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env variable: ${key}`);
  return value;
};

export const env = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  },
  mail: {
    host: process.env.MAIL_HOST ?? '',
    port: parseInt(process.env.MAIL_PORT ?? '587', 10),
    user: process.env.MAIL_USER ?? '',
    pass: process.env.MAIL_PASS ?? '',
    from: process.env.MAIL_FROM ?? 'no-reply@example.com',
  },
  b2: {
    keyId: process.env.B2_KEY_ID ?? '',
    applicationKey: process.env.B2_APPLICATION_KEY ?? '',
    bucketId: process.env.B2_BUCKET_ID ?? '',
    bucketName: process.env.B2_BUCKET_NAME ?? '',
    publicUrl: (process.env.B2_PUBLIC_URL ?? '').replace(/\/+$/, ''),
  },
  appUrl: process.env.APP_URL ?? 'http://localhost:3000',
};
