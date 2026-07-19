import nodemailer from 'nodemailer';
import { env } from '../config/env';

const getTransporter = () =>
  nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    auth: { user: env.mail.user, pass: env.mail.pass },
  });

export const sendMail = (to: string, subject: string, html: string) =>
  getTransporter().sendMail({ from: env.mail.from, to, subject, html });
