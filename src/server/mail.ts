import { Resend } from 'resend';

/**
 * Outbound email, in one place (IMPLEMENTATION.md §8: Resend, because
 * deliverability from a single origin IP is a losing battle).
 *
 * With `RESEND_API_KEY` unset, outside production, mail is not sent: it is
 * kept in an in-process outbox and printed to the server log, so sign-up and
 * institutional verification work in dev and in tests. In production a missing
 * key is an error, never a silent drop.
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

const outbox: Mail[] = [];

/** Mail "sent" without Resend, newest last. Dev and tests only. */
export function devOutbox(): readonly Mail[] {
  return outbox;
}

export function clearDevOutbox(): void {
  outbox.length = 0;
}

let client: Resend | undefined;

export async function sendMail(mail: Mail): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('RESEND_API_KEY is not set; refusing to drop mail in production');
    }
    outbox.push(mail);
    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
      console.info(`[mail:dev] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}`);
    }
    return;
  }

  const from = process.env.MAIL_FROM;
  if (!from) throw new Error('MAIL_FROM is not set');
  client ??= new Resend(key);
  const { error } = await client.emails.send({ from, to: mail.to, subject: mail.subject, text: mail.text });
  if (error) throw new Error(`resend: ${error.message}`);
}
