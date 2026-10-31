import { prisma } from './prisma.js';
import { env } from '../config/env.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  template: string;
}

export function emailConfigured(): boolean {
  if (!env.EMAIL_ENABLED) return false;
  if (env.EMAIL_PROVIDER === 'smtp') return Boolean(env.SMTP_HOST);
  if (env.EMAIL_PROVIDER === 'graph') {
    return Boolean(env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_CLIENT_SECRET && env.GRAPH_SENDER);
  }
  return false;
}

/**
 * Sends mail only when configured; otherwise records a SKIPPED log row.
 * Email is strictly optional: callers must never fail a clinic operation
 * because mail is unavailable.
 */
export async function sendMail(mail: OutgoingMail): Promise<{ sent: boolean; reason?: string }> {
  const log = await prisma.emailLog.create({
    data: {
      toAddress: mail.to,
      subject: mail.subject,
      template: mail.template,
      status: emailConfigured() ? 'PENDING' : 'SKIPPED',
      error: emailConfigured() ? null : 'Email is not configured',
    },
  });

  if (!emailConfigured()) {
    return { sent: false, reason: 'Email is not configured' };
  }

  try {
    if (env.EMAIL_PROVIDER === 'smtp') {
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      });
      await transporter.sendMail({
        from: env.MAIL_FROM,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    } else {
      await sendViaGraph(mail);
    }

    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: 'SENT', sentAt: new Date(), attempts: 1 },
    });
    return { sent: true };
  } catch (err) {
    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: 'FAILED', error: (err as Error).message.slice(0, 500), attempts: 1 },
    });
    return { sent: false, reason: 'Delivery failed' };
  }
}

async function sendViaGraph(mail: OutgoingMail): Promise<void> {
  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GRAPH_CLIENT_ID,
        client_secret: env.GRAPH_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    },
  );
  if (!tokenRes.ok) throw new Error(`Graph token failed (${tokenRes.status})`);
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) throw new Error('Graph token missing');

  const sendRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.GRAPH_SENDER)}/sendMail`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenJson.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject: mail.subject,
          body: { contentType: mail.html ? 'HTML' : 'Text', content: mail.html ?? mail.text },
          toRecipients: [{ emailAddress: { address: mail.to } }],
        },
        saveToSentItems: false,
      }),
    },
  );
  if (!sendRes.ok) throw new Error(`Graph send failed (${sendRes.status})`);
}
