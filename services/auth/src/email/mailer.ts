import nodemailer from 'nodemailer';

export interface PasswordResetEmail {
  to: string;
  resetUrl: string;
}

const RESET_SUBJECT = 'Reset your DocPost password';

function resetText({ resetUrl }: PasswordResetEmail): string {
  return [
    'We received a request to reset the password for your DocPost account.',
    '',
    `Reset your password: ${resetUrl}`,
    '',
    'This link expires in 1 hour. If you did not request a reset, you can ignore this email.',
  ].join('\n');
}

function resetHtml({ resetUrl }: PasswordResetEmail): string {
  return [
    '<p>We received a request to reset the password for your DocPost account.</p>',
    `<p><a href="${resetUrl}">Reset your password</a></p>`,
    '<p>This link expires in 1 hour. If you did not request a reset, you can ignore this email.</p>',
  ].join('');
}

function createTransport() {
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: user ? { user, pass } : undefined,
  });
}

export async function sendPasswordResetEmail(message: PasswordResetEmail): Promise<void> {
  const from = process.env.SMTP_FROM ?? 'DocPost <noreply@localhost>';

  if (!process.env.SMTP_HOST) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP_HOST is required to send password reset emails');
    }
    console.info(`[email] Password reset for ${message.to}\n${message.resetUrl}`);
    return;
  }

  const transport = createTransport();
  await transport.sendMail({
    from,
    to: message.to,
    subject: RESET_SUBJECT,
    text: resetText(message),
    html: resetHtml(message),
  });
}
