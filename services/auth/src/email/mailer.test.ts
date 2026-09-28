import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nodemailerMock = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({ default: nodemailerMock }));

const { sendPasswordResetEmail } = await import('./mailer.js');

const message = { to: 'user@example.com', resetUrl: 'https://app.example.com/reset-password?token=abc' };

beforeEach(() => {
  nodemailerMock.sendMail.mockReset().mockResolvedValue({});
  nodemailerMock.createTransport.mockClear();
  for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'SMTP_FROM']) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv('NODE_ENV', 'development');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('sendPasswordResetEmail', () => {
  it('logs the link instead of sending when SMTP is not configured (dev)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await sendPasswordResetEmail(message);
    expect(nodemailerMock.createTransport).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining(message.resetUrl));
  });

  it('throws in production when SMTP is not configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(sendPasswordResetEmail(message)).rejects.toThrow('SMTP_HOST is required');
  });

  it('sends a text and HTML email through SMTP with STARTTLS on 587 by default', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('SMTP_USER', 'mailer');
    vi.stubEnv('SMTP_PASS', 'pw');
    vi.stubEnv('SMTP_FROM', 'DocPost <noreply@example.com>');

    await sendPasswordResetEmail(message);

    expect(nodemailerMock.createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'mailer', pass: 'pw' },
    });
    const mail = nodemailerMock.sendMail.mock.calls[0][0];
    expect(mail).toMatchObject({
      from: 'DocPost <noreply@example.com>',
      to: message.to,
      subject: 'Reset your DocPost password',
    });
    expect(mail.text).toContain(message.resetUrl);
    expect(mail.text).toContain('expires in 1 hour');
    expect(mail.html).toContain(`href="${message.resetUrl}"`);
  });

  it('uses implicit TLS on port 465 and no auth without a user', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('SMTP_PORT', '465');

    await sendPasswordResetEmail(message);

    expect(nodemailerMock.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true, auth: undefined }),
    );
    expect(nodemailerMock.sendMail.mock.calls[0][0].from).toBe('DocPost <noreply@localhost>');
  });

  it('honours SMTP_SECURE=true on other ports', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('SMTP_PORT', '2525');
    vi.stubEnv('SMTP_SECURE', 'true');
    await sendPasswordResetEmail(message);
    expect(nodemailerMock.createTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 2525, secure: true }));
  });

  it('propagates SMTP send failures', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    nodemailerMock.sendMail.mockRejectedValue(new Error('550 rejected'));
    await expect(sendPasswordResetEmail(message)).rejects.toThrow('550 rejected');
  });
});
