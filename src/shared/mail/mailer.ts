import nodemailer from 'nodemailer';
import { env, isSmtpConfigured } from '../config/env.js';
import { logger } from '../observability/logger.js';

// Email is optional infrastructure: every flow that would send mail (today, just password reset)
// still completes and returns a real result without SMTP configured. What changes is delivery —
// without it, nothing is actually emailed, so the caller is told via `delivered: false` and the
// dev-only `devPreview` so the flow stays testable end to end.

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;
function getTransporter() {
  if (!isSmtpConfigured) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER!, pass: env.SMTP_PASSWORD! },
    });
  }
  return transporter;
}

export interface SendMailResult {
  delivered: boolean;
  /** Only populated outside production when SMTP is not configured, so the flow is testable without a
   *  real mail provider. Never set when delivery actually happened or in production. */
  devPreview?: { to: string; subject: string; text: string };
}

export async function sendMail(to: string, subject: string, text: string): Promise<SendMailResult> {
  const client = getTransporter();
  if (!client) {
    // LOUD on purpose: with no SMTP, password-reset emails are silently never delivered while
    // the API still answers { ok: true }. An operator reading the logs must not miss this.
    logger.warn('smtp not configured, email not delivered', { to, subject });
    if (env.isProd) return { delivered: false };
    logger.warn('smtp not configured, dev preview of undelivered email', { to, subject, text });
    return { delivered: false, devPreview: { to, subject, text } };
  }
  await client.sendMail({ from: env.SMTP_FROM, to, subject, text });
  return { delivered: true };
}
