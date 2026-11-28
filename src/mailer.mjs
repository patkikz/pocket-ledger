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

  return { sendPasswordResetEmail };
}
