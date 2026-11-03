import nodemailer from 'nodemailer';
import { env, isSmtpConfigured } from './env.js';

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
    console.warn(`[mailer] SMTP not configured — not sending "${subject}" to ${to}.`);
    console.warn('[mailer] Set SMTP_HOST, SMTP_USER and SMTP_PASSWORD in backend/.env to enable real delivery.');
    if (env.isProd) return { delivered: false };
    console.warn(`[mailer] Dev preview:\n${text}`);
    return { delivered: false, devPreview: { to, subject, text } };
  }
  await client.sendMail({ from: env.SMTP_FROM, to, subject, text });
  return { delivered: true };
}
