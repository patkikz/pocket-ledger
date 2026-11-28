function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Create an email sender backed by Resend's HTTP API, with a console fallback
 * when RESEND_API_KEY is not configured.
 */
export function createMailer({
  apiKey = process.env.RESEND_API_KEY || '',
  from = process.env.RESEND_FROM_EMAIL || 'PocketLedger <onboarding@resend.dev>',
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const trimmedKey = String(apiKey || '').trim();
  const trimmedFrom = String(from || '').trim();

  async function postResendEmail({ to, subject, text, html }) {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${trimmedKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: trimmedFrom,
        to: [to],
        subject,
        text,
        html,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Resend API error (${response.status}): ${errorBody || 'Unknown error'}`);
    }

    const data = await response.json().catch(() => ({}));
    return { delivered: true, mode: 'resend', id: data.id || null };
  }

  async function sendPasswordResetEmail({ to, resetUrl, expiresMinutes = 30 }) {
    if (!trimmedKey || !trimmedFrom) {
      logger.info(`[PocketLedger] Password reset link for ${to}: ${resetUrl}`);
      return { delivered: false, mode: 'console' };
    }

    const safeUrl = escapeHtml(resetUrl);
    const subject = 'Reset your PocketLedger password';
    const text = [
      'We received a request to reset your PocketLedger password.',
      '',
      `Reset your password using this link (valid for ${expiresMinutes} minutes):`,
      resetUrl,
      '',
      'If you did not request this, you can safely ignore this email.',
    ].join('\n');

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; color: #0f172a;">
        <h2 style="margin-bottom: 12px;">Reset your PocketLedger password</h2>
        <p style="line-height: 1.5;">We received a request to reset your password. This link expires in <strong>${expiresMinutes} minutes</strong> and can only be used once.</p>
        <p style="margin: 24px 0;">
          <a href="${safeUrl}" style="display: inline-block; background: #10b981; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 10px; font-weight: 600;">Reset Password</a>
        </p>
        <p style="font-size: 13px; color: #64748b; word-break: break-all;">Or copy and paste this link:<br>${safeUrl}</p>
        <p style="font-size: 13px; color: #64748b;">If you did not request this, you can safely ignore this email.</p>
      </div>
    `.trim();

    return postResendEmail({ to, subject, text, html });
  }

  async function sendEmailVerificationCode({ to, code, expiresMinutes = 15 }) {
    if (!trimmedKey || !trimmedFrom) {
      logger.info(`[PocketLedger] Email verification code for ${to}: ${code}`);
      return { delivered: false, mode: 'console' };
    }

    const safeCode = escapeHtml(code);
    const subject = 'Confirm your PocketLedger email';
    const text = [
      'Welcome to PocketLedger!',
      '',
      `Your 6-digit confirmation code is: ${code}`,
      `This code expires in ${expiresMinutes} minutes.`,
      '',
      'If you did not create an account, you can safely ignore this email.',
    ].join('\n');

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; color: #0f172a;">
        <h2 style="margin-bottom: 12px;">Confirm your PocketLedger email</h2>
        <p style="line-height: 1.5;">Enter this 6-digit code in PocketLedger to activate your account. It expires in <strong>${expiresMinutes} minutes</strong>.</p>
        <div style="margin: 24px 0; padding: 16px; background: #f1f5f9; border-radius: 12px; text-align: center; font-size: 30px; font-weight: 700; letter-spacing: 0.35em; color: #0f172a;">${safeCode}</div>
        <p style="font-size: 13px; color: #64748b;">If you did not create an account, you can safely ignore this email.</p>
      </div>
    `.trim();

    return postResendEmail({ to, subject, text, html });
  }

  return { sendPasswordResetEmail, sendEmailVerificationCode };
}
